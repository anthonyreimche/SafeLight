# Contribution Types

← [API Reference](README.md)

Signatures for every `register*` call except the UI-mount ones (modules, panels, header accessories, slots, layouts), which are in [UI Shell](ui-shell.md). `src/extensions/types.ts` is the source of truth. Every contribution is tagged with your extension's id and removed when it is disabled or uninstalled. Re-registering the same `id` replaces a contribution.

For where GPU code runs and what values it sees, read [How a photo is rendered](../rendering.md) first.

**Jump to:** [Theme](#themecontribution) · [SliderIcon](#slidericoncontribution) · [Pipeline](#pipelinecontribution--display-transform) · [ProcessingStage](#processingstagecontribution--gpu-stage) · [KeyAction](#keyactioncontribution) · [Settings](#settingscontribution) · [ExportProcessor](#exportprocessorcontribution) · [FilenameTemplate](#filenametemplatecontribution) · [CatalogHooks](#cataloghookscontribution) · [PresetImporter](#presetimportercontribution) · [GridFilter](#gridfiltercontribution) · [LibrarySort](#librarysortcontribution) · [GridMenuItem](#gridmenuitemcontribution) · [Cursor](#cursorcontribution) · [Stylesheet](#stylesheetcontribution)

## `ThemeContribution`

```typescript
interface ThemeContribution {
  id: string; name: string;
  colorScheme?: "light" | "dark";
  vars: Record<string, string>; // CSS custom properties applied to :root
}
```

The variables you can set are listed in [UI Components → Theming tokens](components.md#theming-tokens).

## `SliderIconContribution`

```typescript
interface SliderIconContribution { id: string; svg: string; } // inline SVG, drawn 12×12
```

`id` is the slider's `icon` id, such as `core.exposure`.

## `PipelineContribution` — display transform

A display transform turns scene-linear light into display values (step 6 in [the render order](../rendering.md#the-steps-in-order)). Users pick one per photo in Develop's bottom bar. **Preferences ▸ Rendering ▸ Default display transform** covers photos without a pick.

```typescript
interface PipelineContribution {
  id: string; name: string; description?: string;
  glsl?: string;              // defines vec3 pipelineToDisplay(vec3 lin)
  skipBaseCurve?: boolean;    // drop the RAW tone baseline
  skipToneShoulder?: boolean; // drop the core highlight shoulder
  params?: UniformDeclaration[]; // per-photo settings (3.1.0)
  helpers?: string;           // GLSL functions for glsl (3.1.0)
  derive?: {                  // uniforms computed from params (3.1.0)
    uniforms: UniformDeclaration[];
    fn(values: Record<string, unknown>): Record<string, UniformValue>;
  };
}
```

- **Input and output.** `lin` is scene-linear, Rec.709 primaries, and can be above 1 or below 0. Guard channels before `log`, `pow` or `sqrt`. Return sRGB-encoded values. Don't convert to the output colour space: the core does that once at the end.
- **The two flags.** `skipBaseCurve` drops the default RAW tone baseline, so your transform is the whole look. `skipToneShoulder` drops the core's highlight roll-off, so you get the full headroom and must bound your own output. Set both for untouched scene-linear input. `skipToneShoulder` only affects [process version](#process-versions) 2 photos.
- **Helpers.** `luma()`, `srgbToLinear()`, `linearToSrgb()` and `linearToSrgbU()` are always there. The `sl*` space helpers exist on version 2 photos only, so a transform that must also work on version 1 copies the maths under its own names (not starting with `sl` or `SL_`).
- **`params`** are float, int or bool settings stored per photo under `"{id}.{key}"`. Without `derive`, each is a uniform named by its key. Changing one never recompiles. Presets and copy/paste carry all of them. `api.pipelines.paramKeys(id)` lists them. Don't give a stage and a transform the same id: they share the bag.
- **`derive`** computes uniforms from the params in JavaScript, for coefficients or matrices that are costly or precision-sensitive to compute in GLSL. It runs on the main thread, memoised. A throw or a bad result binds the uniforms' defaults.
- Omit `glsl` to reuse the built-in transform with different flags. A transform that fails to compile renders with the built-in one and logs the error. Invalid fields refuse the registration, with the reason in the console. `params`, `helpers` and `derive` need Safelight 3.1.0.

## `ProcessingStageContribution` — GPU stage

A stage is GLSL that Safelight compiles into the develop program at a chosen phase. See [How a photo is rendered](../rendering.md) for the phases and an example.

```typescript
type ProcessingPhase =
  | "geometry"        // srcUv, before the image is sampled
  | "decode"          // lin, after the RAW baseline, before noise reduction
  | "noise-reduction" // lin, replaces the built-in denoiser
  | "scene-linear"    // lin, after the core tone edits and masks
  | "tone-map"        // lin, right after scene-linear
  | "display-adjust"  // c, after the display tools
  | "effects"         // c, core Vignette (50) and Grain (60) live here
  | "output-encode";  // c, last, before the output conversion

interface ProcessingStageContribution {
  id: string; name: string;
  phase: ProcessingPhase;
  priority?: number;          // order inside the phase, lower first (100)
  glsl: string;               // reads and writes srcUv, lin or c
  helpers?: string;           // GLSL functions, namespaced for you
  uniforms: UniformDeclaration[];
  passes?: StagePass[];       // pre-passes; result is vec3 stageResult
  textures?: TextureRequirement[];
  space?: StageSpace;         // ask for other values (see below)
  reads?: "source" | "current"; // what the first pass reads (see below)
  after?: string[];           // stage ids to run after, same phase
  mask?: { maskable: true };  // run again inside masks
  presetScope?: "global" | "per-image"; // in presets or not ("global")
  produces?: InterStageVariable[]; // values for later stages
  consumes?: string[];        // values from earlier stages
}

interface UniformDeclaration {
  key: string;                // GLSL name; bag key "{stageId}.{key}"
  glslType: GlslType;         // float, int, bool, vec2..4, mat3, mat4, ...
  default: number | number[] | boolean;
  range?: { min: number; max: number; step?: number };
  label?: string;
}
```

Notes:

- **Uniform values** live in the photo's param bag under `"{stageId}.{key}"`. Write the bag from your panel; the renderer binds the value every frame. With no bag value, `default` is used.
- **Be a no-op at your defaults.** Every registered stage runs on every photo.
- **Negative channels.** `lin` can hold negative values (colours outside sRGB). Guard before `log`, `pow` or `sqrt`.
- **`geometry`** stages change `srcUv`, the source position, so everything downstream samples the warped spot.
- **`decode`** stages see the image after the RAW baseline, before noise reduction. Use `decode`, not `noise-reduction`, for anything that isn't a denoiser.
- **`noise-reduction`** stages replace Safelight's denoiser and its Noise Reduction sliders. Supply your own controls.
- **`scene-linear` and `tone-map`** get the core shoulder's headroom only when the photo's display transform sets `skipToneShoulder`.
- **`presetScope: "per-image"`** is for settings tied to one photo's content, such as warp, heal or red-eye. They are left out of presets.
- **`after`** runs your stage after the named stages in the same phase, whatever the priorities. Unknown ids and ids in other phases are ignored, so you can name an optional partner.
- **Ids.** Ids under `core.` and `builtin.denoise` are reserved. An id can't end in `@` and a number (mask copies use that). `unregisterProcessingStage(id)` removes one stage.
- **Version.** `after`, `space` and `reads` are ignored by older builds. Set `minAppVersion` when you rely on them.

### Passes

`passes` are full-screen draws that run before the main program, for maths that needs neighbouring pixels (blurs, wavelets, denoisers). They ping-pong in source-pixel space. The last pass's result reaches your inline `glsl` as `vec3 stageResult`.

```typescript
interface StagePass {
  glsl: string;      // mutates vec3 c, starts as readPrev(vUv)
  helpers?: string;
  uniforms?: UniformDeclaration[]; // share the stage's bag keys
  iterations?: number | { key: string; max: number }; // draws (1)
}
```

- Each pass gets `uTexel` (1 / pass size), `uPassIndex`, `uPassCount`, `readPrev(uv)` (the previous pass, or the stage's input on the first), `uSrcLinear` (true for RAW float decodes) and `uSourceSize` (the decoded source's pixel size, 3.1.0).
- Passes run at a capped resolution. Scale a radius given in source pixels by `max(1.0 / uTexel.x, 1.0 / uTexel.y) / max(uSourceSize.x, uSourceSize.y)`.
- `iterations: { key, max }` reads the draw count from the bag each frame (3.0.1). 0 skips the pass. A stage whose passes all draw 0 times runs no passes that frame, so gate your inline `glsl` on the same condition.
- Passes run while the bag holds a non-zero value for the stage, or a `{ key, max }` count resolves above 0. A non-zero default count therefore runs on every photo.
- Passes can't read inter-stage variables. A pass that fails to compile disables the stage's passes for the session; the inline `glsl` still runs.

### Textures

```typescript
interface TextureRequirement {
  key: string;
  kind: "lut" | "coverage" | "dynamic";
  width?: number; height?: number;
  format?: "rgba8" | "rgba16f" | "r8";
}
```

- **`lut` and `dynamic`** take pixels from `api.setStageTexture(stageId, key, data)`. There is one global copy, not one per photo, so they suit film LUTs, not per-photo data. Supply them from `activate`: they are dropped when the extension is disabled, updated or reloaded.
- **`coverage`** is painted. The photo's bag value at `"{stageId}.{key}"` is a `BrushDab[]`, the same shape core brush masks use, and your inline `glsl` reads it as `float key(vec2 uv)` (0 to 1). It persists, undoes and exports like any edit. Replace the array when it changes (`[...dabs, dab]`); an array edited in place doesn't reach the renderer. Not readable inside passes.

### Values a stage sees: `space`

Without `space`, a stage before the display transform gets `lin` as linear Rec.709, signed and unclamped. A stage after it gets `c` sRGB-encoded and clipped to [0, 1].

Declare `space` and Safelight converts your variable in before your `glsl` and back out after it. The variable names stay the same.

```typescript
interface StageSpace {
  encoding: "linear" | "perceptual"; // perceptual = sRGB curve, sign kept, no ceiling
  primaries?: "rec709" | "rec2020";  // default rec709
}
```

- After the display transform, declaring `space` also gets you the unclipped values (on version 2 photos).
- **A display stage without `space` clips `c` for everything after it**, on every version 2 photo, even when the stage does nothing. If you only need [0, 1] while active, declare `space: { encoding: "perceptual" }` (no conversion, no clip) and clamp inside your own `if`.
- Conversions are exact. Neighbouring stages with the same space share one conversion.
- `perceptual` is `sign(x) · srgbEncode(|x|)`. On [0, 1] it equals the display encoding.
- An invalid `space` refuses the stage, with a console error. `space` on a `geometry` stage is ignored.

### Scene luminance after the transform: `slSceneLuma`

Stages in `display-adjust`, `effects` and `output-encode` can read `float slSceneLuma`: the pixel's scene luminance before the core shoulder compressed it, for HDR or highlight-aware effects. It exists only in the inline `glsl` (pass it to helpers as an argument). On version 1 photos it carries no headroom. Needs Safelight 3.0.0.

### Process versions

Each edit stores `params.processVersion`, the rendering version it was made with, so old edits never change look.

- **Version 1:** edits made before versions existed. Frozen. Clips to [0, 1] at more points, and stages after the display transform get clipped values even with `space`.
- **Version 2:** every new edit. Keeps the full range after the display transform wherever no tool needs [0, 1]. Tools that need [0, 1] (Whites, Blacks, Contrast, Dehaze, Tone Curve, HSL, Vibrance, Saturation, Color Grading, mask display edits) clip only while in use. Vignette and Grain don't clip.
- Users move a photo to the current version with **Update processing** or **Reset all edits**. Nothing else changes it.
- On a RAW, version 2 also applies the camera baseline after highlight reconstruction, and keeps what `decode` stages did when the denoiser runs. Version 1 loses it.
- Extensions read `processVersion` and never write it. When you render from params you pass in (`captureFrame`, `renderPhotoFrame`), start from a copy of the photo's own params: params without a version render as version 1.

### Reading the current image: `reads`

A stage's passes normally start from the decoded source (`reads: "source"`), with none of the user's edits. `reads: "current"` starts them from the image as edited up to your stage, for tools that should respond to exposure, white balance and earlier stages.

- Safelight draws everything up to your stage into a float texture first. That costs one extra draw whenever something upstream changes. Dragging your own inline-only params is free.
- Works from `decode` through `display-adjust`. `effects` and `output-encode` readers all read the end of `display-adjust`.
- The extra draw skips crop and geometry. Stages that may sit ahead of a reader should key on `srcUv`.
- A `decode` or `noise-reduction` reader is redrawn only when the stages before it, the source or retouching change, not on Exposure or White Balance.
- Without float render targets the stage reads the source instead, with one warning. `reads: "current"` on a stage without passes, or on `geometry`, is ignored.

### Inter-stage variables: `produces` / `consumes`

A stage can hand a per-pixel value to a later stage in the same draw.

```typescript
interface InterStageVariable {
  name: string;               // becomes the global isv_{name}
  glslType: "float" | "vec2" | "vec3" | "vec4";
  producer?: string;          // GLSL expression assigned after your glsl
}
```

- The producer lists it in `produces`. Consumers list the name in `consumes` and read `isv_{name}`. A stage that reads an `isv_` name it doesn't list is refused.
- Names are global. Prefix them with your extension's name. Letters, digits and underscores, no `__`.
- A consumer ordered before its producer reads 0. A consumer whose producer is missing is left out of the program, with a warning.
- Passes can't use them. Needs Safelight 3.0.1.

### Masks

`mask: { maskable: true }` lets a stage run again inside local adjustments. A mask whose bag holds any of your stage's keys gets its own copy of the stage, right after it, bound to that mask's values and blended by its coverage. A [per-mask panel](ui-shell.md#per-mask-panels-panelcontributionmask) writes those keys.

- Only `scene-linear`, `tone-map`, `display-adjust`, `effects` and `output-encode` stages can be masked.
- Copies run on version 2 photos only.
- A copy shares the stage's textures and passes' programs. What it `produces` stays inside the copy.
- If the GPU can't fit every copy, the frame is drawn without them and Develop shows a "Too many effects" notice.

## `KeyActionContribution`

```typescript
interface KeyActionContribution {
  id: string; label: string;
  category?: "General" | "Develop" | "Library";
  defaultCombo: string;       // e.g. "Ctrl+Shift+I"; "" for unbound
  handler(): void;
}
```

The action shows in **Preferences ▸ Shortcuts** and users can rebind it. `api.keybindings.getBinding(id)` returns the current combo (`""` when unbound). `api.keybindings.list()` returns every built-in action with its live combo, so you can avoid clashes. Combo format: [Subsystems → Keybindings](subsystems.md#keybindings).

## `SettingsContribution`

```typescript
interface SettingsContribution {
  title?: string;             // defaults to the extension name
  fields: SettingsField[];    // rendered for you, searchable
  order?: number;
  component?: ComponentType;  // fully custom UI instead (no props)
  keywords?: string[];        // extra Preferences search terms
}

type SettingsField =
  | { key; label; hint?; type: "boolean"; default: boolean }
  | { key; label; hint?; type: "number";  default: number; min?; max?; step? }
  | { key; label; hint?; type: "string";  default: string; placeholder? }
  | { key; label; hint?; type: "select";  default: string; options: { value; label }[] };
```

Your section in **Preferences ▸ Extensions**. Read and write values with `api.settings.get/set`, watch them with `api.settings.onChange`.

## `ExportProcessorContribution`

A step in every export, with its own section and settings in the Export panel.

```typescript
interface ExportProcessorContribution {
  id: string; label: string;
  settings?: ExportProcessorField[]; // same shape as SettingsField
  processPixels?(frame: ExportFrame, photo: CatalogPhoto,
    settings: Record<string, unknown>, context: ExportProcessorContext)
    : Promise<ExportFrame | void>;   // pixels before encoding (3.1.0)
  process?(blob: Blob, photo: CatalogPhoto,
    settings: Record<string, unknown>, context: ExportProcessorContext)
    : Promise<Blob>;                 // the encoded file
}

interface ExportProcessorContext { longEdge: number | null; } // null = original size

interface ExportFrame {
  data: Uint16Array;          // RGBA, top-down, 0..65535, in the file's colour space
  width: number; height: number;
  colorSpace: "srgb" | "display-p3" | "adobe-rgb" | "prophoto-rgb";
  icc: Uint8Array | null;     // profile the file will embed
  bitDepth: 8 | 16;
}
```

- Declare `processPixels`, `process` or both. Every `processPixels` runs before any `process`, in registration order, each getting the previous result.
- **`processPixels`** is the better choice for mats, borders and watermarks: it keeps the file's bit depth and ICC profile and works for TIFF. Edit `frame.data` in place or return a new frame. You may change the size. An 8-bit export's values arrive multiplied by 257.
- **`process`** gets the encoded file. Return a Blob of another image type and the file takes that type's extension.
- A processor that throws is logged and skipped, so an export is never lost.
- You can render more of the photo with `api.export.renderPhotos`; that render runs no export processors. Render with `context.longEdge` to match the file's pixel grid.
- Needs Safelight 3.1.0 for `processPixels`. Keep a `process` if you must run on older builds.

## `FilenameTemplateContribution`

```typescript
interface FilenameTemplateContribution { id: string; label: string; template: string; }
```

Variables: `{filename}` (without extension), `{ext}`, `{year}`, `{month}`, `{day}`, `{rating}`, `{camera}`, `{lens}`. Unknown variables are left as written.

## `CatalogHooksContribution`

Lets an extension own a side concern, such as XMP sidecars, without the core knowing about it.

```typescript
interface CatalogHooksContribution {
  id: string;
  onPhotoImport?(ctx: { photo: CatalogPhoto; dir: FileSystemDirectoryHandle; fileName: string })
    : Promise<Partial<CatalogPhoto> | void>; // fields to merge onto the record
  onMetadataChange?(ctx: { photos: CatalogPhoto[]; getEditState(id: string): Promise<EditState | null> })
    : Promise<void>;                         // rating, label, flag, keywords committed
  onEditCommit?(ctx: { photo: CatalogPhoto; editState: EditState }): Promise<void>;
  onPhotoRemove?(ctx: { photo: CatalogPhoto; dir: FileSystemDirectoryHandle; fileName: string })
    : Promise<void>;
}
```

Handlers are awaited. One that throws is logged and skipped, so it can't break an import or a save. When several `onPhotoImport` handlers return fields, the later ones win.

## `PresetImporterContribution`

```typescript
interface PresetImporterContribution {
  id: string; label: string;       // e.g. "Lightroom preset (.xmp)"
  extensions: string[];            // lowercase with dot, e.g. [".xmp"]
  parse(file: File): Promise<{ name: string; params: Partial<DevelopParams> } | null>;
}
```

Adds a file type to the Presets panel's Import picker. Return `null` or empty `params` when nothing maps, and the panel tells the user. Params use Safelight's scales: exposure in EV, temperature in Kelvin, most sliders ±100. They are merged over the photo's current edit.

## `GridFilterContribution`

```typescript
interface GridFilterContribution {
  id: string;
  test(photo: CatalogPhoto): boolean; // false hides it from the grid and culling
  onClear?(): void;                   // called by Library "Clear filters"
}
```

Combined with the Library's own filters (AND). Re-register with the same id when your query changes.

## `LibrarySortContribution`

```typescript
interface LibrarySortContribution {
  id: string; label: string;          // id is also the saved sort id
  compare(a: CatalogPhoto, b: CatalogPhoto): number; // ascending; the toolbar flips it
}
```

Adds an entry to the Library toolbar's sort menu.

## `GridMenuItemContribution`

```typescript
interface GridMenuItemContribution {
  id: string;
  label: string | ((ids: string[]) => string); // e.g. add "(3)"
  order?: number;                            // among extension items (100)
  danger?: boolean;                          // red, for destructive actions
  enabled?: (ids: string[]) => boolean;      // false = greyed out
  onClick: (ids: string[]) => void;
}
```

Adds an action to the Library grid's right-click menu, below the built-in items. `ids` is the right-clicked photo, or the whole selection when that photo is part of it. The same menu appears on extension photo surfaces that use [`api.catalog.usePhotoActions`](components.md#photo-surfaces-menu-and-shortcuts).

## `CursorContribution`

```typescript
interface CursorContribution {
  id: string;
  css?: string;               // a CSS cursor value, e.g. "crosshair"
  image?: string;             // inline <svg> or an image/data URL (≤ ~128×128)
  hotspotX?: number; hotspotY?: number;
  fallback?: string;          // keyword if the image can't load
}
```

A named cursor for the Develop canvas. Give `css` or `image`, and select it with [`api.develop.setCanvasCursor`](stores.md#apidevelop). Registering a built-in token id (`"pick"`, `"pan"`, ...) overrides it app-wide, which is how cursor themes work.

`api.cursors.labels` gives the built-in tokens' display names. `api.cursors.resolve(token)` returns the CSS cursor the app uses for a token right now, theme included. Both are read at render, not reactive.

## `StylesheetContribution`

```typescript
interface StylesheetContribution {
  id: string;
  css: string;                // plain CSS; @import is refused
}
```

CSS applied in every window after the core styles. Target the [styling hooks](components.md#styling-hooks) (`.sl-slider-thumb`, `.sl-select`, `button`, ...), not Tailwind class names, which change between releases. Your rules beat Tailwind utilities at equal specificity without `!important`; inline styles still win. `api.unregisterStylesheet(id)` removes one sheet.
