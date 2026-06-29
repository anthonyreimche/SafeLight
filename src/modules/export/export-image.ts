// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Export pipeline: render each photo through the same WebGL develop pipeline
// used by the Develop view, then encode the canvas to an image Blob and trigger
// a download. Because output goes through a canvas, the result carries no EXIF
// or location metadata — fitting for a privacy-first tool.

import type { CatalogPhoto } from "@/catalog/types";
import { loadPhotoImage } from "@/catalog/load-image";
import { loadSavedEdit } from "@/catalog/edit-params";
import { WebGLRenderer } from "@/rendering/webgl/renderer";
import { embedColorProfile, buildIccProfile, type ColorSpaceId } from "@/rendering/color-space";
import { getStageTextures } from "@/rendering/render-bridge";
import { getExtSetting } from "@/extensions/ext-settings";
import { resolveActivePipeline } from "@/extensions/pipelines";
import { useRegistry } from "@/extensions/registry";
import { getSettings } from "@/state/settings-store";
import { applyOutputSharpening } from "./sharpen";
import { encodeTiff } from "./tiff";
import { ZipWriter } from "./zip";

export type ExportFormat = "image/jpeg" | "image/png" | "image/webp" | "image/tiff";

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
  /** Output sharpening amount (0–150). 0 disables sharpening. */
  sharpenAmount?: number;
  /** Output sharpening radius in pixels (0.3–3.0). */
  sharpenRadius?: number;
  /** Bits per sample for TIFF export. 16-bit needs float render targets and
   *  falls back to 8-bit when unavailable. Ignored for non-TIFF formats. */
  tiffBitDepth?: 8 | 16;
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
  "image/tiff": "tif",
};

function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: ExportFormat,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, format, quality));
}

// ICC bytes to embed in a TIFF, or undefined for sRGB (the assumed default, and
// what the rest of the app treats as "no tag needed").
function tiffIcc(colorSpace: ColorSpaceId): Uint8Array | undefined {
  return colorSpace === "srgb" ? undefined : buildIccProfile(colorSpace);
}

// 8-bit TIFF: read the rendered canvas (already through optional sharpening) as
// top-down RGBA via a 2D context, since a WebGL canvas has no getImageData.
function encode8BitTiff(
  source: HTMLCanvasElement,
  colorSpace: ColorSpaceId,
): Blob {
  const c = document.createElement("canvas");
  c.width = source.width;
  c.height = source.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(source, 0, 0);
  const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
  const bytes = encodeTiff(rgba, c.width, c.height, {
    bitDepth: 8,
    icc: tiffIcc(colorSpace),
  });
  return new Blob([bytes as BlobPart], { type: "image/tiff" });
}

// 16-bit TIFF: quantise the float capture (display-encoded [0,1]) to 16-bit
// unsigned samples. Output sharpening is a separate 8-bit canvas pass and is
// not applied here.
function encode16BitTiff(
  cap: { data: Float32Array; width: number; height: number },
  colorSpace: ColorSpaceId,
): Blob {
  const { data, width, height } = cap;
  const u16 = new Uint16Array(width * height * 4);
  for (let i = 0; i < u16.length; i++) {
    const v = data[i];
    u16[i] = v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535);
  }
  const bytes = encodeTiff(u16, width, height, {
    bitDepth: 16,
    icc: tiffIcc(colorSpace),
  });
  return new Blob([bytes as BlobPart], { type: "image/tiff" });
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
    renderer.setAsShotTemperature(photo.exif.colorTemperature ?? 6500);
    // Match Develop's HSL band shaping so exports look like the edited view.
    renderer.setHslStyle(
      getExtSetting("core.hsl", "hueRange", 100) / 100,
      getExtSetting("core.hsl", "smoothness", 100) / 100,
    );
    renderer.setImage(
      image.kind === "bitmap" ? image.bitmap : image,
      maxEdge,
      isFallback,
      cachedRaw,
    );
    const saved = await loadSavedEdit(photo.id, photo.exif.colorTemperature);
    renderer.setContributedParams(saved.paramBag);
    renderer.setParams(saved.params);
    const colorSpace = settings.colorSpace ?? "srgb";

    // 16-bit TIFF: read the develop pipeline's float output directly so the
    // extra precision survives. Falls through to the 8-bit path when the device
    // can't render to a float target.
    if (settings.format === "image/tiff" && (settings.tiffBitDepth ?? 8) === 16) {
      const cap = renderer.captureFloatFrame();
      if (cap) {
        return runProcessors(encode16BitTiff(cap, colorSpace), photo, processorSettings);
      }
    }

    renderer.render();
    const encodeCanvas = (settings.sharpenAmount ?? 0) > 0
      ? applyOutputSharpening(canvas, settings.sharpenAmount!, settings.sharpenRadius ?? 1)
      : canvas;
    if (settings.format === "image/tiff") {
      return runProcessors(encode8BitTiff(encodeCanvas, colorSpace), photo, processorSettings);
    }
    const blob = await canvasToBlob(encodeCanvas, settings.format, settings.quality);
    if (!blob) return null;
    const profiled = await embedColorProfile(blob, colorSpace);
    return runProcessors(profiled, photo, processorSettings);
  } finally {
    bitmap?.close();
  }
}

