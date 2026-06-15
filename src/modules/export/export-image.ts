// Export pipeline: render each photo through the same WebGL develop pipeline
// used by the Develop view, then encode the canvas to an image Blob and trigger
// a download. Because output goes through a canvas, the result carries no EXIF
// or location metadata — fitting for a privacy-first tool.

import type { CatalogPhoto } from "@/catalog/types";
import { loadPhotoImage } from "@/catalog/load-image";
import { loadSavedParams } from "@/catalog/edit-params";
import { WebGLRenderer } from "@/rendering/webgl/renderer";
import { embedColorProfile, type ColorSpaceId } from "@/rendering/color-space";
import { useRegistry } from "@/extensions/registry";
import { ZipWriter } from "./zip";

export type ExportFormat = "image/jpeg" | "image/png" | "image/webp";

export type DeliveryMode = "zip" | "files" | "folder";

/** Per-processor settings map passed to exportPhotos from the Export panel. */
export type ProcessorSettings = Record<string, Record<string, unknown>>;

export interface ExportSettings {
  format: ExportFormat;
  quality: number; // 0..1, used by JPEG/WebP (ignored for PNG)
  longEdge: number | null; // null = original (largest decodable) size
  /** @deprecated Use deliveryMode instead */
  bundle: boolean;
  delivery: DeliveryMode;
  /** Output color space (pixel convert + embedded ICC). Defaults to sRGB. */
  colorSpace?: ColorSpaceId;
  /** Current values for each registered export processor, keyed by processor
   *  id. Missing keys fall back to the processor's declared field defaults. */
  processorSettings?: ProcessorSettings;
  /** Active filename template id (from a FilenameTemplateContribution), or
   *  undefined to use the built-in base-name + extension behaviour. */
  filenameTemplateId?: string;
}

const ARCHIVE_NAME = "safelight-export.zip";

export interface ExportProgress {
  done: number;
  total: number;
  filename: string;
}

export interface ExportResult {
  exported: number;
  failed: string[]; // filenames that could not be rendered
}

const EXTENSION: Record<ExportFormat, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: ExportFormat,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, format, quality));
}

// Output filename: original base name + the chosen format's extension.
export function exportFilename(
  photo: CatalogPhoto,
  format: ExportFormat,
): string {
  const base = photo.filename.replace(/\.[^./\\]+$/, "") || photo.filename;
  return `${base}.${EXTENSION[format]}`;
}

/** Resolve a filename template string, substituting built-in variables from
 *  the photo record. Unknown variables are left as-is. */
export function resolveFilenameTemplate(
  template: string,
  photo: CatalogPhoto,
  format: ExportFormat,
): string {
  const base = photo.filename.replace(/\.[^./\\]+$/, "") || photo.filename;
  const ext = EXTENSION[format];
  const exifDate = photo.exif.dateTimeOriginal ?? "";
  // EXIF dates are "YYYY:MM:DD HH:MM:SS" or ISO; grab the first 10 chars.
  const datePart = exifDate.replace(/:/g, "-").slice(0, 10);
  const [year = "", month = "", day = ""] = datePart.split("-");
  const vars: Record<string, string> = {
    filename: base,
    ext,
    year,
    month,
    day,
    rating: String(photo.rating),
    camera: photo.exif.cameraModel ?? "",
    lens: photo.exif.lens ?? "",
  };
  const result = template.replace(/{(\w+)}/g, (_, key: string) => vars[key] ?? `{${key}}`);
  // Ensure the resolved name always ends with the format extension.
  return result.endsWith(`.${ext}`) ? result : `${result}.${ext}`;
}

/** Run each registered export processor in registration order, chaining the
 *  output Blob of each step into the next. Errors in a processor are caught
 *  and logged; the unmodified input Blob is forwarded so a broken extension
 *  never silently drops the export. */
async function runProcessors(
  blob: Blob,
  photo: CatalogPhoto,
  processorSettings: ProcessorSettings,
): Promise<Blob> {
  const processors = Object.values(
    useRegistry.getState().exportProcessors,
  ).sort((a, b) => a.order - b.order);
  let current = blob;
  for (const proc of processors) {
    const defaults = Object.fromEntries(
      (proc.settings ?? []).map((f) => [f.key, f.default]),
    );
    const settings = { ...defaults, ...(processorSettings[proc.id] ?? {}) };
    try {
      current = await proc.process(current, photo, settings);
    } catch (err) {
      console.error(`[safelight] export processor "${proc.id}" threw:`, err);
    }
  }
  return current;
}

