# Core Data Types

← [API Reference](README.md)

The records extensions read and write. Defined in `src/catalog/types.ts`.

## CatalogPhoto

```typescript
interface CatalogPhoto {
  id: string;
  filename: string;
  relPath: string;           // project-relative path
  folder: string;            // project-relative folder ("" = project root)
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
  decodeError?: string;      // why the last decode failed (grid warning tooltip); cleared once a preview builds
  copyOf?: string;           // on a virtual copy: the id of the master record that owns the file
  copyName?: string;         // on a virtual copy: its distinguisher, e.g. "copy 2"
}
```

Handles, blobs, and URLs are runtime-only — stripped before the record is written to `catalog.json`.

A **virtual copy** is a second record that shares another photo's source file but keeps its own id, edits and metadata. `filename` still mirrors the master's file; the displayed and exported name folds in `copyName` as `base_<copyName>.ext`. Copies of copies point at the root master. Create them with [`api.catalog.addPhotos`](stores.md#apicatalog).

`ExifData` carries camera and lens identity (`cameraMake`, `cameraModel`, `lens`, `lensMake`, serials), exposure (`focalLength`, `aperture`, `shutterSpeed`, `iso`, `exposureCompensation`, …), authorship (`artist`, `copyright`, `imageDescription`), `dateTimeOriginal`, `orientation`, the as-shot white balance `colorTemperature` (Kelvin), and location (`gpsLatitude`/`gpsLongitude` in decimal degrees, `gpsAltitude` in metres). Every field is optional.

## DevelopParams

The complete non-destructive edit recipe for core adjustments. Slider ranges are −100..100 unless noted.

```typescript
interface DevelopParams {
  // Basic tone
  exposure;            // -5..5 EV
  contrast; highlights; shadows; whites; blacks;
  highlightDetail;     // micro-contrast in the highlight band (+ crisper, - smoother)
  shadowDetail;        // micro-contrast in the shadow band
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
  crop;                // CropRect: x, y, width, height as 0..1 fractions
  transform;           // perspectiveV/H, aspect, scale, offsetX/Y, flipH/V
  uprightMode;         // "off" | "auto" | "level" | "vertical" | "full" | "guided"
  guidedLines;         // GuidedLine[] for guided upright
  // Color
  toneCurve;           // ToneCurves: rgb + red/green/blue point curves
  hsl;                 // HSLAdjustments: 8 bands × hue/saturation/luminance
  colorGrading;        // shadows/midtones/highlights/global wheels + ranges
  // Effects
  vignette;            // amount, midpoint, roundness, feather, highlights
  grain;               // amount, size, roughness, color
  // Local
  masks;               // Mask[], ≤ MAX_MASKS (16); ≤ MAX_MASK_COMPONENTS (24) components total
  retouch;             // RetouchSpot[], ≤ MAX_RETOUCH (32); ≤ MAX_RETOUCH_BRUSH (4) brush-shaped
  // Rendering
  displayTransform;    // display transform picked for this photo, or null to follow the Preferences default
}
```

Extension-contributed adjustments are not in `DevelopParams`: they live in a separate **param bag** keyed by qualified key (`"{stageId}.{key}"`), stored alongside the params in each history snapshot (see [EditState](#editstate)) and read through [`api.params`](stores.md#apiparams). Lens correction moved out of core into an [extension](contributions.md#processingstagecontribution--gpu-stage), so it has no field here either.

`normalizeParams` upgrades older/partial params (e.g. from imported presets) so they stay compatible.

## Masks and retouch

A `Mask` carries one or more **components** — `radial`, `linear`, `brush`, `lumRange`, or `colorRange` — each combined in list order with mode `add` | `subtract` | `intersect`, and each optionally inverted.

```typescript
interface Mask {
  id: string; name: string;
  visible: boolean;            // false = muted but still listed
  invert: boolean;             // invert the whole combined coverage
  opacity: number;             // 0..100 overall strength
  adj: MaskAdjustments;        // exposure, contrast, …, temperature, tint, texture, clarity, dehaze, sharpness
  panels: string[];            // active sub-panels, as registered panel ids ("core.basic", "my-ext.panel")
  hsl?: HSLAdjustments;        // present only while the HSL sub-panel is added
  toneCurve?: ToneCurves;      // present only while the Tone Curve sub-panel is added
  bag?: Record<string, unknown>; // mask-scoped extension params by qualified key
  components: MaskComponent[]; // at least one
}
```

`panels` lists [per-mask panels](ui-shell.md#per-mask-panels-panelcontributionmask) by id. Unknown ids are kept, so a disabled extension's sub-panels come back when it is re-enabled. The GPU does not read `bag` yet: extension stages still apply globally.

Brush coverage shares one four-channel texture (`MAX_BRUSH_MASKS` = 4) between brush mask components and extension [coverage textures](contributions.md#processingstagecontribution--gpu-stage). A `BrushDab` is `{ x, y, radius, erase, feather, opacity?, flow? }` in source-UV, with `radius` in image-height units.

Each `RetouchSpot` has a `shape` (`"circle"` | `"brush"`), a `mode` (`"heal"` | `"clone"`), destination and source positions in source-UV, radius, feather and opacity, plus optional auto-fit fields (`angle`, `scale`, `recolorR/G/B`) and `dabs` for brush-shaped spots. The interactive actions that build masks and spots live in [State Stores → Brushes, masks & retouch](stores.md#brushes-masks--retouch-interactive-develop-tools).

## EditState

A photo's saved edit is its undo stack:

```typescript
interface EditState {
  photoId: string;
  stack: EditSnapshot[];
  currentIndex: number;        // the snapshot the photo shows now
}

interface EditSnapshot {
  timestamp: number;
  label: string;               // the history entry's name, e.g. "Brush mask"
  params: DevelopParams;
  paramBag?: Record<string, unknown>; // extension stage params by qualified key
}
```

`commitEdit(label)` in the develop store pushes a snapshot. Read and write whole stacks with [`api.catalog.getEditState` / `putEditState`](stores.md#apicatalog), and observe commits with a [catalog hook](contributions.md#cataloghookscontribution)'s `onEditCommit`.
