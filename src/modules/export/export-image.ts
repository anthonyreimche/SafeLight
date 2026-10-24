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
import { quantise16, type Sharpen } from "@/rendering/webgl/export-draw";
import { getStageTextures } from "@/rendering/render-bridge";
import { getExtSetting } from "@/extensions/ext-settings";
import { resolveDefaultPipeline, resolvePipelineFor, setPhotoParams } from "@/extensions/pipelines";
import { useRegistry, type RegisteredExportProcessor } from "@/extensions/registry";
import type { ExportFrame, ExportProcessorContext, ExportProcessorContribution } from "@/extensions/types";
import { getSettings } from "@/state/settings-store";
import { showsEdit } from "@/state/fallback-rules";
import { buildExportIfds, embedExif, serializeExifTiff, type ExportIfds } from "./exif-write";
import { encodePng16 } from "./png16";
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
  /** Bits per sample for TIFF export. 16-bit falls back to 8-bit where the
   *  device can't render a 16-bit frame. Ignored for non-TIFF formats. */
  tiffBitDepth?: 8 | 16;
  /** Bits per sample for PNG export, 8 unless asked. 16-bit falls back to
   *  8-bit where the device can't render a 16-bit frame. Ignored for non-PNG
   *  formats. */
  pngBitDepth?: 8 | 16;
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
  /** Why some of them failed, worded for the user, where that is known. */
  failures?: { filename: string; reason: string }[];
  /** Count of photos whose 16-bit export fell back to 8-bit because the
   *  device can't render or read back a 16-bit frame. */
  degradedTo8Bit: number;
  /** Count of photos whose 16-bit export was drawn at reduced precision (half
   *  float) because the device can't render to a full-precision target.
   *  Version 3 only: versions 1 and 2 export through half float by design. */
  reducedPrecision: number;
  /** True when a requested ZIP overflowed the ZIP32 limits and the batch was
   *  delivered as individual files instead. */
  zipFellBack?: boolean;
}

/** The Export panel's line on a finished batch: how many photos it exported,
 *  and any that fell short of what was asked. */
export function exportStatus(result: ExportResult): string {
  let msg =
    result.failed.length === 0
      ? `Exported ${result.exported} photo${result.exported === 1 ? "" : "s"}.`
      : `Exported ${result.exported}; ${result.failed.length} could not be exported.`;
  if (result.degradedTo8Bit > 0) {
    msg += ` ${result.degradedTo8Bit} exported as 8-bit (device can't render 16-bit).`;
  }
  if (result.reducedPrecision > 0) {
    msg += ` ${result.reducedPrecision} exported at reduced 16-bit precision (device can't render full precision).`;
  }
  if (result.zipFellBack) {
    msg += " ZIP exceeded 4 GiB; delivered as individual files.";
  }
  return msg;
}

type BitDepthSettings = Pick<ExportSettings, "format" | "tiffBitDepth" | "pngBitDepth">;

// Only a TIFF or PNG whose own depth says so asks for 16 bits per sample.
function asks16Bit({ format, tiffBitDepth, pngBitDepth }: BitDepthSettings): boolean {
  return (format === "image/tiff" && tiffBitDepth === 16) || (format === "image/png" && pngBitDepth === 16);
}

/** True when an export writes ProPhoto at 8 bits, whose wide gamut spreads
 *  the codes thin enough to band a smooth gradient. */
export function proPhotoAt8Bit(settings: BitDepthSettings & Pick<ExportSettings, "colorSpace">): boolean {
  return settings.colorSpace === "prophoto-rgb" && !asks16Bit(settings);
}

/** What a headless render (api.export.renderPhotos) takes beyond the export
 *  settings. */
export interface RenderPhotosOptions {
  /** Merged over each photo's own extension-stage params for this render
   *  only, e.g. a stage's switch to render an auxiliary image (a gain map, a
   *  mask) at export size with the photo's exact geometry. */
  paramBag?: Record<string, unknown>;
}

const EXTENSION: Record<ExportFormat, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/tiff": "tif",
};

/** Image types an export processor may turn a file into, with the extension
 *  the delivered file takes. */
