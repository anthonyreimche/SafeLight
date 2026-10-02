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
  glsl?: string;          // body defining: vec3 pipelineToDisplay(vec3 lin)
  skipBaseCurve?: boolean; // the transform brings its own complete look (AgX, ACES, …)
}
```

`glsl` maps scene-linear RGB (sRGB primaries, HDR — values may exceed 1.0) to display-encoded output. Helpers available: `luma()`, `srgbToLinear()`, `linearToSrgb()`, `linearToSrgbU()`. Return the sRGB-encoded value and leave output spaces alone: the core converts once at the end for the selected output space (Display-P3, Adobe RGB, ProPhoto). With `skipBaseCurve`, Safelight drops the baseline tone it applies to RAW sources in linear light, so the transform sees true scene-linear data; the transform is the profile. Omit `glsl` to reuse the built-in transform. Transforms are picked per photo from the display transform menu in Develop's bottom bar; **Preferences ▸ Rendering ▸ Default display transform** covers photos without a pick. A photo's transform applies everywhere it renders (develop, loupe, thumbnails, export). This is the simplest way to ship a whole-image tone mapper.

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
  presetScope?: "global" | "per-image"; // how the stage's params behave in presets (default "global")
  after?: string[];           // soft dependencies on other stage ids
}
```

The stage model and shader compiler (`src/rendering/webgl/shader-compiler.ts`) decompose the develop shader into individually contributable GPU stages, and the path is **live**: all phases compile in, stages take custom uniforms (via the param bag, qualified as `{stageId}.{key}`), bind textures/LUTs (`api.setStageTexture`), and persist per-photo.

- **`phase: "geometry"`** is special — it runs first and operates on the mutable source-UV `vec2 srcUv` (after crop/transform/lens, *before* the image is sampled), so a geometry stage can warp/displace the coordinate and have the entire downstream pipeline follow. Every other phase operates on a color (`lin` or `c`).
- **`passes`** are full-screen pre-passes that ping-pong through framebuffers in source-UV space, enabling neighbourhood/iterative algorithms (à trous wavelets, NLM, separable blurs) a single inline fragment can't express. The final pass output is exposed to the stage's inline `glsl` as `vec3 stageResult`. See `StagePass` in `src/extensions/types.ts` for the per-pass contract (`uTexel`, `uPassIndex`, `uPassCount`, `readPrev(uv)`).
- **`textures`** declare what the stage samples. `kind: "lut"` / `"dynamic"` textures take pixel data from `api.setStageTexture` (a single global bag — right for film LUTs, wrong for anything per photo). `kind: "coverage"` textures are painted: the photo's paramBag value at `"{stageId}.{key}"` is a `BrushDab[]` (source-UV, radius in image-height units — the same shape core brush masks use), baked into brush coverage per render and read by the inline `glsl`/`helpers` as `float key(vec2 uv)` (0..1 at source-UV; not available inside passes). Because the dabs are ordinary bag values they persist, undo, export and paste like any edit and never enter presets. Coverage shares the atlas's four channels with the photo's own brush masks; when they are all taken the key reads as unpainted and a warning is logged once.
- **`presetScope`** decides how the stage's params travel in presets. `"global"` (the default) is a look that suits any photo, such as a film sim or a curve: it is offered when saving a preset and pre-selected once changed. `"per-image"` is tied to one photo's content, such as warp, heal or red-eye: it is left out of presets and only listed under the Save dialog's **Show all**.
- Re-registering the same `id` replaces the stage (and its params); `unregisterProcessingStage(id)` removes one without disabling the whole extension. The shader recompiles on any such change.

Reach for a stage (over `registerPipeline`) when you need phase ordering, uniforms, multiple passes, or coordinate warping. Lens correction is built this way: it moved out of core into the optional [Lens Correction](https://github.com/anthonyreimche/Lens-Correction) extension, which ships distortion as a `geometry` stage, chromatic aberration as a `decode` stage with a pre-pass, vignetting in `scene-linear`, and defringe in `effects`.

> **`registerLensProfile` was removed.** Core no longer has a lens database, so there is nothing for a lens profile to plug into. Ship corrections as processing stages instead, as the Lens Correction extension does.

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
