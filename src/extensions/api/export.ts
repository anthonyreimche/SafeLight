// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The settings, progress and results of api.export.

import type { CatalogPhoto } from "@/catalog/types";
import type { ColorSpaceId } from "@/rendering/color-space";

export type ExportFormat = "image/jpeg" | "image/png" | "image/webp" | "image/tiff";
export type DeliveryMode = "zip" | "files" | "folder";
/** Per-processor settings, keyed by export processor id. */
export type ProcessorSettings = Record<string, Record<string, unknown>>;

export interface ExportSettings {
  format: ExportFormat;
  /** 0..1, used by JPEG and WebP (ignored for PNG). */
  quality: number;
  /** null = original (largest decodable) size. */
  longEdge: number | null;
  /** @deprecated Use delivery instead */
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
   *  into the exported file. Off unless enabled. */
  includeMetadata?: boolean;
  /** Keep GPS location tags when metadata is included. Also off unless
   *  enabled. */
  includeLocation?: boolean;
}

export interface ExportProgress {
  done: number;
  total: number;
  filename: string;
}

export interface ExportResult {
  exported: number;
  /** Filenames that could not be rendered. */
  failed: string[];
  /** Why some of them failed, worded for the user, where that is known. */
  failures?: { filename: string; reason: string }[];
  /** Count of photos whose 16-bit export fell back to 8-bit because the
   *  device can't render or read back a 16-bit frame. */
  degradedTo8Bit: number;
  /** Count of photos whose 16-bit export was drawn at reduced precision (half
   *  float) because the device can't render to a full-precision target. */
  reducedPrecision: number;
  /** True when a requested ZIP overflowed the ZIP32 limits and the batch was
   *  delivered as individual files instead. */
  zipFellBack?: boolean;
  /** True when the caller's signal ended the batch before every photo was
   *  tried. `exported` counts what was done by then. */
  cancelled?: true;
  /** Why the batch ended early on a failure that every later write would meet
   *  too (a full disk, a read-only folder), worded for the user. */
  stopped?: string;
}

/** What a headless render (api.export.renderPhotos) takes beyond the export
 *  settings. */
export interface RenderPhotosOptions {
  /** Merged over each photo's own extension-stage params for this render
   *  only. */
  paramBag?: Record<string, unknown>;
  /** Stop before the next photo once this fires. The photos not reached are
   *  left out of the result. */
  signal?: AbortSignal;
}

/** What a batch export takes beyond the photos and settings. */
export interface ExportPhotosOptions {
  /** Stop before the next photo once this fires. The result says how many were
   *  exported and `cancelled`. A ZIP in progress is delivered with what it holds. */
  signal?: AbortSignal;
}

export interface RenderedPhoto {
  photo: CatalogPhoto;
  /** The rendered image, or null if the photo couldn't be decoded/rendered. */
  blob: Blob | null;
  /** The encoded image's pixel size (0 when blob is null). */
  width: number;
  height: number;
}

/** The settings proPhotoAt8Bit reads. */
export type BitDepthSettings = Pick<
  ExportSettings,
  "format" | "tiffBitDepth" | "pngBitDepth" | "colorSpace"
>;