// Ensure a filename is unique within a batch by appending " (2)", " (3)", …
// before the extension. Prevents collisions inside a ZIP and silent overwrites
// when several files are downloaded to the same folder.
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = 2;
  while (used.has(`${base} (${n})${ext}`)) n++;
  const unique = `${base} (${n})${ext}`;
  used.add(unique);
  return unique;
}

// Trigger a browser download for a rendered blob.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke later so the browser has time to begin the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function renderOne(
  renderer: WebGLRenderer,
  canvas: HTMLCanvasElement,
  photo: CatalogPhoto,
  settings: ExportSettings,
  processorSettings: ProcessorSettings,
): Promise<Blob | null> {
  // Same decode as Develop/Loupe: full-res RAW float when available (gets the
  // base tone curve), else the 8-bit bitmap — so exports match what's on screen.
  const image = await loadPhotoImage(photo);
  if (!image) return null;
  const bitmap = image.kind === "bitmap" ? image.bitmap : null;
  try {
    const w = image.kind === "bitmap" ? image.bitmap.width : image.width;
    const h = image.kind === "bitmap" ? image.bitmap.height : image.height;
    const maxEdge = settings.longEdge ?? Math.max(w, h);
    const isFallback =
      image.kind === "float" ? (image.isFallbackPreview ?? false) : false;
    // Cached develop preview is linear-encoded RAW; it needs the base tone curve.
    const cachedRaw = image.kind === "bitmap" && (image.cached ?? false);
    renderer.setImage(
      image.kind === "bitmap" ? image.bitmap : image,
      maxEdge,
      isFallback,
      cachedRaw,
    );
    renderer.setParams(await loadSavedParams(photo.id));
    renderer.render();
    const blob = await canvasToBlob(canvas, settings.format, settings.quality);
    if (!blob) return null;
    const profiled = await embedColorProfile(blob, settings.colorSpace ?? "srgb");
    return runProcessors(profiled, photo, processorSettings);
  } finally {
    bitmap?.close();
  }
}

// Render each photo through the develop pipeline, then deliver the results. A
// single WebGL context is reused across the batch so we don't exhaust the
// browser's context limit; rendering is sequential.
export async function exportPhotos(
  photos: CatalogPhoto[],
  settings: ExportSettings,
  onProgress?: (p: ExportProgress) => void,
  destDir?: FileSystemDirectoryHandle,
): Promise<ExportResult> {
  const canvas = document.createElement("canvas");
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer(canvas);
  } catch {
    return { exported: 0, failed: photos.map((p) => p.filename) };
  }
  // Wider-gamut export: the renderer converts pixels and renderOne embeds the
  // matching ICC. Persists across the batch (one render context).
  renderer.setOutputColorSpace(settings.colorSpace ?? "srgb");

  const delivery = settings.delivery ?? (settings.bundle ? "zip" : "files");
  const useZip = delivery === "zip" && photos.length > 1;
  const zip = useZip ? new ZipWriter() : null;
  const usedNames = new Set<string>();
  const failed: string[] = [];
  let exported = 0;

  const procSettings = settings.processorSettings ?? {};
  // Resolve the active filename template once (if any) for the batch.
  const templateEntry = settings.filenameTemplateId
    ? useRegistry.getState().filenameTemplates[settings.filenameTemplateId]
    : undefined;

  try {
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      const blob = await renderOne(renderer, canvas, photo, settings, procSettings);
      if (blob) {
        const rawName = templateEntry
          ? resolveFilenameTemplate(templateEntry.template, photo, settings.format)
          : exportFilename(photo, settings.format);
        const name = uniqueName(rawName, usedNames);
        try {
          if (zip) {
            zip.add(name, new Uint8Array(await blob.arrayBuffer()));
          } else if (delivery === "folder" && destDir) {
            const fh = await destDir.getFileHandle(name, { create: true });
            const w = await fh.createWritable();
            await w.write(blob);
            await w.close();
          } else {
            downloadBlob(blob, name);
          }
          exported++;
        } catch {
          failed.push(photo.filename);
        }
      } else {
        failed.push(photo.filename);
      }
      onProgress?.({ done: i + 1, total: photos.length, filename: photo.filename });
    }
  } finally {
    renderer.dispose();
  }

  if (zip && exported > 0) {
    downloadBlob(zip.blob(), ARCHIVE_NAME);
  }

  return { exported, failed };
}
