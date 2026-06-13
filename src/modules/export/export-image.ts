// Export pipeline: render each photo through the same WebGL develop pipeline
// used by the Develop view, then encode the canvas to an image Blob and trigger
// a download. Because output goes through a canvas, the result carries no EXIF
// or location metadata — fitting for a privacy-first tool.

import type { CatalogPhoto } from "@/catalog/types";
import { loadPhotoImage } from "@/catalog/load-image";
import { loadSavedParams } from "@/catalog/edit-params";
import { WebGLRenderer } from "@/rendering/webgl/renderer";
import { ZipWriter } from "./zip";

export type ExportFormat = "image/jpeg" | "image/png" | "image/webp";

export type DeliveryMode = "zip" | "files" | "folder";

export interface ExportSettings {
  format: ExportFormat;
  quality: number; // 0..1, used by JPEG/WebP (ignored for PNG)
  longEdge: number | null; // null = original (largest decodable) size
  /** @deprecated Use deliveryMode instead */
  bundle: boolean;
  delivery: DeliveryMode;
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
    return await canvasToBlob(canvas, settings.format, settings.quality);
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

  const delivery = settings.delivery ?? (settings.bundle ? "zip" : "files");
  const useZip = delivery === "zip" && photos.length > 1;
  const zip = useZip ? new ZipWriter() : null;
  const usedNames = new Set<string>();
  const failed: string[] = [];
  let exported = 0;

  try {
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      const blob = await renderOne(renderer, canvas, photo, settings);
      if (blob) {
        const name = uniqueName(exportFilename(photo, settings.format), usedNames);
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
