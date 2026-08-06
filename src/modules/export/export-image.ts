// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Export pipeline: render each photo through the same WebGL develop pipeline
// used by the Develop view, then encode the canvas to an image Blob and trigger
// a download. A canvas render strips every metadata segment, so exports ship
// clean by default — privacy-first. When the user opts in (Preferences ▸
// Export, issue #93) the source file's EXIF is harvested and re-embedded; GPS
// location tags need a second opt-in on top of that.

import type { CatalogPhoto } from "@/catalog/types";
import { photoExportBase } from "@/catalog/copy-name";
import { loadPhotoImage } from "@/catalog/load-image";
import { loadSavedEdit } from "@/catalog/edit-params";
import { readExifEntries, type RawExifIfds } from "@/catalog/exif";
import { WebGLRenderer } from "@/rendering/webgl/renderer";
import { embedColorProfile, buildIccProfile, type ColorSpaceId } from "@/rendering/color-space";
import { getStageTextures } from "@/rendering/render-bridge";
import { getExtSetting } from "@/extensions/ext-settings";
import { resolveActivePipeline } from "@/extensions/pipelines";
import { useRegistry } from "@/extensions/registry";
import { getSettings } from "@/state/settings-store";
import { buildExportIfds, embedExif, serializeExifTiff, type ExportIfds } from "./exif-write";
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
  /** Carry the source photo's EXIF (camera, lens, exposure, capture date)
   *  into the exported file. Off unless enabled — exports ship clean of
   *  metadata by default. */
  includeMetadata?: boolean;
  /** Keep GPS location tags when metadata is included. Also off unless
   *  enabled. */
  includeLocation?: boolean;
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
  /** Count of photos whose 16-bit TIFF request fell back to 8-bit because the
   *  device can't render to a float target. */
  degradedTo8Bit: number;
  /** True when a requested ZIP overflowed the ZIP32 limits and the batch was
   *  delivered as individual files instead. */
  zipFellBack?: boolean;
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
  meta: ExportIfds | null,
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
    meta: meta ?? undefined,
  });
  return new Blob([bytes as BlobPart], { type: "image/tiff" });
}

// 16-bit TIFF: quantise the float capture (display-encoded [0,1]) to 16-bit
// unsigned samples. Output sharpening is a separate 8-bit canvas pass and is
// not applied here.
function encode16BitTiff(
  cap: { data: Float32Array; width: number; height: number },
  colorSpace: ColorSpaceId,
  meta: ExportIfds | null,
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
    meta: meta ?? undefined,
  });
  return new Blob([bytes as BlobPart], { type: "image/tiff" });
}

// Output filename: original base name + the chosen format's extension.
export function exportFilename(
  photo: CatalogPhoto,
  format: ExportFormat,
): string {
  const base = photoExportBase(photo);
  return `${base}.${EXTENSION[format]}`;
}

/** Resolve a filename template string, substituting built-in variables from
 *  the photo record. Unknown variables are left as-is. */