const PROCESSED_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/tiff": "tif",
  "image/avif": "avif",
  "image/jxl": "jxl",
  "image/heic": "heic",
};

/** The delivered file's extension: the format's, unless a processor changed
 *  the image to another known type (e.g. an HDR processor writing AVIF). */
export function exportExtension(format: ExportFormat, blobType: string): string {
  // Own keys only: "constructor" is as valid a Blob type as any.
  const processed = Object.hasOwn(PROCESSED_EXTENSION, blobType)
    ? PROCESSED_EXTENSION[blobType]
    : undefined;
  return processed && blobType !== format ? processed : EXTENSION[format];
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: ExportFormat,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, format, quality));
}

// ICC bytes for a file this module writes itself (TIFF, 16-bit PNG), or
// undefined for sRGB (the assumed default, and what the rest of the app treats
// as "no tag needed").
function exportIcc(colorSpace: ColorSpaceId): Uint8Array | undefined {
  return colorSpace === "srgb" ? undefined : buildIccProfile(colorSpace);
}

/** 8-bit codes, RGBA, top-down, encoded for the export space. */
interface Pixels8 {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

// The rendered canvas (already through optional sharpening) as bytes, read
// through a 2D context, since a WebGL canvas has no getImageData.
function readCanvas(source: HTMLCanvasElement): Pixels8 {
  const c = document.createElement("canvas");
  c.width = source.width;
  c.height = source.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(source, 0, 0);
  return { data: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
}

// A TIFF written from the codes, as canvas.toBlob can't write one.
function tiffBlob(
  { data, width, height }: Pixels8 | Pixels16,
  bitDepth: 8 | 16,
  colorSpace: ColorSpaceId,
  meta: ExportIfds | null,
): Blob {
  const bytes = encodeTiff(data, width, height, {
    bitDepth,
    icc: exportIcc(colorSpace),
    meta: meta ?? undefined,
  });
  return new Blob([bytes as BlobPart], { type: "image/tiff" });
}

// Bytes on a 2D canvas for canvas.toBlob. The canvas and the ImageData are
// both sRGB by default, so putImageData converts nothing.
function canvasOf({ data, width, height }: Pixels8): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  c.getContext("2d")!.putImageData(new ImageData(data, width, height), 0, 0);
  return c;
}

/** 16-bit codes, RGBA, top-down, encoded for the export space. */
type Pixels16 = Pick<ExportFrame, "data" | "width" | "height">;

/** A rendered 16-bit frame. */
interface Frame16Bit extends Pixels16 {
  /** Drawn in half float: a version 3 frame on a device with no
   *  full-precision target. */
  reduced: boolean;
}

// The photo's 16 bits from the source its version exports through. Version 3
// draws into a true 16-bit target where the device has one, sharpened there
// when asked; versions 1 and 2 quantise their RGBA16F capture as they always
// have, unsharpened. Null when the device can render neither.
function render16Bit(
  renderer: WebGLRenderer,
  signedOutput: boolean,
  sharpen: Sharpen | undefined,
): Frame16Bit | null {
  if (signedOutput) {
    const pixels = renderer.exportPixels({ sharpen });
    if (!pixels) return null;
    const { data, width, height, target } = pixels;
    return { data, width, height, reduced: target === "float16" };
  }
  const capture = renderer.captureFloatFrame();
  if (!capture) return null;
  const { width, height } = capture;
  const data = new Uint16Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = quantise16(capture.data[i]);
  return { data, width, height, reduced: false };
}

// 16-bit PNG: the encoder writes the iCCP itself, so the file skips
// embedColorProfile, whose pass would copy a file of ~100 MB at 24 MP once more.
async function encode16BitPng(
  frame: Pixels16,
  colorSpace: ColorSpaceId,
  meta: ExportIfds | null,
): Promise<Blob> {
  const png = await encodePng16(frame.data, frame.width, frame.height, { icc: exportIcc(colorSpace) });
  return meta ? embedExif(png, serializeExifTiff(meta)) : png;
}

// Characters Windows forbids in a file name. The folder handle rejects them
// on every platform, so one in an EXIF value would fail that photo's export.
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]+/g;

