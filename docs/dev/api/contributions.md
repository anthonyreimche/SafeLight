# Contribution Types

← [API Reference](README.md)

Signatures for every `register*` contribution. `src/extensions/types.ts` is the source of truth. All contributions are auto-tagged with the calling extension's id and swept when it is disabled or uninstalled.

> The UI-mount contributions — **`PanelContribution`**, **`SlotContribution`**, and **`LayoutContribution`** — are documented in [UI Shell](ui-shell.md). **Theming** is covered in [UI Components](components.md#theming-tokens).

**Jump to:** [Theme](#themecontribution) · [SliderIcon](#slidericoncontribution) · [Pipeline](#pipelinecontribution--display-transform) · [ProcessingStage](#processingstagecontribution--gpu-stage) · [KeyAction](#keyactioncontribution) · [Settings](#settingscontribution) · [ExportProcessor](#exportprocessorcontribution) · [FilenameTemplate](#filenametemplatecontribution) · [LensProfile](#lensprofilecontribution) · [CatalogHooks](#cataloghookscontribution) · [PresetImporter](#presetimportercontribution) · [GridFilter](#gridfiltercontribution) · [LibrarySort](#librarysortcontribution) · [Cursor](#cursorcontribution)

## `ThemeContribution`

```typescript
interface ThemeContribution {
  id: string; name: string;
  colorScheme?: "light" | "dark";
  vars: Record<string, string>; // CSS custom properties applied to :root
}
```

The full themable surface is the set of `--color-*` variables documented in [UI Components → Theming tokens](components.md#theming-tokens).

## `SliderIconContribution`

```typescript
interface SliderIconContribution { id: string; svg: string; } // inline SVG, rendered 12×12
```

Keyed by the slider's `icon` id (e.g. `core.exposure`).

## `PipelineContribution` — display transform

```typescript
interface PipelineContribution {
  id: string; name: string; description?: string;
  glsl?: string;          // body defining: vec3 pipelineToDisplay(vec3 lin)
  skipBaseCurve?: boolean; // set when the transform brings its own contrast curve (AgX/ACES)
}
```

`glsl` maps scene-linear RGB (sRGB primaries, HDR — values may exceed 1.0) to display-encoded output. Helpers available: `luma()`, `srgbToLinear()`, `linearToSrgb()`, `linearToSrgbU()`. Transforms appear in **Preferences ▸ Rendering ▸ Display transform** and apply everywhere the pipeline renders (develop, loupe, thumbnails, export). This is the simplest way to ship a whole-image tone mapper.

## `ProcessingStageContribution` — GPU stage

```typescript
type ProcessingPhase =
  | "geometry" | "decode" | "noise-reduction" | "scene-linear"
  | "tone-map" | "display-adjust" | "effects" | "output-encode";

interface ProcessingStageContribution {
  id: string; name: string;
  phase: ProcessingPhase;     // order enforced by the shader compiler
  priority?: number;          // within phase, lower runs first (default 100)
  glsl: string;               // fragment operating on `vec3 color` (read/write)
  helpers?: string;           // helper functions (namespaced by the compiler)
  uniforms: UniformDeclaration[];
  passes?: StagePass[];       // pre-passes (ping-pong FBOs); result is `vec3 stageResult`
  produces?: InterStageVariable[];
  consumes?: string[];        // names of InterStageVariables this stage reads
  textures?: TextureRequirement[];
  mask?: { maskable: true; maskPhase: "linear" | "display" };
  after?: string[];           // soft dependencies on other stage ids
}
```

The stage model and shader compiler (`src/rendering/webgl/shader-compiler.ts`) decompose the develop shader into individually contributable GPU stages, and the path is **live**: all phases compile in, stages take custom uniforms (via the param bag, qualified as `{stageId}.{key}`), bind textures/LUTs (`api.setStageTexture`), and persist per-photo.

- **`phase: "geometry"`** is special — it runs first and operates on the mutable source-UV `vec2 srcUv` (after crop/transform/lens, *before* the image is sampled), so a geometry stage can warp/displace the coordinate and have the entire downstream pipeline follow. Every other phase operates on a color (`lin` or `c`).
- **`passes`** are full-screen pre-passes that ping-pong through framebuffers in source-UV space, enabling neighbourhood/iterative algorithms (à trous wavelets, NLM, separable blurs) a single inline fragment can't express. The final pass output is exposed to the stage's inline `glsl` as `vec3 stageResult`. See `StagePass` in `src/extensions/types.ts` for the per-pass contract (`uTexel`, `uPassIndex`, `uPassCount`, `readPrev(uv)`).
- Re-registering the same `id` replaces the stage (and its params); `unregisterProcessingStage(id)` removes one without disabling the whole extension. The shader recompiles on any such change.

Reach for a stage (over `registerPipeline`) when you need phase ordering, uniforms, multiple passes, or coordinate warping.

## `KeyActionContribution`

```typescript
interface KeyActionContribution {
  id: string; label: string;
  category?: "General" | "Develop" | "Library";
  defaultCombo: string;       // e.g. "Ctrl+Shift+I"; "" for unbound
  handler(): void;
}
```

The action appears in **Preferences ▸ Shortcuts** and is rebindable like any built-in. Read the current binding with `api.keybindings.getBinding(actionId)`. See [Subsystems → Keybindings](subsystems.md#keybindings) for combo format.

## `SettingsContribution`

```typescript
interface SettingsContribution {
  title?: string;             // section title (defaults to the extension name)
  fields: SettingsField[];    // auto-rendered, themed, searchable
  order?: number;
  component?: ComponentType;  // escape hatch for fully custom UI
}

type SettingsField =
  | { key; label; hint?; type: "boolean"; default: boolean }
  | { key; label; hint?; type: "number";  default: number; min?; max?; step? }
  | { key; label; hint?; type: "string";  default: string; placeholder? }
  | { key; label; hint?; type: "select";  default: string; options: { value; label }[] };
```

Declares the extension's section in **Preferences ▸ Extensions**. Values persist per-extension; read/write with `api.settings.get/set`, observe with `api.settings.onChange`.

## `ExportProcessorContribution`

```typescript
interface ExportProcessorContribution {
  id: string;     // globally unique, e.g. "my-ext.watermark"
  label: string;  // collapsible section header in the Export panel
  settings?: ExportProcessorField[]; // same shape as SettingsField
  process(blob: Blob, photo: CatalogPhoto, settings: Record<string, unknown>): Promise<Blob>;
}
```

Called once per exported image after the WebGL pipeline encodes it. Processors run in registration order, each receiving the previous step's Blob. Each declared field's `default` is merged with the user's current values before `process`. Processor errors are caught and logged and the unmodified Blob is forwarded, so a broken extension never silently drops an export.

## `FilenameTemplateContribution`

```typescript
interface FilenameTemplateContribution { id: string; label: string; template: string; }
```

Built-in variables resolved from `CatalogPhoto`: `{filename}` (base name without extension), `{ext}`, `{year}`, `{month}`, `{day}`, `{rating}`, `{camera}`, `{lens}`. Unknown variables are left as `{name}`.

## `LensProfileContribution`

```typescript
interface LensProfileContribution {
  id: string; lensMake: string; lensModel: string;
  priority?: number;          // > 0 checked before Lensfun; <= 0 is a fallback (default 0)
  resolve(exif: ExifData): ResolvedProfile | null; // interpolated distortion / TCA / vignetting
}
```

Supplements or overrides the built-in Lensfun-derived database in `src/lens-profiles/`. See that folder's `types.ts` for `ResolvedProfile`, `ResolvedDistortion` (`poly3`/`poly5`/`ptlens`), `ResolvedTca`, and `ResolvedVignetting`.

## `CatalogHooksContribution`

```typescript
interface CatalogHooksContribution {
  id: string;
  onPhotoImport?(ctx: { photo: CatalogPhoto; dir: FileSystemDirectoryHandle; fileName: string })
    : Promise<Partial<CatalogPhoto> | void>;        // merge sidecar metadata onto the record
  onMetadataChange?(ctx: { photos: CatalogPhoto[]; getEditState(id): Promise<EditState | null> })
    : Promise<void>;                                // rating/label/flag/keywords committed
  onEditCommit?(ctx: { photo: CatalogPhoto; editState: EditState }): Promise<void>;
  onPhotoRemove?(ctx: { photo: CatalogPhoto; dir: FileSystemDirectoryHandle; fileName: string })
    : Promise<void>;
}
```

Lets an extension own a side concern (e.g. XMP sidecars) without the core depending on it. All handlers are awaited; a throwing handler is logged and skipped so one extension can't break a save or import. From `onPhotoImport`, return a partial `CatalogPhoto` to merge onto the record; later handlers' fields win.

## `PresetImporterContribution`

```typescript
interface PresetImporterContribution {
  id: string; label: string;       // e.g. "Lightroom preset (.xmp)"
  extensions: string[];            // lowercase with dot, e.g. [".xmp"]
  parse(file: File): Promise<{ name: string; params: Partial<DevelopParams> } | null>;
}
```

Teaches the Presets panel's Import picker to read preset files from other apps.

## `GridFilterContribution`

```typescript
interface GridFilterContribution {
  id: string;
  test(photo: CatalogPhoto): boolean; // return false to hide from the grid (and culling nav)
  onClear?(): void;                   // invoked by Library "Clear filters"
}
```

Applied as an extra AND step in the Library's visible-photos derivation. Re-register with the same id to update the predicate as your query changes.

## `LibrarySortContribution`

```typescript
interface LibrarySortContribution {
  id: string; label: string;          // also the persisted sort id
  compare(a: CatalogPhoto, b: CatalogPhoto): number; // ascending; the toolbar toggle flips it
}
```

Adds an entry to the Library toolbar's sort dropdown.

## `CursorContribution`

```typescript
interface CursorContribution {
  id: string;                 // globally unique, e.g. "my-ext.measure"
  css?: string;               // a native CSS cursor value, e.g. "crosshair"
  image?: string;             // inline <svg…> markup or an image/data URL (≤ ~128×128)
  hotspotX?: number; hotspotY?: number;
  fallback?: string;          // keyword shown if the image can't load
}
```

A named cursor for the Develop canvas. Supply **either** `css` or `image`. Reference it by `id` from [`api.develop.setCanvasCursor`](stores.md#apidevelop). Inline SVG is encoded to a data URL (always CSP-allowed); an `image` URL is subject to the app CSP. Re-registering the same id replaces it.