export function resolveFilenameTemplate(
  template: string,
  photo: CatalogPhoto,
  format: ExportFormat,
): string {
  const base = photoExportBase(photo);
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

interface RenderOneResult {
  blob: Blob | null;
  /** The 16-bit TIFF request fell back to 8-bit (device can't render float). */
  degradedTo8Bit: boolean;
}

// Source EXIF for re-embedding. A virtual copy shares its master's live file
// handle; a photo without one (or an unreadable file) simply exports untagged.
async function harvestPhotoExif(photo: CatalogPhoto): Promise<RawExifIfds | null> {
  if (!photo.fileHandle) return null;
  try {
    return await readExifEntries(await photo.fileHandle.getFile());
  } catch {
    return null;
  }
}

async function renderOne(
  renderer: WebGLRenderer,
  canvas: HTMLCanvasElement,
  photo: CatalogPhoto,
  settings: ExportSettings,
  processorSettings: ProcessorSettings,
): Promise<RenderOneResult> {
  // The saved crop determines how many source pixels the requested long edge
  // needs: exporting a half-width crop at 2048 px must render from a 4096 px
  // source. Read the edit before decoding; when the as-shot temperature is
  // still unknown (never-decoded photo) the decode backfills it and the edit
  // is re-read below so default WB resolves correctly.
  const knownTemp = photo.exif.colorTemperature;
  let saved = await loadSavedEdit(photo.id, knownTemp);
  const crop = saved.params.crop;
  // Source aspect is unknown before decoding, so this estimate uses the
  // smaller crop fraction — it can over-ask (costing a decode where the cache
  // would have sufficed) but never under-asks. Exact math follows the decode.
  const cropFracLow = Math.max(Math.min(crop.width, crop.height), 0.01);
  const minEdge =
    settings.longEdge == null ? Infinity : Math.ceil(settings.longEdge / cropFracLow);

  // Same decode as Develop/Loupe: full-res RAW float when available (gets the
  // base tone curve), else the 8-bit bitmap — so exports match what's on screen.
  const image = await loadPhotoImage(photo, { minEdge });
  if (!image) return { blob: null, degradedTo8Bit: false };
  const bitmap = image.kind === "bitmap" ? image.bitmap : null;
  try {
    const w = image.kind === "bitmap" ? image.bitmap.width : image.width;
    const h = image.kind === "bitmap" ? image.bitmap.height : image.height;
    // Long-edge fraction the crop keeps of this source, exactly as the
    // renderer's resize() computes it from the real decode dimensions.
    const cropFrac = Math.max(
      Math.max(w * crop.width, h * crop.height) / Math.max(w, h),
      0.01,
    );
    const requestEdge = settings.longEdge ?? Math.max(w, h);
    // Float sources are downsampled to maxEdge at upload, so a cropped export
    // must inflate the cap to keep enough pixels inside the crop (bounded by
    // the native size and the GPU's texture limit). Bitmap/srgb16 sources
    // upload at native size — for them maxEdge is purely the output cap, and
    // inflating it would overshoot the requested long edge.
    const maxEdge =
      image.kind === "float"
        ? Math.min(
            Math.ceil(requestEdge / cropFrac),
            Math.max(w, h),
            renderer.maxTextureEdge,
          )
        : requestEdge;
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
    if (knownTemp == null) {
      saved = await loadSavedEdit(photo.id, photo.exif.colorTemperature);
    }
    renderer.setContributedParams(saved.paramBag);
    renderer.setParams(saved.params);
    const colorSpace = settings.colorSpace ?? "srgb";

    // Opt-in only: harvest the source file's EXIF once per photo — the canvas
    // render below strips every metadata segment, so the export re-embeds it.
    const sourceExif = settings.includeMetadata ? await harvestPhotoExif(photo) : null;
    const exifFor = (exportW: number, exportH: number): ExportIfds | null =>
      sourceExif &&
      buildExportIfds(sourceExif, {
        width: exportW,
        height: exportH,
        srgb: colorSpace === "srgb",
        includeLocation: settings.includeLocation ?? false,
      });

    // 16-bit TIFF: read the develop pipeline's float output directly so the
    // extra precision survives. Falls through to the 8-bit path when the device
    // can't render to a float target.
    let degradedTo8Bit = false;
    if (settings.format === "image/tiff" && (settings.tiffBitDepth ?? 8) === 16) {
      const cap = renderer.captureFloatFrame();
      if (cap) {
        const tiff = encode16BitTiff(cap, colorSpace, exifFor(cap.width, cap.height));
        const blob = await runProcessors(tiff, photo, processorSettings);
        return { blob, degradedTo8Bit: false };
      }
      degradedTo8Bit = true;
      console.warn(
        `[safelight] 16-bit TIFF requested but this device can't render to a float target; "${photo.filename}" exported as 8-bit.`,
      );
    }

    renderer.render();
    const encodeCanvas = (settings.sharpenAmount ?? 0) > 0
      ? applyOutputSharpening(canvas, settings.sharpenAmount!, settings.sharpenRadius ?? 1)
      : canvas;
    const exifIfds = exifFor(encodeCanvas.width, encodeCanvas.height);
    if (settings.format === "image/tiff") {
      const tiff = encode8BitTiff(encodeCanvas, colorSpace, exifIfds);
      const blob = await runProcessors(tiff, photo, processorSettings);
      return { blob, degradedTo8Bit };
    }
    const raw = await canvasToBlob(encodeCanvas, settings.format, settings.quality);
    if (!raw) return { blob: null, degradedTo8Bit };
    const profiled = await embedColorProfile(raw, colorSpace);
    const tagged = exifIfds ? await embedExif(profiled, serializeExifTiff(exifIfds)) : profiled;
    const blob = await runProcessors(tagged, photo, processorSettings);
    return { blob, degradedTo8Bit };
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
    includeMetadata: s.exportIncludeMetadata,
    includeLocation: s.exportIncludeLocation,
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
        blob = (await renderOne(renderer, canvas, photo, settings, procSettings)).blob;
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
  if (!made)
    return { exported: 0, failed: photos.map((p) => p.filename), degradedTo8Bit: 0 };
  const { renderer, canvas } = made;

  const delivery = settings.delivery ?? (settings.bundle ? "zip" : "files");
  const useZip = delivery === "zip" && photos.length > 1;
  // Mutable so it can be dropped mid-batch when the archive overflows ZIP32 and
  // we fall back to per-file delivery.
  let zip = useZip ? new ZipWriter() : null;
  // Blobs already handed to the ZIP, kept so an overflow can re-deliver them as
  // individual downloads instead of shipping a corrupt partial archive.
  const zipBuffered: { name: string; blob: Blob }[] = [];
  let zipFellBack = false;
  const usedNames = new Set<string>();
  const failed: string[] = [];
  let exported = 0;
  let degradedTo8Bit = 0;

  const procSettings = settings.processorSettings ?? {};
  // Resolve the active filename template once (if any) for the batch.
  const templateEntry = settings.filenameTemplateId
    ? useRegistry.getState().filenameTemplates[settings.filenameTemplateId]
    : undefined;

  try {
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      let blob: Blob | null = null;
      try {
        const r = await renderOne(renderer, canvas, photo, settings, procSettings);
        blob = r.blob;
        if (r.degradedTo8Bit) degradedTo8Bit++;
      } catch {
        blob = null;
      }
      if (blob) {
        const rawName = templateEntry
          ? resolveFilenameTemplate(templateEntry.template, photo, settings.format)
          : exportFilename(photo, settings.format);
        const name = uniqueName(rawName, usedNames);
        try {
          if (zip) {
            try {
              zip.add(name, new Uint8Array(await blob.arrayBuffer()));
              zipBuffered.push({ name, blob });
            } catch (e) {
              if (!(e instanceof RangeError)) throw e;
              // Archive would exceed ZIP32 limits: deliver everything buffered so
              // far — plus this file and the rest of the batch — as individual
              // downloads rather than a truncated, unreadable ZIP.
              zip = null;
              zipFellBack = true;
              for (const b of zipBuffered) downloadBlob(b.blob, b.name);
              downloadBlob(blob, name);
            }
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

  return { exported, failed, degradedTo8Bit, zipFellBack };
}