/** A name any platform's file system accepts: forbidden characters become a
 *  dash (a run becomes one), trailing dots and spaces go (Windows drops them
 *  silently), and an empty result is "untitled". */
export function safeFileName(name: string): string {
  const safe = name.replace(UNSAFE_NAME_CHARS, "-").replace(/[. ]+$/, "");
  return safe === "" ? "untitled" : safe;
}

// Output filename: original base name + the chosen format's extension (or the
// one a processor's image type gave it).
export function exportFilename(
  photo: CatalogPhoto,
  format: ExportFormat,
  ext: string = EXTENSION[format],
): string {
  const base = safeFileName(photoExportBase(photo));
  return `${base}.${ext}`;
}

/** Resolve a filename template string, substituting built-in variables from
 *  the photo record. Unknown variables are left as-is. */
export function resolveFilenameTemplate(
  template: string,
  photo: CatalogPhoto,
  format: ExportFormat,
  ext: string = EXTENSION[format],
): string {
  const base = photoExportBase(photo);
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
  // The name always ends with the format extension. Clean the base alone, so a
  // trailing dot or an empty base never sits next to the extension.
  const dotExt = `.${ext}`;
  const stem = result.endsWith(dotExt) ? result.slice(0, -dotExt.length) : result;
  return `${safeFileName(stem)}${dotExt}`;
}

// Processors run inside renderOne. One that renders its photo again through
// api.export.renderPhotos (an auxiliary image at export size) would otherwise
// run every processor again, itself included, without end, so a render of a
// photo whose processors are running skips them. It is keyed by photo, not one
// flag: the nested render is of the photo the processor was handed, while
// other batches (a gallery publish beside a user export) render other photos
// at the same time, awaiting processors of their own that must still run. A
// photo is in here at most once, as a second render of it skips the processors.
const photosInProcessors = new Set<string>();

/** What each of one photo's export processors is handed beside its input. */
interface ProcessorRun {
  photo: CatalogPhoto;
  processorSettings: ProcessorSettings;
  context: ExportProcessorContext;
}

type ProcessorMethod = "process" | "processPixels";

/** A registered processor that declares `M`. */
type Declaring<M extends ProcessorMethod> = RegisteredExportProcessor &
  Required<Pick<ExportProcessorContribution, M>>;

// The registered processors that declare `method`, in registration order, or
// none for a render of a photo whose processors are running.
function processorsWith<M extends ProcessorMethod>(method: M, photo: CatalogPhoto): Declaring<M>[] {
  if (photosInProcessors.has(photo.id)) return [];
  return Object.values(useRegistry.getState().exportProcessors)
    .filter((proc): proc is Declaring<M> => typeof proc[method] === "function")
    .sort((a, b) => a.order - b.order);
}

/** Run each processor on what the one before it returned, with its declared
 *  defaults under the user's values. Errors in a processor are caught and
 *  logged and its input is forwarded, so a broken extension never silently
 *  drops the export. */
