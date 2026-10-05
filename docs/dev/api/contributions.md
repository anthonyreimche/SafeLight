# Contribution Types

← [API Reference](README.md)

Signatures for every `register*` contribution. `src/extensions/types.ts` is the source of truth. All contributions are auto-tagged with the calling extension's id and swept when it is disabled or uninstalled.

> The UI-mount contributions — **`ModuleContribution`**, **`PanelContribution`** (including per-mask panels), **`PanelHeaderAccessoryContribution`**, **`SlotContribution`**, and **`LayoutContribution`** — are documented in [UI Shell](ui-shell.md). **Theming** is covered in [UI Components](components.md#theming-tokens).

**Jump to:** [Theme](#themecontribution) · [SliderIcon](#slidericoncontribution) · [Pipeline](#pipelinecontribution--display-transform) · [ProcessingStage](#processingstagecontribution--gpu-stage) · [KeyAction](#keyactioncontribution) · [Settings](#settingscontribution) · [ExportProcessor](#exportprocessorcontribution) · [FilenameTemplate](#filenametemplatecontribution) · [CatalogHooks](#cataloghookscontribution) · [PresetImporter](#presetimportercontribution) · [GridFilter](#gridfiltercontribution) · [LibrarySort](#librarysortcontribution) · [GridMenuItem](#gridmenuitemcontribution) · [Cursor](#cursorcontribution) · [Stylesheet](#stylesheetcontribution)

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
  glsl?: string;              // body defining: vec3 pipelineToDisplay(vec3 lin)
  skipBaseCurve?: boolean;    // drop the RAW baseline tone: the transform is the profile
  skipToneShoulder?: boolean; // bypass the core filmic shoulder: the transform rolls off highlights
}
```

`glsl` maps scene-linear RGB (sRGB primaries, HDR — values may exceed 1.0) to display-encoded output. A channel of `lin` can also be negative: colours outside the sRGB primaries reach the transform that way from RAW sources, and colour noise reduction can leave small excursions below zero on any source, so guard a channel before taking its `log`, `pow` or `sqrt`. Helpers available: `luma()`, `srgbToLinear()`, `linearToSrgb()`, `linearToSrgbU()`. Return the sRGB-encoded value and leave output spaces alone: the core converts once at the end for the selected output space (Display-P3, Adobe RGB, ProPhoto).

Two independent flags decide what reaches the transform; set both for true scene-linear input:

- **`skipBaseCurve`** — the transform brings its own look (AgX, ACES, …), so Safelight drops the baseline tone it applies to RAW sources in linear light and the transform is the profile. It drops the baseline only: the core filmic shoulder still runs unless `skipToneShoulder` is set.
- **`skipToneShoulder`** — the transform brings its own highlight roll-off. The core's default filmic shoulder, which compresses luminance above 0.85 at Highlights 0, is bypassed, so the transform receives exposure-scaled scene-linear values with their headroom. Highlights still works, globally and in masks: a negative value blends in the core recovery in proportion to the slider, and a positive value lifts values up to white and leaves values above white untouched. On photos at [process version](#process-versions) 1 the core clamps the transform's output to [0, 1] straight away. On version 2 photos it passes on unclamped and is clipped at the output encode, or earlier, at the first display tool in use that needs [0, 1] and just before any post-transform stage that declares no `space`. A transform that skips the shoulder should still bound its own output. Safelight builds from before this flag ignore it and keep the shoulder; set `minAppVersion` in the [manifest](../extensions/README.md#manifest) if the transform relies on it.

Omit `glsl` to reuse the built-in transform; the flags still apply. Transforms are picked per photo from the display transform menu in Develop's bottom bar; **Preferences ▸ Rendering ▸ Default display transform** covers photos without a pick. A photo's transform applies everywhere it renders (develop, loupe, thumbnails, export). This is the simplest way to ship a whole-image tone mapper.

On version 2 photos the built-in transform keeps colours outside the sRGB primaries as signed values instead of flooring them at black.

## `ProcessingStageContribution` — GPU stage

```typescript
type ProcessingPhase =
  | "geometry"        // srcUv, before the image is sampled
  | "decode"          // lin after the baseline tone, before core NR
  | "noise-reduction" // lin, same point as decode (sorted after it)
  | "scene-linear"    // lin after the core linear edits (exposure, tone shoulder, masks)
  | "tone-map"        // lin, same point as scene-linear (sorted after it)
  | "display-adjust"  // display-encoded c, after Sharpening and the masks' display adjustments
  | "effects"         // c, same point as display-adjust (sorted after it)
  | "output-encode";  // c, same point (sorted last): before the core's own output encoding and its final clip to [0, 1]

interface StageSpace {
  encoding: "linear" | "perceptual";
  primaries?: "rec709" | "rec2020"; // default "rec709"
}

interface ProcessingStageContribution {
  id: string; name: string;
  phase: ProcessingPhase;     // order set in stage-order.ts, placement in stage-injection.ts
  priority?: number;          // within phase, lower runs first (default 100)
  glsl: string;               // fragment on srcUv, lin or c by phase (read/write)
  helpers?: string;           // helper functions (namespaced by the compiler)
  uniforms: UniformDeclaration[];
  passes?: StagePass[];       // pre-passes (ping-pong FBOs); result is `vec3 stageResult`
  produces?: InterStageVariable[]; // reserved, not implemented
  consumes?: string[];        // reserved, not implemented
  textures?: TextureRequirement[];
  mask?: { maskable: true; maskPhase: "linear" | "display" }; // reserved, not implemented
  presetScope?: "global" | "per-image"; // how the stage's params behave in presets (default "global")
  space?: StageSpace;         // opt into full-information values (see "Values a stage sees")
  reads?: "source" | "current"; // what the stage's passes read first (default "source")
  after?: string[];           // stage ids to run after, inside the phase (see below)
}
```

The stage injection (`src/rendering/webgl/stage-injection.ts`, with the order set in `stage-order.ts`) decomposes the develop shader into individually contributable GPU stages, and the path is **live**: all phases compile in, stages take custom uniforms (via the param bag, qualified as `{stageId}.{key}`), bind textures/LUTs (`api.setStageTexture`), and persist per-photo.

- **`phase: "geometry"`** is special — it runs first and operates on the mutable source-UV `vec2 srcUv` (after crop/transform/lens, *before* the image is sampled), so a geometry stage can warp/displace the coordinate and have the entire downstream pipeline follow. Every other phase operates on a color (`lin` or `c`).
- **`phase: "decode"`** runs on the linear colour after the baseline tone (applied to RAW sources unless the display transform sets `skipBaseCurve`), at the same injection point as `noise-reduction`: before core NR. Stage prepasses read the source through the same linearisation and baseline (`toLin`), so no extension hook sees the decode before the baseline. The built-in denoiser runs after every `decode` stage and, whenever Luminance or Colour NR is above 0 (Colour NR defaults to 25), replaces `lin` with its own result. On a [process version](#process-versions) 1 photo that result is a denoised copy of the source, so whatever a `decode` stage did to `lin` is lost. On version 2 it denoises the image as the `decode` stages left it: while a `decode` stage is registered it reads the current image (see [`reads`](#reading-the-current-image-reads)), which adds one cached develop draw at prepass size ahead of its passes. On a GPU without float render targets it reads the source, as on version 1.
- **`phase: "scene-linear"` / `"tone-map"`** run on `lin` after the core linear edits. Under a display transform that sets `skipToneShoulder` they also receive the headroom above 1.0 that the core shoulder otherwise compresses.
- **Negative channels.** Scene-linear `lin` can hold negative components: colours outside the sRGB primaries arrive that way from RAW sources, and colour noise reduction can leave small excursions below zero on any source. A stage that takes the `log`, `pow` or `sqrt` of a channel must guard it.
- **`passes`** are full-screen pre-passes that ping-pong through framebuffers in source-UV space, enabling neighbourhood/iterative algorithms (à trous wavelets, NLM, separable blurs) a single inline fragment can't express. The final pass output is exposed to the stage's inline `glsl` as `vec3 stageResult`. See `StagePass` in `src/extensions/types.ts` for the per-pass contract (`uTexel`, `uPassIndex`, `uPassCount`, `readPrev(uv)`).
- **`textures`** declare what the stage samples. `kind: "lut"` / `"dynamic"` textures take pixel data from `api.setStageTexture` (a single global bag — right for film LUTs, wrong for anything per photo). `kind: "coverage"` textures are painted: the photo's paramBag value at `"{stageId}.{key}"` is a `BrushDab[]` (source-UV, radius in image-height units — the same shape core brush masks use), baked into brush coverage per render and read by the inline `glsl`/`helpers` as `float key(vec2 uv)` (0..1 at source-UV; not available inside passes). Because the dabs are ordinary bag values they persist, undo, export and paste like any edit and never enter presets. Coverage shares the atlas's four channels with the photo's own brush masks; when they are all taken the key reads as unpainted and a warning is logged once. The render worker is sent only the bag values whose identity changed, so replace the `BrushDab[]` with a new array whenever it changes (`[...dabs, dab]`) and never push into or edit the one you set before: a value edited in place no longer reaches the renderer.
- **`presetScope`** decides how the stage's params travel in presets. `"global"` (the default) is a look that suits any photo, such as a film sim or a curve: it is offered when saving a preset and pre-selected once changed. `"per-image"` is tied to one photo's content, such as warp, heal or red-eye: it is left out of presets and only listed under the Save dialog's **Show all**.
- **`after`** orders stages inside a phase. A stage runs after every stage in its `after` that is registered in the same phase, even against its `priority`; everything else is ordered as before, by phase, then `priority`, then registration order. An id that isn't registered, or sits in another phase, is ignored (a phase boundary always wins), so a stage can name an optional partner. Stages that name each other in a cycle lose the entries between them and nothing else: a member that also names a stage outside the cycle still waits for it. The core logs one warning per distinct cycle (once per JavaScript context: the render worker and each window log separately), naming its stages. A value that isn't an array of ids is ignored, and registration warns about it. Older builds ignore `after`: set `minAppVersion` when a stage relies on it.
- **`produces`, `consumes` and `mask`** are reserved and not implemented: nothing in the render path reads them. A stage that sets one still registers, with a console warning.
- **`phase`** must be one of the phases above. Any other name registers with a console warning, and the stage sorts after every listed phase.
- **Reserved ids.** Ids under `core.` and the id `builtin.denoise` belong to Safelight's own stages, which the pipeline treats differently from an extension's (a `core.` stage keeps raw uniform names and has no param-bag bindings). An extension that registers one is refused with a console error, and a stage already registered under that id stays.
- Re-registering the same `id` replaces the stage (and its params), unless the [registration checks](#values-a-stage-sees-space) refuse the new definition and leave the old one in place; `unregisterProcessingStage(id)` removes one without disabling the whole extension. The shader recompiles on any such change.

Reach for a stage (over `registerPipeline`) when you need phase ordering, uniforms, multiple passes, or coordinate warping. Lens correction is built this way: it moved out of core into the optional [Lens Correction](https://github.com/anthonyreimche/Lens-Correction) extension, which ships distortion as a `geometry` stage, chromatic aberration as a `decode` stage with a pre-pass, vignetting in `scene-linear`, and defringe in `effects`.

> **`registerLensProfile` was removed.** Core no longer has a lens database, so there is nothing for a lens profile to plug into. Ship corrections as processing stages instead, as the Lens Correction extension does.

### Values a stage sees: `space`

`phase` says where a stage runs. `space` says which values it gets there. Omit `space` and `reads` and a stage behaves exactly as it always has. Declare `space` and the core converts the stage's variable in before its `glsl` runs and back out after it. The variable names don't change (`lin` before the display transform, `c` after it), so the GLSL reads the same and only the values differ.

| Position | Phases | Without `space` | With `space` |
|---|---|---|---|
| Before the display transform | `decode`, `noise-reduction`, `scene-linear`, `tone-map` | `lin`: linear Rec.709, signed, unclamped | `lin` in the declared encoding and primaries |
| After the display transform | `display-adjust`, `effects`, `output-encode` | `c`: perceptual Rec.709 (sRGB-encoded), clamped to [0, 1] | `c`: the transform's output as the display tools leave it, unclamped and signed, in the declared encoding and primaries |

`geometry` stages run before the image is sampled and take no `space`. The unclamped values after the transform are what version 2 photos deliver. A version 1 photo hands a declaring stage its encoding and primaries but clamped values (see [Process versions](#process-versions)).

- **`encoding: "linear"`** is proportional to light. Before the transform that is scene-linear. After it, it is the transform's output with the sRGB curve removed (display-linear).
- **`encoding: "perceptual"`** is the sRGB curve applied to the magnitude, with the sign put back and no ceiling:

  ```
  encodePerceptual(x) = sign(x) · srgbEncode(|x|)  // 12.92·|x| below 0.0031308, else 1.055·|x|^(1/2.4) − 0.055
  decodePerceptual(y) = sign(y) · srgbDecode(|y|)  // |y| / 12.92 below 0.04045, else ((|y| + 0.055) / 1.055)^2.4
  ```

  On [0, 1] that is the display encoding, so math written for sRGB-encoded values behaves the same there and still sees what lies beyond it: above 1 and below 0 the values pass through and invert exactly. Channels keep their sign, so a stage that takes the `log`, `pow` or `sqrt` of one still has to guard it.
- **`primaries`** defaults to `"rec709"`, the core's working primaries. `"rec2020"` is a per-stage view of the same data: the BT.2087 matrix on the way in and its inverse on the way out. It is exact to float precision, so a stage that changes nothing changes nothing. After the transform the conversion decodes the sRGB curve, applies the matrix, then re-encodes as the declared encoding requires.

The core's own working values stay linear Rec.709 and signed before the display transform, and sRGB-encoded Rec.709 after it. Consecutive stages that declare the same space share one conversion in and one out instead of converting around each. A core stage or a stage with another space ends the run, and so does a change of injection point: `decode` and `noise-reduction` share one, `scene-linear` and `tone-map` another, and `display-adjust`, `effects` and `output-encode` the third. A split exit ends one too (see `reads` below): the core hands the variable back in working values ahead of it. Ending a run only costs one more conversion pair. A stage's passes read in its declared space too (see [Reading the current image](#reading-the-current-image-reads)).

**Registration checks.** An invalid `space` or `reads` refuses the stage: a missing or unknown `encoding`, an unknown `primaries` or `reads` value, or a `space` that isn't an object. The core logs a console error and doesn't register the stage, and a refused re-registration keeps the previously registered stage and its params instead of replacing them. Unknown keys inside `space` (a typo such as `primary`) and `space` on a `geometry` stage are accepted with a console warning, and the core ignores them.

### Process versions

A photo's edit carries `params.processVersion`, the rendering generation it was made with. It decides how the core treats values after the display transform. Before the transform both versions give a stage the same `lin`, with two exceptions: on version 2 the built-in denoiser keeps what `decode` stages did to it (see [`phase: "decode"`](#processingstagecontribution--gpu-stage)), and with any heal or clone spot version 2 develops, denoises and splits from a copy of the source that keeps its headroom and its channels below black, where version 1 clips the whole frame to [0, 1].

- **Version 1** is every edit saved before process versions existed, and any params without a `processVersion`. It renders exactly as it always has, forever, with every clamp the core ever had.
- **Version 2** is every new edit: a photo with no stored edit yet, a photo after Reset all edits, which starts it over at the current version, and a photo after Update processing, which raises a version 1 photo to the current version as one undoable step and keeps every other setting. Those two are the only actions that change a photo's version: resetting a single panel, presets, pasted settings and previews never do, and undo and redo restore the version of the snapshot they step to.
- A version newer than the build knows is kept as stored and renders as the newest version the build has.

On version 2 nothing clips the image between the display transform and the output encode unless a tool that needs [0, 1] is in use:

- **Tools that need [0, 1]** clip their input while they are in use, and are skipped entirely when they are at rest: Whites, Blacks, Contrast, Dehaze, Tone Curve, HSL, Vibrance and Saturation, Color Grading, and each mask's display adjustments.
- **Additive detail tools never clip**: Sharpening, Clarity, Texture, Highlight Detail and Shadow Detail, including the band detail that Highlights below 0 and Shadows above 0 switch on. They add an offset to `c`.
- **Masks.** A mask with any display adjustment, even an additive-only one (Clarity, Sharpness, Texture), clips the pixels it covers, and so does a mask's HSL or Tone Curve sub-panel. Pixels outside the mask, and the uncovered share of partially covered pixels, keep their full range.
- **Core Vignette and Grain never clip.** Vignette scales `c` and Grain adds an offset to it, and both hand on the result, values outside [0, 1] included, so a stage that declares `space` still gets the full range after them. They run in `effects` at priorities 50 and 60, so a stage there at priority 61 or above (the default, 100, is) runs after both, as does every `output-encode` stage.
- **Stages that declare no `space`** still get [0, 1], even one that sets `reads`: the core clips `c` just before each one, and everything downstream of it, stages that declare `space` included, sees the clipped values.
- **Unchanged.** The fallback preview's clamp stays (an 8-bit embedded preview has no headroom), and the output encode clips to [0, 1].

On a version 1 photo every stage after the transform gets the values the old core produced: clamped to [0, 1], except for the offset Sharpening adds after the last clamp (a mask covering a pixel in part mixes it through). A stage that declares `space` still gets its encoding and primaries.

At identical settings the two versions differ in six ways. A pixel outside [0, 1] after the transform gets the additive detail tools (Sharpening's default 25 included) applied to its true value instead of the clipped one, which shows as a difference in bright saturated and out-of-sRGB colours along edges. With no user tone curve, version 2 skips the 8-bit curve table that version 1 resamples every pixel through, a shift of up to about 1/512. While a `decode` stage is registered and Luminance or Colour NR is above 0, version 2 keeps what the `decode` stages did to `lin`, which version 1 loses to the built-in denoiser. A mask's Clarity, Sharpness and Texture measure detail from the source luma on both sides on version 2, as the global tools do; version 1 sets the luma of the edited colour against blurs of the source luma, so it reads flat areas as detail. With any heal or clone spot, version 2 develops, denoises and splits from a copy that keeps the source's headroom and its channels below black, where version 1 clips the whole frame to [0, 1]; a GPU without float render targets keeps the clipped copy on both. And the core Vignette and Grain work on values outside [0, 1] on version 2 (they no longer clip), so grain added over areas that a Vignette with a positive Amount lifts past white is lost at the output clip, where version 1 clips the lift before Grain adds to it and so still shows the darker half of the grain.

Extensions read `params.processVersion` and never write it. A frame rendered from params you pass in (`api.develop.captureFrame`, `api.develop.renderPhotoFrame`) uses the version those params carry, and params without a `processVersion` render as version 1, so start from a copy of the photo's own params. An extension that copies settings from another photo, or rebuilds a look from a stored snapshot such as the Original, keeps the target photo's current `processVersion` instead of carrying over the source's or the snapshot's. Only Reset all edits and Update processing change a photo's version.

### Reading the current image: `reads`

A stage's passes normally start from the decoded source (`reads: "source"`): retouching is applied, but none of the user's other edits and none of the stages before it. With `reads: "current"` the first pass starts from the image as edited up to this stage instead, which is what a detail or colour tool needs when it should respond to exposure, white balance and the stages before it. Later passes still read the pass before them, and the inline `glsl` still gets `stageResult`.

| First pass reads | `space` omitted | `space` declared |
|---|---|---|
| `reads: "source"` (default) | the decoded source, linearized: linear Rec.709, with the baseline tone where it applies | the same source converted into the declared encoding and primaries |
| `reads: "current"` | the stage's input as its `glsl` receives it: `lin` before the display transform, `c` after it | the image as edited up to the stage, in the declared encoding and primaries |

A `source` read is taken before the display transform whatever the phase. For a display-phase stage that declares `space`, the first pass therefore starts from values in `c`'s encoding but not in its tonal state, because no transform or edit has been applied to them. Use `reads: "current"` when it should match both. With `reads: "current"` on a version 2 photo, a display-phase stage that declares no `space` reads `c` clipped to [0, 1], as its `glsl` does.

- **Position.** Any phase from `decode` through `display-adjust`. An `effects` or `output-encode` stage reads the image as of the end of `display-adjust`: every stage in those phases, Vignette and Grain included, works in output-frame coordinates, which a draw in source texels can't reproduce. A `decode` or `noise-reduction` reader gets the image ahead of every core edit (noise reduction, white balance, exposure, masks), so it is redrawn only when the stages before it, its source or the retouch change. Exposure, White Balance and masks don't redraw it, which assumes the stages ahead of the reader don't read core uniforms such as `uExposure` or `uTemperature`: one that does goes stale when those change. A `noise-reduction` stage displaces the built-in denoiser and the core noise reduction, so the Detail panel's Noise Reduction sliders do nothing unless the stage supplies its own. A reader that isn't a denoiser should use `decode`, which shares the injection point and replaces nothing.
- **How it's drawn.** Before the passes run, the core draws everything up to the stage into a half-float (RGBA16F) texture, in source texels at the prepass size, the source-capped size every pass renders at. That draw skips crop, straighten, transform, upright and `geometry` stages: the stage reads the result at its displaced `srcUv`, so geometry applies once. It evaluates the stages before the reader per source texel, so one that reads `vUv` or `viewUv` (output-frame coordinates), or `sensorUv` under a geometry warp, computes differently inside it than in the main draw. Stages that may sit ahead of a reader should key on `srcUv`.
- **Several readers.** Splits are drawn in pipeline order, and each includes the earlier stages with their `stageResult`s, so a later reader sees an earlier reader's work. Readers in `effects` and `output-encode` are the exception: they all read the same point, the end of `display-adjust`, so none sees another's work, or any `effects` stage's.
- **Cost.** One extra develop draw at prepass size runs ahead of the stage's passes whenever anything upstream of the stage changes. Dragging the stage's own inline params, the ones no pass declares, is free. Changing a pass param re-runs the passes and the split draw together. N readers cost N split draws when their upstream changes. With no `current` stage registered there are no split draws at all, apart from the built-in denoiser's on version 2 photos while a `decode` stage is registered and Luminance or Colour NR is above 0 (below).
- **The built-in denoiser** reads the current image on version 2 photos whenever a `decode` stage runs ahead of it, so its result keeps what the `decode` stages did (see [`phase: "decode"`](#processingstagecontribution--gpu-stage)). Its split is drawn only while Luminance or Colour NR is above 0, the same condition that runs its passes. It is cut ahead of the core edits, like any `noise-reduction` reader's, and is redrawn together with its passes only when a Noise Reduction slider, a `decode` stage's params or textures, the source or the retouch change. Exposure, White Balance and masks leave it cached. With no `decode` stage registered, and on version 1 photos, it reads the source and draws no split.
- **No float render targets** (`EXT_color_buffer_float`). The stage reads the source instead, as with `reads: "source"`, and the core logs one warning per stage: an 8-bit split would clip the data `current` exists to deliver.
- **Ignored.** `reads: "current"` on a stage with no `passes`, or on a `geometry` stage, logs a warning and the stage registers as `reads: "source"`.

Set `minAppVersion` to the first Safelight release with these fields when a stage relies on them; older builds ignore `space` and `reads` and hand the stage legacy values.

## `KeyActionContribution`

```typescript
interface KeyActionContribution {
  id: string; label: string;
  category?: "General" | "Develop" | "Library";
  defaultCombo: string;       // e.g. "Ctrl+Shift+I"; "" for unbound
  handler(): void;
}
```

The action appears in **Preferences ▸ Shortcuts** and is rebindable like any built-in. Read the current binding with `api.keybindings.getBinding(actionId)` (`""` when unbound). `api.keybindings.list()` returns every built-in action as `{ id, label, category, combo }` with the user's overrides applied, so a tool that picks default combos can check them against the live shortcuts instead of a hard-coded list. See [Subsystems → Keybindings](subsystems.md#keybindings) for combo format.

## `SettingsContribution`

```typescript
interface SettingsContribution {
  title?: string;             // section title (defaults to the extension name)
  fields: SettingsField[];    // auto-rendered, themed, searchable
  order?: number;
  component?: ComponentType;  // escape hatch for fully custom UI (receives no props)
  keywords?: string[];        // extra Preferences-search synonyms, e.g. for a custom component
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

Teaches the Presets panel's Import picker to read preset files from other apps. Return `null` (or empty `params`) when the file holds no settings you can map: the panel tells the user it found no develop settings instead of saving an empty preset. A throwing `parse` is logged and reported the same way. Params are on Safelight's own scales (exposure in EV, temperature in Kelvin, most sliders ±100), and the panel merges them over the photo's current edit.

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

## `GridMenuItemContribution`

```typescript
interface GridMenuItemContribution {
  id: string;                                // globally unique, e.g. "my-ext.virtual-copy"
  label: string | ((ids: string[]) => string); // a function can vary it, e.g. add "(3)"
  order?: number;                            // among extension items (default 100)
  danger?: boolean;                          // render in the red "danger" color
  enabled?: (ids: string[]) => boolean;      // false = shown greyed out
  onClick: (ids: string[]) => void;
}
```

Appends an action to the Library grid's right-click menu, grouped below the built-in actions behind a separator. `ids` are the targeted photos: the right-clicked photo, or the whole selection when the right-clicked photo is part of it (the same targeting the built-in items use). Re-registering the same id replaces the item. The same menu appears on extension photo surfaces that use [`api.catalog.usePhotoActions`](components.md#photo-surfaces-menu-and-shortcuts).

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

A named cursor for the Develop canvas. Supply **either** `css` or `image`. Reference it by `id` from [`api.develop.setCanvasCursor`](stores.md#apidevelop). Inline SVG is encoded to a data URL (always CSP-allowed); an `image` URL is subject to the app CSP. Re-registering the same id replaces it. Registering a built-in token id (`"pick"`, `"pan"`, …) overrides that token app-wide, which is how a cursor theme works; the built-in comes back when the extension unloads.

`api.cursors` exposes the shared cursor vocabulary:

| Member | Notes |
|---|---|
| `labels` | Canonical human-facing names for the built-in cursor tokens, keyed by token id (`"pick"`, `"zoom-in"`, `"crop-move"`, …). Use them to label controls that restyle cursors so the wording matches the app. |
| `resolve(token)` | The concrete CSS `cursor` value for a token right now, including any cursor-theme override. Use it to give an interactive overlay the same cursor the app uses (e.g. `resolve("pick")` for an on-image color picker) instead of hard-coding `"crosshair"`. An unknown token is returned as-is, so a raw CSS value passes through. |

Both are non-reactive: read them at render.

## `StylesheetContribution`

```typescript
interface StylesheetContribution {
  id: string;   // globally unique, e.g. "my-ext.controls"
  css: string;  // plain CSS
}
```

Plain CSS applied in **every** app window (detached module windows included) after the core styles. It is the way to restyle the core controls: target the [styling hooks](components.md#styling-hooks) (`.sl-slider-thumb`, `.sl-switch-track`, `.sl-select`, `button`, `input[type="checkbox"]`, …) rather than Tailwind class names, which are not a contract.

Cascade: the sheet is a constructed stylesheet in `document.adoptedStyleSheets`, so it always sits after the document's own CSS, and its rules are unlayered while Tailwind's utilities live in `@layer utilities` — an extension rule therefore wins over any utility class at equal or lower specificity without `!important`. Inline `style` attributes still win. `@import` is refused (the sheet is left empty and a warning logged). Re-registering the same id replaces the CSS in place; `api.unregisterStylesheet(id)` removes one sheet, and disabling or uninstalling the extension removes them all.