/** Create the WebGL renderer shared across a batch export/render. It bakes in
 *  the same things the live preview uses — the registered processing stages, the
 *  active pipeline, the live stage-texture bag (film LUTs, spectral tables, …)
 *  and the output colour space — so rendered pixels match the develop view.
 *  Returns null when a WebGL context can't be created.
 *
 *  - Stages + active pipeline: extension GPU stages (denoise, Spektrafilm) bake
 *    in with the same display transform; the default pipeline alone would (for
 *    stages like Spektrafilm) double-apply the base curve.
 *  - Stage textures: without them, stages that sample uploaded textures fall
 *    back to the renderer's 1×1 black dummy and render pure black.
 *  - Output colour space: the renderer converts pixels and renderOne embeds the
 *    matching ICC; set once, persists across the batch's single context. */
function makeBatchRenderer(
  settings: ExportSettings,
): { renderer: WebGLRenderer; canvas: HTMLCanvasElement } | null {
  const canvas = document.createElement("canvas");
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer(canvas, {
      stages: Object.values(useRegistry.getState().processingStages),
      pipeline: resolveActivePipeline(),
    });
  } catch {
    return null;
  }
  renderer.setStageTextures(getStageTextures());
  renderer.setOutputColorSpace(settings.colorSpace ?? "srgb");
  return { renderer, canvas };
}

/** The persisted default export settings (Preferences ▸ Export) as a ready-to-
 *  use ExportSettings — quality normalised to 0..1. The Export panel seeds its
 *  per-session controls from the same values; this is the stable fallback for
 *  headless callers (e.g. a web-gallery extension via api.export). */
export function getDefaultExportSettings(): ExportSettings {
  const s = getSettings();
  return {
    format: s.exportFormat,
    quality: s.exportQuality / 100,
    longEdge: s.exportLongEdge,
    bundle: false,
    delivery: "files",
    colorSpace: s.exportColorSpace,
    tiffBitDepth: s.exportTiffBitDepth,
  };
}

export interface RenderedPhoto {
  photo: CatalogPhoto;
  /** The rendered image, or null if the photo couldn't be decoded/rendered. */
  blob: Blob | null;
  /** Rendered pixel dimensions (0 when blob is null). */
  width: number;
  height: number;
}

/** Render photos through the develop pipeline to in-memory blobs, reusing one
 *  WebGL context for the whole batch (same path as exportPhotos, minus the
 *  download/zip delivery). For callers that need the pixels rather than a file —
 *  e.g. publishing a full-resolution web gallery. A photo that can't be decoded
 *  yields a null blob in its slot rather than failing the batch. */
export async function renderPhotosToBlobs(
  photos: CatalogPhoto[],
  settings: ExportSettings,
  onProgress?: (p: ExportProgress) => void,
): Promise<RenderedPhoto[]> {
  const made = makeBatchRenderer(settings);
  if (!made)
    return photos.map((photo) => ({ photo, blob: null, width: 0, height: 0 }));
  const { renderer, canvas } = made;
  const procSettings = settings.processorSettings ?? {};
  const out: RenderedPhoto[] = [];
  try {
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      let blob: Blob | null = null;
      try {
        blob = await renderOne(renderer, canvas, photo, settings, procSettings);
      } catch {
        blob = null;
      }
      out.push({
        photo,
        blob,
        width: blob ? canvas.width : 0,
        height: blob ? canvas.height : 0,
      });
      onProgress?.({ done: i + 1, total: photos.length, filename: photo.filename });
    }
  } finally {
    renderer.dispose();
  }
  return out;
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
  const made = makeBatchRenderer(settings);
  if (!made) return { exported: 0, failed: photos.map((p) => p.filename) };
  const { renderer, canvas } = made;

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