async function chainProcessors<P extends RegisteredExportProcessor, T>(
  processors: P[],
  run: ProcessorRun,
  input: T,
  step: (proc: P, current: T, settings: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  // A render with nothing to run leaves the photo's mark alone: the render a
  // processor started would otherwise lift the mark of the one around it.
  if (processors.length === 0) return input;
  const { photo, processorSettings } = run;
  let current = input;
  photosInProcessors.add(photo.id);
  try {
    for (const proc of processors) {
      const defaults = Object.fromEntries(
        (proc.settings ?? []).map((f) => [f.key, f.default]),
      );
      const settings = { ...defaults, ...(processorSettings[proc.id] ?? {}) };
      try {
        current = await step(proc, current, settings);
      } catch (err) {
        console.error(`[safelight] export processor "${proc.id}" threw:`, err);
      }
    }
  } finally {
    photosInProcessors.delete(photo.id);
  }
  return current;
}

/** Run each registered processor's `process` on the encoded file in
 *  registration order, chaining the output Blob of each step into the next. */
function runProcessors(blob: Blob, run: ProcessorRun): Promise<Blob> {
  return chainProcessors(processorsWith("process", run.photo), run, blob, (proc, current, settings) =>
    proc.process(current, run.photo, settings, run.context),
  );
}

// Whether a hook's frame is one the encoders can take: 16-bit codes filling a
// whole, positive size. A plain-JS hook can hand back any array.
function encodable({ data, width, height }: ExportFrame): boolean {
  return (
    data instanceof Uint16Array &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    data.length === width * height * 4
  );
}

// A frame the encoders can't take, described for the log. A plain-JS hook can
// hand back anything, so this reads nothing off `data` that may not be there.
function describeFrame({ data, width, height }: Record<"data" | "width" | "height", unknown>): string {
  if (typeof data !== "object" || data === null) return `${width}×${height} with data ${String(data)}`;
  const values = "length" in data ? ` of ${data.length} values` : "";
  return `${width}×${height} with a ${data.constructor?.name ?? "prototype-less object"}${values}`;
}

// Run the pixel hooks on an export's frame. A hook's frame replaces the pixels
// and the size; the space, profile and depth stay the export's, as the file is
// written in them. A frame the encoders can't take is logged and the frame
// before it kept, as for a throw.
async function runPixelProcessors(
  processors: Declaring<"processPixels">[],
  { data, width, height }: Pixels16,
  colorSpace: ColorSpaceId,
  bitDepth: 8 | 16,
  run: ProcessorRun,
): Promise<Pixels16> {
  if (processors.length === 0) return { data, width, height };
  // A copy: the profile is cached for every later export, and a hook may write to it.
  const icc = exportIcc(colorSpace)?.slice() ?? null;
  const frame: ExportFrame = { data, width, height, colorSpace, icc, bitDepth };
  return chainProcessors(processors, run, frame, async (proc, current, settings) => {
    const out = await proc.processPixels(current, run.photo, settings, run.context);
    if (!out) return current;
    if (!encodable(out)) {
      console.error(
        `[safelight] export processor "${proc.id}" returned a frame the encoders can't take: ${describeFrame(out)}, where a whole, positive size needs a Uint16Array of width × height × 4; the frame before it is kept.`,
      );
      return current;
    }
    return { ...current, data: out.data, width: out.width, height: out.height };
  });
}

// An 8-bit export's drawn canvas through the pixel hooks: read back once,
// widened to 16-bit codes (× 257, which narrows back exactly), and narrowed to
// the bytes the encode takes. Null without a hook: the drawn canvas then goes
// to the encode as it always has, with no readback.
async function hookDrawn(
  source: HTMLCanvasElement,
  processors: Declaring<"processPixels">[],
  colorSpace: ColorSpaceId,
  run: ProcessorRun,
): Promise<Pixels8 | null> {
  if (processors.length === 0) return null;
  const drawn = readCanvas(source);
  const codes = new Uint16Array(drawn.data.length);
  for (let i = 0; i < codes.length; i++) codes[i] = drawn.data[i] * 257;
  const pixels = { data: codes, width: drawn.width, height: drawn.height };
  const { data, width, height } = await runPixelProcessors(processors, pixels, colorSpace, 8, run);
  const bytes = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = Math.round(data[i] / 257);
  return { data: bytes, width, height };
}

// Ensure a filename is unique within a batch by appending " (2)", " (3)", …
// before the extension. Prevents collisions inside a ZIP and silent overwrites
// when several files are downloaded to the same folder. Windows and macOS
// treat names that differ only in case as one file, so `used` holds lower-cased
// names and the returned name keeps its own casing.
export function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name.toLowerCase())) {
    used.add(name.toLowerCase());
    return name;
  }
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = 2;
  while (used.has(`${base} (${n})${ext}`.toLowerCase())) n++;
  const unique = `${base} (${n})${ext}`;
  used.add(unique.toLowerCase());
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
  /** The encoded image's size, which a pixel hook may have changed; 0 without a blob. */
  width: number;
  height: number;
  /** The 16-bit export fell back to 8-bit (device can't render or read back 16 bits). */
  degradedTo8Bit: boolean;
  /** The 16-bit export was drawn in half float (device can't render full precision). */
  reducedPrecision: boolean;
  /** Why no blob was rendered, worded for the user, where that is known. */
  failure?: string;
}

