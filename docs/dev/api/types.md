# Core Data Types

← [API Reference](README.md)

The records extensions read and write. Defined in `src/catalog/types.ts`.

## CatalogPhoto

One photo in the catalog, as stored in `catalog.json`.

```typescript
interface CatalogPhoto {
  id: string;
  filename: string;
  relPath: string;           // project-relative path
  folder: string;            // project-relative folder, "" = root
  directoryHandle: FileSystemDirectoryHandle | null; // runtime-only, not saved
  fileHandle: FileSystemFileHandle | null;           // runtime-only, not saved
  thumbnailBlob: Blob | null;                         // runtime-only, not saved
  thumbnailUrl: string | null;                        // runtime-only, not saved
  width: number; height: number;
  fileSize: number; mimeType: string;
  rating: number;            // 0..5
  colorLabel: ColorLabel;    // "none" | "red" | "yellow" | ... | "purple"
  flag: FlagStatus;          // "none" | "pick" | "reject"
  rotation: number;          // 0 / 90 / 180 / 270 display rotation
  keywords: string[];
  dateCreated: number;
  dateImported: number;
  exif: ExifData;
  decodeError?: string;      // why no preview could be built
  previewEdit?: string;      // fingerprint of the edit the preview shows
  previewRotation?: number;  // rotation the preview was made at
  copyOf?: string;           // virtual copy: id of the master record
  copyName?: string;         // virtual copy: e.g. "copy 2"
}
```

`ExifData` holds camera and lens identity, exposure, authorship, `dateTimeOriginal`, `orientation`, the as-shot `colorTemperature` (Kelvin) and GPS (decimal degrees, altitude in metres). Every field is optional.

Notes:

- `previewEdit` and `previewRotation` describe the stored preview, not the photo. If you store a record with a new `thumbnailBlob`, set `previewEdit` to the edit that blob shows, or leave it unset for a preview made from the file.
- A **virtual copy** shares its master's file but has its own id, edits and metadata. `filename` mirrors the master's. The shown and exported name is `base_<copyName>.ext`. Copies of copies point at the root master.
- Create records, including virtual copies, with [`api.catalog.addPhotos`](stores.md#apicatalog).

## DevelopParams

The non-destructive recipe for the core adjustments. Sliders are −100..100 unless noted.

```typescript
interface DevelopParams {
  exposure;                                    // -5..5 EV
  contrast; highlights; shadows; whites; blacks;
  highlightDetail; shadowDetail;               // micro-contrast per tone band
  texture; clarity; dehaze; vibrance; saturation;
  temperature; tint;                           // Kelvin; -150..150
  sharpening; sharpenDetail; sharpenMasking;   // 0..100 each
  sharpenRadius;                               // 1..3
  luminanceNR; luminanceNRDetail; luminanceNRContrast;
  luminanceNRShadows; luminanceNRHighlights;
  colorNR; colorNRDetail; colorNRSmoothness;   // 0..100 each
  straighten;                                  // -45..45 degrees
  crop;                                        // x, y, width, height as 0..1
  transform; uprightMode; guidedLines;         // perspective and upright
  toneCurve; hsl; colorGrading;
  vignette; grain;
  masks;                                       // ≤ 16 masks, ≤ 24 components
  retouch;                                     // ≤ 32 spots, ≤ 4 brush-shaped
  displayTransform;                            // null = Preferences default
  processVersion;                              // read it, never write it
}
```

Notes:

- Extension adjustments are not here. They live in the **param bag** under `"{stageId}.{key}"`, saved with each history snapshot (see [EditState](#editstate)) and described by [`api.params`](stores.md#apiparams).
- A missing `processVersion` reads as 1. New edits get 2. Presets and pasted settings never change it. See [Process versions](contributions.md#process-versions).
- `normalizeParams` fills older or partial params (from imported presets, say) from the defaults, except `processVersion`.

## Masks and retouch

A `Mask` combines one or more components (`radial`, `linear`, `brush`, `lumRange`, `colorRange`) in list order, each with mode `add`, `subtract` or `intersect` and an optional invert.

```typescript
interface Mask {
  id: string; name: string;
  visible: boolean;            // false = muted but still listed
  invert: boolean;             // invert the combined coverage
  opacity: number;             // 0..100
  adj: MaskAdjustments;        // exposure, contrast, ..., sharpness
  panels: string[];            // active sub-panels, by panel id
  hsl?: HSLAdjustments;        // only while the HSL sub-panel is added
  toneCurve?: ToneCurves;      // only while Tone Curve is added
  bag?: Record<string, unknown>; // mask-scoped extension params
  components: MaskComponent[]; // at least one
}
```

A `BrushDab` is `{ x, y, radius, erase, feather, opacity?, flow? }` in source UV, with `radius` in image-height units. A `RetouchSpot` is a `"circle"` or `"brush"` spot in `"heal"` or `"clone"` mode, with destination and source positions in source UV.

Notes:

- `panels` lists [per-mask panels](ui-shell.md#per-mask-panels-panelcontributionmask). Unknown ids are kept, so a disabled extension's sub-panels return when it is re-enabled.
- A [maskable stage](contributions.md#processingstagecontribution--gpu-stage) with keys in `bag` runs again inside the mask with those values, on process version 2 or later.
- Brush mask components and extension [coverage textures](contributions.md#processingstagecontribution--gpu-stage) share one four-channel texture (`MAX_BRUSH_MASKS` = 4).
- The actions that build masks and spots are in [Brushes, masks & retouch](stores.md#brushes-masks--retouch-interactive-develop-tools).

## EditState

A photo's saved edit is its undo stack.

```typescript
interface EditState {
  photoId: string;
  stack: EditSnapshot[];
  currentIndex: number;        // the snapshot the photo shows now
}

interface EditSnapshot {
  timestamp: number;
  label: string;               // history entry name, e.g. "Brush mask"
  params: DevelopParams;
  paramBag?: Record<string, unknown>; // extension params by qualified key
}
```

Notes:

- `commitEdit(label)` in the develop store adds an entry only if the edit changed. A no-op commit adds nothing, keeps redo, and fires no `onEditCommit`.
- Read and write whole stacks with [`api.catalog.getEditState` / `putEditState`](stores.md#apicatalog). Writing the photo open in Develop reloads it there.
- Observe commits with a [catalog hook](contributions.md#cataloghookscontribution)'s `onEditCommit`.
