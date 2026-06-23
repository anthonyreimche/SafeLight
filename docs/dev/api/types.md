# Core Data Types

← [API Reference](README.md)

The records extensions read and write. Defined in `src/catalog/types.ts`.

## CatalogPhoto

```typescript
interface CatalogPhoto {
  id: string;
  filename: string;
  relPath: string;           // project-relative path
  folder: string;            // project-relative folder
  directoryHandle: FileSystemDirectoryHandle | null; // runtime-only
  fileHandle: FileSystemFileHandle | null;           // runtime-only
  thumbnailBlob: Blob | null;                         // runtime-only
  thumbnailUrl: string | null;                        // runtime-only
  width: number; height: number;
  fileSize: number; mimeType: string;
  rating: number;            // 0–5
  colorLabel: ColorLabel;    // "none" | "red" | "yellow" | "green" | "blue" | "purple"
  flag: FlagStatus;          // "none" | "pick" | "reject"
  rotation: number;          // 0 / 90 / 180 / 270 display rotation
  keywords: string[];
  dateCreated: number;
  dateImported: number;
  exif: ExifData;
}
```

Handles, blobs, and URLs are runtime-only — stripped before the record is written to `catalog.json`.

## DevelopParams

The complete non-destructive edit recipe. Slider ranges are −100..100 unless noted.

```typescript
interface DevelopParams {
  // Basic tone
  exposure;            // -5..5 EV
  contrast; highlights; shadows; whites; blacks;
  texture; clarity; dehaze; vibrance; saturation;
  // White balance
  temperature;         // Kelvin
  tint;                // -150..150
  // Detail — sharpening
  sharpening;          // 0..100 amount
  sharpenRadius;       // 1..3
  sharpenDetail;       // 0..100 halo suppression
  sharpenMasking;      // 0..100 edge masking
  // Detail — noise reduction
  luminanceNR; luminanceNRDetail; luminanceNRContrast;
  luminanceNRShadows; luminanceNRHighlights;
  colorNR; colorNRDetail; colorNRSmoothness;  // 0..100 each
  // Geometry
  straighten;          // -45..45 degrees
  crop;                // CropRect
  transform;           // perspectiveV/H, aspect, scale, offset, flips
  uprightMode;         // "off" | "auto" | "level" | "vertical" | "full" | "guided"
  guidedLines;         // GuidedLine[] for guided upright
  // Color
  toneCurve;           // ToneCurves: rgb + red/green/blue point curves
  hsl;                 // HSLAdjustments: 8 bands × hue/saturation/luminance
  colorGrading;        // shadows/midtones/highlights/global wheels
  // Optics & effects
  lensCorrection;      // mode, distortion, CA, defringe, vignetting
  vignette;            // amount, midpoint, roundness, feather, highlights
  grain;               // amount, size, roughness, color
  // Local
  masks;               // Mask[], ≤ MAX_MASKS (8); ≤ MAX_MASK_COMPONENTS (16) components total
  retouch;             // RetouchSpot[], ≤ MAX_RETOUCH (16); ≤ MAX_RETOUCH_BRUSH (4) brush-shaped
}
```

A `Mask` carries one or more **components** — `radial`, `linear`, `brush`, `lumRange`, or `colorRange` — each combined with mode `add` | `subtract` | `intersect`, plus opt-in per-mask sub-panels (`basic`, `wb`, `hsl`, `curve`, `detail`). Each `RetouchSpot` has a mode (`"heal"` | `"clone"`), position, source, radius, feather, and opacity. The interactive actions that build these live in [State Stores & Tools](stores.md#brushes-masks--retouch-interactive-develop-tools).

`normalizeParams` upgrades older/partial params (e.g. from imported presets) so they stay compatible.