// Source EXIF for re-embedding. A virtual copy shares its master's live file
// handle; a photo without one (or an unreadable file) harvests nothing, and
// the export carries catalog-held edits alone.
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
  bagPatch?: Record<string, unknown>,
): Promise<RenderOneResult> {
  // The saved crop determines how many source pixels the requested long edge
  // needs: exporting a half-width crop at 2048 px must render from a 4096 px
  // source. Read the edit before decoding; when the as-shot temperature is
  // still unknown (never-decoded photo) the decode backfills it and the edit
  // is re-read below so default WB resolves correctly.
  const knownTemp = photo.exif.colorTemperature;
  // The request, not the delivered size: a crop makes the file smaller than
  // the long edge asked for, and a processor that renders the photo again
  // needs the request to land on the same pixel grid.
  const run: ProcessorRun = {
    photo,
    processorSettings,
    context: { longEdge: settings.longEdge ?? null },
  };
  let saved = await loadSavedEdit(photo.id, knownTemp);
  const crop = saved.params.crop;
  // Source aspect is unknown before decoding, so this estimate uses the
  // smaller crop fraction — it can over-ask (costing a decode where the cache
  // would have sufficed) but never under-asks. Exact math follows the decode.
  const cropFracLow = Math.max(Math.min(crop.width, crop.height), 0.01);
  const minEdge =
    settings.longEdge == null ? Infinity : Math.ceil(settings.longEdge / cropFracLow);

  // Same decode as Develop: full-res RAW float when available (gets the
  // base tone curve), else the 8-bit bitmap — so exports match what's on screen.
  const image = await loadPhotoImage(photo, { minEdge });
  if (!image) return { blob: null, width: 0, height: 0, degradedTo8Bit: false, reducedPrecision: false };
  // The stored preview, rendered with the edit, stands in for an original out of
  // reach: the edit rendered over it would apply twice.
  if (image.kind === "bitmap" && showsEdit(image)) {
    image.bitmap.close();
    const failure = image.fallback?.offline
      ? "The original isn't available."
      : "The original can't be read.";
    return { blob: null, width: 0, height: 0, degradedTo8Bit: false, reducedPrecision: false, failure };
  }
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
    // the native size and the GPU's texture limit). Bitmap/float16 sources
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
    renderer.setContributedParams(bagPatch ? { ...saved.paramBag, ...bagPatch } : saved.paramBag);
    setPhotoParams(renderer, saved.params);
    const colorSpace = settings.colorSpace ?? "srgb";
    // Version 3 exports through the renderer's own draws. Whether a photo
    // renders as version 3 is the renderer's call, as its version cap can hold
    // an edit to an older version.
    const signedOutput = renderer.signedOutputFor(saved.params);
    const amount = settings.sharpenAmount ?? 0;
    const sharpen = amount > 0 ? { amount, radius: settings.sharpenRadius ?? 1 } : undefined;

    // Opt-in only: harvest the source file's EXIF once per photo — the canvas
    // render below strips every metadata segment, so the export re-embeds it,
    // layered with catalog-held edits (RAW caption/copyright/GPS edits never
    // reach the source bytes, so the harvest alone would drop them).
    const sourceExif = settings.includeMetadata ? await harvestPhotoExif(photo) : null;
    const exifFor = (exportW: number, exportH: number): ExportIfds | null =>
      settings.includeMetadata
        ? buildExportIfds(sourceExif, {
            width: exportW,
            height: exportH,
            srgb: colorSpace === "srgb",
            includeLocation: settings.includeLocation ?? false,
            edited: photo.exif,
          })
        : null;

    // 16-bit TIFF or PNG: read the develop pipeline's output at 16 bits so the
    // extra precision survives. Falls through to the 8-bit path when the
    // device can't render a 16-bit frame.
    let degradedTo8Bit = false;
    if (asks16Bit(settings)) {
      const rendered = render16Bit(renderer, signedOutput, sharpen);
      if (rendered) {
        const pixelProcessors = processorsWith("processPixels", photo);
        const frame = await runPixelProcessors(pixelProcessors, rendered, colorSpace, 16, run);
        const meta = exifFor(frame.width, frame.height);
        const file =
          settings.format === "image/tiff"
            ? tiffBlob(frame, 16, colorSpace, meta)
            : await encode16BitPng(frame, colorSpace, meta);
        const blob = await runProcessors(file, run);
        return { blob, width: frame.width, height: frame.height, degradedTo8Bit: false, reducedPrecision: rendered.reduced };
      }
      degradedTo8Bit = true;
      console.warn(
        `[safelight] 16-bit ${settings.format.split("/")[1].toUpperCase()} export requested but this device can't render or read back the frame at 16 bits; "${photo.filename}" exported as 8-bit.`,
      );
    }

    // Version 3 sharpens the signed colour ahead of the output stage where the
    // device has a float target for it, so overshoot is mapped, not clipped;
    // otherwise the canvas is sharpened at 8 bits. renderSharpened draws
    // nothing when it can't, so the frame is drawn then.
    const sharpenedOnGpu = signedOutput && sharpen !== undefined && renderer.renderSharpened(sharpen);
    if (!sharpenedOnGpu) renderer.render();
    const drawn = sharpen && !sharpenedOnGpu
      ? applyOutputSharpening(canvas, sharpen.amount, sharpen.radius)
      : canvas;
    const hooked = await hookDrawn(drawn, processorsWith("processPixels", photo), colorSpace, run);
    const { width, height } = hooked ?? drawn;
    const exifIfds = exifFor(width, height);
    if (settings.format === "image/tiff") {
      const tiff = tiffBlob(hooked ?? readCanvas(drawn), 8, colorSpace, exifIfds);
      const blob = await runProcessors(tiff, run);
      return { blob, width, height, degradedTo8Bit, reducedPrecision: false };
    }
    const raw = await canvasToBlob(hooked ? canvasOf(hooked) : drawn, settings.format, settings.quality);
    if (!raw) return { blob: null, width: 0, height: 0, degradedTo8Bit, reducedPrecision: false };
    const profiled = await embedColorProfile(raw, colorSpace);
    const tagged = exifIfds ? await embedExif(profiled, serializeExifTiff(exifIfds)) : profiled;
    const blob = await runProcessors(tagged, run);
    return { blob, width, height, degradedTo8Bit, reducedPrecision: false };
  } finally {
    bitmap?.close();
  }
}

/** Create the WebGL renderer shared across a batch export/render. It bakes in
 *  the same things the live preview uses — the registered processing stages, the
 *  pipeline, the live stage-texture bag (film LUTs, spectral tables, …)
 *  and the output colour space — so rendered pixels match the develop view.
 *  Returns null when a WebGL context can't be created.
 *
 *  - Stages + pipeline: extension GPU stages (denoise, Spektrafilm) bake in,
 *    and renderOne swaps in each photo's own display transform (the default
 *    pipeline alone would, for stages like Spektrafilm, double-apply the base
 *    curve).
 *  - Stage textures: without them, stages that sample uploaded textures fall
 *    back to the renderer's 1×1 black dummy and render pure black.
 *  - Output colour space: the renderer converts pixels and renderOne embeds the
 *    matching ICC; set once, persists across the batch's single context.
 *  - First photo's program: a renderer builds its develop program on the first
 *    frame, so it is built here, with that photo's process version and display
 *    transform, ahead of any decode. A stock program the driver can't build fails
 *    the whole batch up front, like a context that can't be created, instead of
 *    decoding every photo only to fail each at its frame. Stages or a transform
 *    that can't be built are logged, and the photos that use them fail one by one,
 *    as they always did. A photo whose edit can't be read is left to fail on its
 *    own when it is rendered. */
async function makeBatchRenderer(
  settings: ExportSettings,
  first: CatalogPhoto | undefined,
): Promise<{ renderer: WebGLRenderer; canvas: HTMLCanvasElement } | null> {
  const canvas = document.createElement("canvas");
  let renderer: WebGLRenderer | null = null;
  try {
    renderer = new WebGLRenderer(canvas, {
      stages: Object.values(useRegistry.getState().processingStages),
      pipeline: resolveDefaultPipeline(),
    });
    const saved = first
      ? await loadSavedEdit(first.id, first.exif.colorTemperature).catch(() => null)
      : null;
    if (saved) {
      const { displayTransform, processVersion } = saved.params;
      renderer.setActivePipeline(resolvePipelineFor(displayTransform));
      try {
        renderer.prepareProgram(processVersion);
      } catch (err) {
        // Only a stock program that can't be built throws out of here.
        renderer.prepareStockProgram(processVersion);
        console.error(
          "[export] stages or display transform can't be built; photos that use them will fail:",
          err,
        );
      }
    }
    renderer.setStageTextures(getStageTextures());
    renderer.setOutputColorSpace(settings.colorSpace ?? "srgb");
  } catch (err) {
    console.error("[export] the renderer is unavailable:", err);
    renderer?.dispose();
    loseContext(canvas);
    return null;
  }
  return { renderer, canvas };
}

/** Free a canvas's WebGL context now rather than at garbage collection:
 *  Chromium keeps only so many contexts (about 16) and drops the oldest,
 *  which could be a running export's when a processor renders more. */
function loseContext(canvas: HTMLCanvasElement): void {
  const gl = canvas.getContext?.("webgl2") as WebGL2RenderingContext | null | undefined;
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
}

/** Dispose a batch's renderer and free its canvas's WebGL context. */
function releaseBatch(made: { renderer: WebGLRenderer; canvas: HTMLCanvasElement }): void {
  made.renderer.dispose();
  loseContext(made.canvas);
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
  /** The encoded image's pixel size, a pixel hook's mat included (0 when blob
   *  is null). A `process(blob)` that resizes the file can't report it: read
   *  that size from the blob. */
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
  options?: RenderPhotosOptions,
): Promise<RenderedPhoto[]> {
  const made = await makeBatchRenderer(settings, photos[0]);
  if (!made)
    return photos.map((photo) => ({ photo, blob: null, width: 0, height: 0 }));
  const { renderer, canvas } = made;
  const procSettings = settings.processorSettings ?? {};
  const out: RenderedPhoto[] = [];
  try {
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      let blob: Blob | null = null;
      let width = 0;
      let height = 0;
      try {
        ({ blob, width, height } = await renderOne(renderer, canvas, photo, settings, procSettings, options?.paramBag));
      } catch {
        blob = null;
      }
      out.push({
        photo,
        blob,
        width: blob ? width : 0,
        height: blob ? height : 0,
      });
      onProgress?.({ done: i + 1, total: photos.length, filename: photo.filename });
    }
  } finally {
    releaseBatch(made);
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
  const made = await makeBatchRenderer(settings, photos[0]);
  if (!made)
    return { exported: 0, failed: photos.map((p) => p.filename), degradedTo8Bit: 0, reducedPrecision: 0 };
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
  const failures: { filename: string; reason: string }[] = [];
  let exported = 0;
  let degradedTo8Bit = 0;
  let reducedPrecision = 0;

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
        if (r.reducedPrecision) reducedPrecision++;
        if (r.failure) failures.push({ filename: photo.filename, reason: r.failure });
      } catch {
        blob = null;
      }
      if (blob) {
        const ext = exportExtension(settings.format, blob.type);
        const rawName = templateEntry
          ? resolveFilenameTemplate(templateEntry.template, photo, settings.format, ext)
          : exportFilename(photo, settings.format, ext);
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
    releaseBatch(made);
  }

  if (zip && exported > 0) {
    downloadBlob(zip.blob(), ARCHIVE_NAME);
  }

  return {
    exported,
    failed,
    degradedTo8Bit,
    reducedPrecision,
    zipFellBack,
    ...(failures.length > 0 ? { failures } : {}),
  };
}
