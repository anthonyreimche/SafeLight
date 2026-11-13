# Contribution Types

← [API Reference](README.md)

Signatures for every `register*` call except the UI-mount ones (modules, panels, header accessories, slots, layouts), which are in [UI Shell](ui-shell.md). The exact types are in [`src/extensions/api/contributions.ts`](../../../src/extensions/api/contributions.ts). Every contribution is tagged with your extension's id and removed when it is disabled or uninstalled. Re-registering the same `id` replaces a contribution. An `id` belongs to the extension that registered it first: if another extension registers the same `id`, the call is ignored and a warning names both extensions. Pick ids with your extension's prefix, as the examples do.

For where GPU code runs and what values it sees, read [How a photo is rendered](../rendering.md) first.

**Jump to:** [Theme](#themecontribution) · [SliderIcon](#slidericoncontribution) · [Pipeline](#pipelinecontribution--display-transform) · [ProcessingStage](#processingstagecontribution--gpu-stage) · [KeyAction](#keyactioncontribution) · [Settings](#settingscontribution) · [ExportProcessor](#exportprocessorcontribution) · [FilenameTemplate](#filenametemplatecontribution) · [CatalogHooks](#cataloghookscontribution) · [PresetImporter](#presetimportercontribution) · [GridFilter](#gridfiltercontribution) · [LibrarySort](#librarysortcontribution) · [GridMenuItem](#gridmenuitemcontribution) · [Cursor](#cursorcontribution) · [Stylesheet](#stylesheetcontribution)

## `ThemeContribution`

```typescript
interface ThemeContribution {
  id: string; name: string;
  colorScheme?: "light" | "dark";
  vars: Record<string, string>; // CSS custom properties applied to :root
  window?: { material: "acrylic" | "mica" }; // 3.2.1: a glass window
}
```

The variables you can set are listed in [UI Components → Theming tokens](components.md#theming-tokens).

**Glass themes (3.2.1).** With `window.material`, the system draws the window's backdrop and your translucent `--color-surface-*` values show it: acrylic or mica on Windows 11 22H2 and later, vibrancy on macOS. Elsewhere, on the software graphics backend, and while Reduce transparency is on, the window stays opaque, and so do your surfaces: Safelight writes each `--color-surface-*` at full opacity until the window confirms it draws the material. Your other colours keep their alpha. The Develop canvas surround is always opaque. The choice is remembered, so the next launch opens with it.

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
- **Encoding out-of-range values.** `linearToSrgb()` is a display encode that clips: it clamps its input to 0..1 first, so highlights above 1.0 and anything below 0 are lost. Use it only for a final, display-bound value. To keep HDR highlights, use `linearToSrgbU()`, which clamps at 0 but lets values above 1.0 through (the curve continues past 1.0). To keep negative values too, which wide-gamut and noise-reduced pixels can have, use `slEncodePerceptual()` (version 2 photos only), which encodes the magnitude and keeps the sign. There is no signed variant that also works on version 1; copy the maths under your own name if you need one there.
- **`params`** are float, int or bool settings stored per photo under `"{id}.{key}"`. Without `derive`, each is a uniform named by its key. Changing one never recompiles. Presets and copy/paste carry all of them. `api.pipelines.paramKeys(id)` lists them. Don't give a stage and a transform the same id: they share the bag.
- **`derive`** computes uniforms from the params in JavaScript, for coefficients or matrices that are costly or precision-sensitive to compute in GLSL. It runs on the main thread, memoized. A throw or a bad result binds the uniforms' defaults.
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
  dormantWhen?: Record<string, number | number[] | boolean>; // 3.2.1, see below
  viewOnly?: boolean;         // 3.2.4: a view aid, see below
  keepsDetail?: boolean;      // 3.2.4: keeps Dynamic's detail on, see below
}

interface UniformDeclaration {
  key: string;                // GLSL name; bag key "{stageId}.{key}"
  glslType: GlslType;         // float, int, bool, vec2..4, mat3, mat4, ...
  length?: number;            // an array of 1 to 64 (not mats or samplers)
  default: number | number[] | boolean;
  range?: { min: number; max: number; step?: number };
  label?: string;
}
```

Notes:

- **Uniform values** live in the photo's param bag under `"{stageId}.{key}"`. Write the bag from your panel; the renderer binds the value every frame. With no bag value, `default` is used.
- **Be a no-op at your defaults.** Every registered stage runs on every photo, unless it declares `dormantWhen`.
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
  glsl: string;      // mutates vec3 c, starts as its own texel of the previous draw
  helpers?: string;
  uniforms?: UniformDeclaration[]; // share the stage's bag keys
  iterations?: number | { key: string; max: number }; // draws (1)
  channels?: 3 | 4;  // 4: glsl mutates vec4 c, alpha included
  region?: string;   // body of ivec4 passRegion(): the texels each draw writes
  keep?: boolean;    // keep the state after this pass for later frames
}
```

- `channels: 4` keeps a fourth value per pixel between draws. Your `glsl` mutates `vec4 c`, which starts as the previous draw's texel, and the draw stores all four channels. `vec4 fetchPrev4(ivec2 texel)` fetches any texel of the previous draw exactly, alpha included, and `vec4 readPrev4(vec2 uv)` samples it with linear filtering. Use `fetchPrev4` for state you carry through many draws: a filtered read mixes in a trace of the neighbours, about 3·10⁻⁵ of them, and over a long chain that adds up. On the stage's input the alpha is 1, and the first draw's `fetchPrev4` samples the input, which can be the source at another size. Without float render targets the alpha is clipped to [0, 1] at 8 bits, like the rgb. The inline still gets the last draw's rgb as `stageResult`. Needs Safelight 3.2.2.

- `region` limits each draw to a rectangle, for a pass whose draws each change a small part of the frame, such as a cascade that works on a shrinking grid. It is the body of `ivec4 passRegion()` and returns `ivec4(x0, y0, x1, y1)`: the draw writes the texels with `x0 <= x < x1` and `y0 <= y < y1`, in `ivec2(gl_FragCoord.xy)` coordinates, clipped to the frame. It can read the pass's uniforms, helpers, `uPassIndex`, `uPassCount` and `uTexel`. It runs in a vertex program, so the helpers it compiles with can't name `gl_FragCoord`, `discard`, `dFdx`, `dFdy` or `fwidth`, which exist only in fragment programs (your `glsl` can still use them). The contract check warns when a region pass's helpers or region name one. A texel outside the region keeps what that ping-pong target held two draws earlier, so the region must hold every texel this draw or the draw before it changes, and the draw before can be the previous pass's last. The stage's first two draws and its last are drawn whole, whatever the region says. Needs Safelight 3.2.2.

- `vec3 fetchInput(ivec2 texel)` returns the stage's input texel, linearized and in the stage's `space`. For `reads: "current"` that is the image up to your stage; for `reads: "source"` it is the source. It works on every draw, unlike `fetchPrev4`, whose input is gone after the first draw, and unlike `readSource`, which filters: it samples a mipmapped texture, so a pass whose fragments read far-apart positions gets a blurred level. A texel outside the frame reads the nearest edge texel. Use it to recompute the input at full precision instead of carrying it through the ping-pong. Needs Safelight 3.2.3.
  - For `reads: "current"`, Safelight keeps the image up to your stage in a full-size target of its own, at no extra draw.
  - A source uploaded at another size than the passes draw (a cached preview, say) is resampled once, as the first draw samples it, and stored at the pass format, so `fetchInput` agrees with the first draw's own read to half-float precision. That costs one draw each time the passes rerun.
  - Without float render targets, or once the GPU refuses that target (with one warning), the stage reads the source, as `reads: "current"` does then, and `fetchInput` reads the source texel each pass texel falls in. That is exact only for a source at the pass size.

- Each pass gets `uTexel` (1 / pass size), `uPassIndex`, `uPassCount`, `readPrev(uv)` (the previous pass, or the stage's input on the first), `uSrcLinear` (true for RAW float decodes) and `uSourceSize` (the decoded source's pixel size, 3.1.0).
- Passes run at a capped resolution. Scale a radius given in source pixels by `max(1.0 / uTexel.x, 1.0 / uTexel.y) / max(uSourceSize.x, uSourceSize.y)`.
- `iterations: { key, max }` reads the draw count from the bag each frame (3.0.1). 0 skips the pass. A stage whose passes all draw 0 times runs no passes that frame, so gate your inline `glsl` on the same condition.
- `keep: true` keeps the state after a pass, so a later frame in Develop can start from it. Safelight resumes from the last kept pass whose inputs are unchanged: the source, the size, the process version, the image upstream for `reads: "current"`, the code, uniform values and draw counts of that pass and every pass before it, and whether any later pass draws at all. Declare a uniform only on the passes that use it, and put the work that depends on few params first. A noise estimate then runs once per photo, and dragging a later pass's slider redraws only the passes after the last kept one before it. Needs Safelight 3.2.3; earlier versions ignore `keep` and draw every pass.
  - A resumed frame gives exactly the result a full run gives, as long as each pass's `region` follows the rule above: its draws keep their numbers, so the same ones are drawn whole.
  - Each kept pass holds a full-size target (about 90 MB at 4096 px) while the photo is open, and each mask copy keeps its own: three kept passes in five masks hold fifteen.
  - Only Develop's view keeps them. Exports and thumbnails draw each photo once, every pass.
  - A pass that nothing draws after keeps nothing. If the GPU refuses the target, the stage draws every pass, with one warning.
- Passes run while the bag holds a non-zero value for the stage, or a `{ key, max }` count resolves above 0. A non-zero default count therefore runs on every photo.
- An array uniform's value and default are all its numbers, flattened: `float uGain[8]` takes 8, `vec2 uPairs[3]` takes 6. A bag value of the wrong count binds the default. A `mat3` or `mat4` value is column-major.
- Passes can't read inter-stage variables.
- A pass that fails to compile takes its whole stage out of the frame, inline `glsl` included, so the stage draws as if it weren't installed. The Extensions window names the failure, and the stage is built again once you register it changed. Before 3.2.0 the inline `glsl` kept running and read the raw source as `stageResult`.

#### Passes: sizes, formats and cost

- **Size.** Passes draw at the size the frame develops from, not the screen. In Develop that's the source scaled so its long edge fits the user's render cap (**Preferences ▸ Performance ▸ Develop render resolution**, 2560 to 8192 pixels, 4096 by default). An export draws large enough for the requested size, up to the source's full size, and thumbnails draw smaller. `uTexel` gives the pass size and `uSourceSize` the decoded source's.
- **Radii.** Because the pass size changes between preview and export, a radius counted in pass texels covers a different part of the photo in each. Give radii in source pixels and scale them with the formula above, and the result matches between preview and export to within resampling.
- **Format.** The two ping-pong targets are RGBA16F (half float: about three significant digits, values up to 65504) when the GPU can render to float. Otherwise they're RGBA8 and every pass result is clipped to [0, 1]. A pass carries three channels, the `vec3 c`, or four with `channels: 4`.
- **Sampling.** Linear filtering, clamped to the edge, so a tap outside 0..1 reads the nearest edge pixel.
- **When passes rerun.** The result is cached, and passes draw again only when the source, the stage's own params, the size or, for `reads: "current"`, the image upstream of the stage changes. Moving an unrelated slider doesn't rerun them. With `keep`, a change that reaches only the passes after a kept one reruns only those.
- **Draws.** A pass draws at most 1024 times per frame, whatever `iterations` asks for.
- **No render graph.** Every draw of every pass is full size, into one of the same two targets, and reads only the previous draw (`readPrev`), the source (`readSource`) or the stage's input (`fetchInput`). There's no lower-resolution target, mip chain, multiple render targets or history of earlier draws. A mip-style bloom is built from widening à trous steps instead.
- **Cost.** Every draw is a full-image draw. A draw that reads hundreds of neighbours per pixel can run long enough for the operating system to reset the GPU, and Chromium then refuses WebGL for a couple of minutes. Keep each draw to tens of reads and spread a big kernel over several passes or iterations, for example an à trous blur that doubles its tap spacing each draw, as [Glow](https://github.com/anthonyreimche/Glow) and [Pyramid Local Contrast](https://github.com/anthonyreimche/Pyramid-Local-Contrast) do.
- **Direct3D 11.** On Windows, ANGLE translates your GLSL for Direct3D 11, and three patterns there make every draw cost what the whole shader costs. Together they made each draw of an uber-pass take about 60 ms instead of 0.5 ms at 4096 pixels.
  - A `const` array, such as `const float W[25] = float[](…)`, is copied into every pixel's scratch memory before anything else runs, on every draw. Compute the values in the shader, or pass them in as a uniform array. The contract check warns about a `const` array.
  - A local array indexed inside a loop also lives in that scratch memory. Keep the values in scalars or vectors, or unroll the loop from TypeScript.
  - A gradient op, `texture()` or anything else that takes screen-space derivatives, reached from a loop makes ANGLE flatten every `if` around that loop: each draw runs every branch. Read with `texelFetch`, or `textureLod` when you need filtering. `fetchPrev4`, `readPrev4` and `fetchInput` use no gradient op (from 3.2.3); `readPrev` and `readSource` call `texture()`, so in a loop use `fetchInput` or a four-channel pass's `fetchPrev4` instead.
- **Masks.** Each mask that uses a maskable stage gets its own copy of the stage, and the copy runs its passes separately. Five masks with your stage can mean six pass chains, and six sets of `keep` checkpoints. The stage and its copies whose passes are given exactly the same (the same source and size, and the same value for every uniform the passes declare and every draw count) draw one result between them, and the others read it: they draw nothing and take no texture unit or target (from 3.2.4). When the stage's values move away from its copies', for a slider drag or because the stage is switched off, the copies keep the result it last drew for them. In Develop, a copy whose passes up to a kept pass are given what the stage's are resumes from the stage's checkpoint and keeps none of its own, so a mask that changes only what later passes read costs only those passes. So keep the per-mask values (an amount, a position) to the passes after a kept one, and since a copy reads only the values its mask holds (defaults for the rest), write the photo's values for the early passes' uniforms into the mask as well. Resuming needs the stage itself to run on the photo; while it doesn't, each copy with values of its own draws all its passes.

### Textures

```typescript
interface TextureRequirement {
  key: string;
  kind: "lut" | "coverage" | "dynamic" | "photo" | "atlas" | "paint";
  width?: number; height?: number;
  format?: "rgba8" | "rgba16f" | "r8";
}
```

- **`lut` and `dynamic`** take pixels from `api.setStageTexture(stageId, key, data)`. There is one global copy, not one per photo, so they suit film LUTs, not per-photo data. Set them in `activate` or any time later (bump `version` to replace the data); they are dropped when the extension is disabled, updated or reloaded. In GLSL the texture is a `sampler2D` named by its `key`, in your `glsl` and `helpers` alike. There are no 3D textures, so a 3D LUT goes in as a 2D atlas of slices: see the [LUT recipe](../extensions/recipes.md#a-3d-lut). Only the extension that registered the stage can set its textures; the call is ignored with a warning otherwise. A texture is also refused with a warning, keeping the previous one, if its format is unknown, its size isn't positive whole numbers, its data doesn't match width × height × channels, or it is over 64 MB (256 MB across all of an extension's textures). One larger than the GPU's maximum texture size draws as blank.
- **Variants** (3.2.4) make a `lut` or `dynamic` texture per photo. `api.setStageTexture(stageId, key, data, variant)` files `data` under the name `variant` (1 to 64 letters, digits, `-` or `_`), beside the texture's other variants; clear one with `null` and its name. A photo whose param bag holds a variant's name under `"{stageId}.{key}"` draws with that variant, and one without draws with the plain texture. The name travels with the edit, so undo, presets, Copy/Paste, thumbnails and exports pick the same data, and every renderer holds every variant, uploading each to the GPU when a frame first draws with it. A name you have supplied no data for draws as opaque black, so put a marker texel in your data and leave the stage's work undone when it doesn't match. The size limits count every variant.
- **Variants on demand** (3.2.4) suit variants too many to hold at once, one per calibration master and blur radius, say. `api.setStageTextureProvider(stageId, key, provide)` hands core `provide(variant)`, which resolves with that variant's data (as `setStageTexture` takes it) or `null` when there is none. Core asks for a variant when a frame whose bag names it first needs it, once however many frames need it at the same time. Exports, `renderPhotoFrame`, float frames, edited thumbnails, the Library histogram and captures of the live photo (`captureFrame`, `captureFloatFrame`, `readDevelopedPixels`) wait for it; when `provide` throws or takes over 30 s, that photo fails with your error's message (an export lists it with its other failures) instead of drawing without it, and so does an export still running when your extension is turned off. A `null` draws without it, and isn't asked for again. The live Develop view never waits: it draws now and again once the variant lands. Provided variants count against the extension's 256 MB, and core lets go of the least recently drawn to make room, never one the open photo's bag names or a frame in flight draws with, and asks again when it is next needed; making room for a texture you set yourself lets go of provided variants first. `provide` gets an `AbortSignal` too, aborted once nothing needs the variant any more (one the live view passed by in a drag, with no frame waiting): skip work not started yet. While `api.develop.setViewValues` keeps the live view on another variant, core asks for the one the photo's own bag names and keeps both. To point the open photo at a variant without a frame drawn before it lands (a slider drag), `await api.prepareStageTextureVariant(stageId, key, variant)` first: it resolves once the variant is held, or rejects with the reason. When what a variant was made from changes, `api.dropStageTextureVariants(stageId, key, variant?)` lets go of it (of every variant of the key without `variant`), and it is asked for again. Pass `null` as `provide` to stop; the provider goes with the extension. Only the extension that set a provider can stop it or drop its variants. A provider set while a photo is open is asked at once for what that photo names.
- **`photo`** is for Safelight's own stages: their `derive` fills it per photo from the photo's params (the tone curve's table). Any other stage that declares one is refused.
- **`atlas`** is for Safelight's own stages too (3.2.0): `derive` returns up to four `{ id, dabs }` brush strokes under the texture's key, and core bakes them into the texture's four channels in order (Heal's brush spots).
- **`coverage`** is painted. The photo's bag value at `"{stageId}.{key}"` is a `BrushDab[]`, the same shape core brush masks use, and your inline `glsl` reads it as `float key(vec2 uv)` (0 to 1). It persists, undoes and exports like any edit. Replace the array when it changes (`[...dabs, dab]`); an array edited in place doesn't reach the renderer. Add dabs at the end while the brush moves: dabs appended to the list are baked and uploaded on their own, at the cost of the area they reach however many came before, while any other change (an undo, a dab edited or removed) bakes the texture again. Not readable inside passes.
- **`paint`** is painted in colour, on up to four layers (`MAX_PAINT_LAYERS`). The photo's bag value at `"{stageId}.{key}"` is a `PaintLayer[]`: `{ id, dabs }`, where each dab is a `BrushDab` plus `color: [r, g, b]`, display-encoded sRGB from 0 to 1. Other fields on a layer, such as a name, are left alone. A stroke lays its colour over the strokes before it by its coverage, an erase stroke takes coverage away, and a change of colour starts a new stroke. Your inline `glsl` reads layer *n* as `vec4 key(int layer, vec2 uv)`: its colour in `rgb` (not premultiplied) and its coverage in `a`, or `vec4(0.0)` where nothing is painted. A malformed layer reads as unpainted and keeps its place, so the layers after it keep their numbers. One paint texture per stage; it takes one of the four stage texture units `lut` and `dynamic` use. Replace the array when it changes, as for `coverage`. Not readable inside passes. Needs a Safelight build that has it: set `minAppVersion`.

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

Stages in `display-adjust`, `effects` and `output-encode` can read `float slSceneLuma`: the pixel's scene luminance before the core shoulder compressed it, for HDR or highlight-aware effects. It exists only in the inline `glsl` (pass it to helpers as an argument). On version 1 photos it carries no headroom. The shoulder is part of the Basic extension's tone block: while Basic is off, nothing compresses the luminance and `slSceneLuma` is what the transform receives. Needs Safelight 3.0.0.

### Process versions

Each edit stores `params.processVersion`, the rendering version it was made with, so old edits never change look.

- **Version 1:** edits made before versions existed. Frozen. Clips to [0, 1] at more points, and stages after the display transform get clipped values even with `space`.
- **Version 2:** every new edit. Keeps the full range after the display transform wherever no tool needs [0, 1]. Tools that need [0, 1] (Whites, Blacks, Contrast, Dehaze, Tone Curve, HSL, Vibrance, Saturation, Colour Grading, mask display edits) clip only while in use. Vignette and Grain don't clip.
- Users move a photo to the current version with **Update processing** or **Reset all edits**. Nothing else changes it.
- On a RAW, version 2 also applies the camera baseline after highlight reconstruction, and keeps what `decode` stages did when the denoiser runs. Version 1 loses it.
- Extensions read `processVersion` and never write it. When you render from params you pass in (`captureFrame`, `renderPhotoFrame`), start from a copy of the photo's own params: params without a version render as version 1.

#### Version-gated GLSL: `SL_PROCESS_VERSION`

A stage's GLSL can tell which process version it renders, so a fix that changes your output can apply to new edits and leave older photos as they were.

Every program Safelight compiles for a photo defines `SL_PROCESS_VERSION` as that photo's process version: `1`, `2` or `3`. It reaches your inline `glsl`, your `helpers` and your passes. Test it with the preprocessor:

```glsl
#if SL_PROCESS_VERSION >= 2
  c = max(c, 0.0);         // new edits: keep values above 1
#else
  c = clamp(c, 0.0, 1.0);  // older photos: the look they were edited with
#endif
```

- Put each directive on a line of its own.
- Compare with `>=`, not `==`: a later version keeps your version 2 path unless you add one for it.
- It is a compile-time constant, so the branch not taken costs nothing. Safelight builds a program per version, and a pass's result is kept per version too.
- Needs Safelight 3.2.0. Older builds don't define it, and `#if` on an undefined name fails to compile: set `minAppVersion` when you use it.

### Reading the current image: `reads`

A stage's passes normally start from the decoded source (`reads: "source"`), with none of the user's edits. `reads: "current"` starts them from the image as edited up to your stage, for tools that should respond to exposure, white balance and earlier stages.

- Safelight draws everything up to your stage into a float texture first. That costs one extra draw whenever something upstream changes. Dragging your own inline-only params is free.
- Works from `decode` through `display-adjust`. `effects` and `output-encode` readers all read the end of `display-adjust`.
- The extra draw skips crop and geometry. Stages that may sit ahead of a reader should key on `srcUv`.
- A `decode` or `noise-reduction` reader is redrawn only when the stages before it, the source or retouching change, not on Exposure or White Balance.
- Without float render targets the stage reads the source instead, with one warning. `reads: "current"` on a stage without passes, or on `geometry`, is ignored.
- Any pass can still sample the decoded source with `vec3 readSource(vec2 uv)`, on any draw. It returns what a `reads: "source"` stage's first read gets: linearized, in the stage's `space`. `readSource` itself adds no draw, but the extra draw `reads: "current"` asks for still runs, on every process version, even where a pass reads only `readSource`. Needs Safelight 3.2.0.
- `readsCurrentFrom: n` reads the current image only on photos of process version `n` and later. Older photos read the source, as a `reads: "source"` stage does: no extra draw, and the passes don't rerun when something upstream changes. Use it when a stage switches to reading the current image and older photos must keep their look. A whole number, 1 (every version) by default; ignored without `reads: "current"`. Needs Safelight 3.2.0.

```typescript
reads: "current",
readsCurrentFrom: 2, // version 1 photos read the source, as before
```

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

### Dormant stages: `dormantWhen`

A stage that declares `dormantWhen` is left out of the live view's develop program while it has nothing to do, so an installed but untouched tool costs no shader time. The rule maps uniform keys to values: the stage is dormant while every listed uniform's value (the photo's, or its `default`) equals the given one. List the switches that make the stage an exact no-op, for example `{ amount: 0 }`.

- Once a stage is needed, it stays in the program for the rest of the session, so moving between photos doesn't rebuild it again and again.
- Opening or hovering your panel starts building the program with your stages in it, in the background, so the first slider move rarely waits for a compile.
- It applies to the live view on version 2 photos. Thumbnails, exports and version 1 photos run every stage, as before.
- Prepasses follow the same rule.
- Declare it only where the stage is an exact no-op. Leaving a dormant stage out may differ from running it by float rounding, and nothing more.
- The rule is ignored, with a warning, on `geometry` and `noise-reduction` stages, stages that `produces` values, and patch stages. It is also ignored on display stages without a `space`, whose input is clipped on version 2 photos, unless they are official Safelight extensions' stages, which never are. A malformed rule refuses the stage.
- Older builds ignore the field and run the stage as before.

### Dynamic detail: `keepsDetail`

With **Dynamic** chosen as the render resolution, Develop adds the full-size photo's fine detail to the zoomed-in view, after the noise-reduction step. A stage in the decode or noise-reduction phase that writes the colour turns that off for a photo while it is at work there, because the detail would put back what a denoiser or a moiré filter took out.

A stage whose result keeps the photo's own detail in place, such as a chromatic-aberration or flat-field correction, sets `keepsDetail: true`, and the detail stays on. Leave it out for any stage that smooths or removes detail.

A stage is at work on a photo once the photo holds a value of its own that isn't zero or false and its passes draw. A stage with `dormantWhen` is at work while that rule doesn't hold. A stage that is only installed costs no photo its detail.

### View aids: `viewOnly`

`viewOnly: true` makes a stage a view aid, such as a focus or exposure overlay, that is drawn only in the frames the live Develop view shows. Everything else draws the photo without it, whatever the bag holds: exports, thumbnails, `renderPhotoFrame` and the other headless renders, captures and float captures (unless `asShown`), probes and colour pickers, the histogram, Auto Tone, Auto White Balance and Upright.

- Drive it with [`api.develop.setViewValues`](stores.md#apidevelop), not the photo's bag, so nothing of it is saved, undone, pasted or put in a preset, and turning it on doesn't mark the photo as edited.
- Nothing of it reaches a frame that leaves it out: the conversion into its `space`, and on version 2 the clip a display stage without a `space` is handed, happen inside its switch, so the frame is exactly the one drawn without the stage.
- Its passes still follow the bag, so they don't run while your view values are off. They never run, and hold no target or texture unit, in a frame that leaves the stage out, and a renderer that doesn't draw view aids never builds the program with it for its values. Turned off in the live view, it gives its result target back; turned on again, its passes run anew.
- A stage that reads the current image never sees a view aid in its input, so no measurement inherits one through a kept result.
- The live view runs its block in every frame, the aid off included. Read your result inside your own switch through your result sampler (`u_<prefix>_stageResult`, `textureLod`) rather than through `stageResult`, which the block fetches for every pixel whenever it names it.
- To have it appear the moment it is turned on, leave `dormantWhen` off: the stage then stays in the live view's program behind its uniforms, and turning it on builds no program. Call [`api.develop.prewarmStages`](stores.md#apidevelop) once the user is idle in Develop so its passes are built ahead too. `dormantWhen` instead leaves it out of the shader until it is first turned on, which rebuilds the program then.
- It is refused on `geometry` and `noise-reduction` stages (an extension's noise reduction replaces the built-in denoiser in exports too), on stages that `produces` values, and together with `mask`, `anchor` or `reads: "current"`.
- Needs Safelight 3.2.4. Older builds ignore the field and draw the stage everywhere: set `minAppVersion`.

### Masks

`mask: { maskable: true }` lets a stage run again inside local adjustments. A mask whose bag holds any of your stage's keys gets its own copy of the stage, right after it, bound to that mask's values and blended by its coverage. A [per-mask panel](ui-shell.md#per-mask-panels-panelcontributionmask) writes those keys.

- Only `scene-linear`, `tone-map`, `display-adjust`, `effects` and `output-encode` stages can be masked.
- Copies run on version 2 photos only.
- A copy shares the stage's textures and passes' programs, and the stage's pass results where its passes would be given the same values (see [Passes](#passes-sizes-formats-and-cost)). What it `produces` stays inside the copy.
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

Your section in **Preferences ▸ Extensions**. There is one per extension, so a second `registerSettings` call replaces the first. Read and write values with `api.settings.get/set`, watch them with `api.settings.onChange`.

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

interface ExportProcessorContext {
  longEdge: number | null;            // null = original size
  settings: Readonly<ExportOutput>;   // the output this export asks for (3.2.0)
}

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
- You can render more of the photo with `api.export.renderPhotos`; started from here, that render runs no export processors. Render with `context.longEdge` to match the file's pixel grid.
- **`context.settings`** (`ExportOutput`) is the output the user asked for: `format`, `quality`, `longEdge`, `tiffBitDepth`/`pngBitDepth`, `colorSpace`, `sharpenAmount`/`sharpenRadius`, `includeMetadata`/`includeLocation`, those fields of [`ExportSettings`](stores.md#apiexport). The delivery, the filename template and the other processors' settings are not in it. Pass it to `api.export.renderPhotos` to build your own render of the photo with the same output choices. An optional field that isn't there takes its default: sRGB, no sharpening, 8-bit, no metadata. It is frozen, so changing it doesn't change the export. Needs Safelight 3.2.0.
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

Handlers are awaited, one after another. One that throws, or doesn't finish within 60 seconds, is logged and skipped, so it can't break or stall an import or a save. When several `onPhotoImport` handlers return fields, the later ones win. When several photos are removed at once, `onPhotoRemove` may run for up to eight of them at the same time; the handlers for any one photo still run in order.

## `PresetImporterContribution`

```typescript
interface PresetImporterContribution {
  id: string; label: string;       // e.g. "Lightroom preset (.xmp)"
  extensions: string[];            // lowercase with dot, e.g. [".xmp"]
  parse(file: File): Promise<{ name: string; params: Partial<DevelopParams> } | null>;
}
```

Adds a file type to the Presets panel's Import picker. Several importers may claim the same extension: Safelight asks each in turn and uses the first that returns settings. Return `null` or empty `params` when nothing maps, and the panel tells the user. A `parse` that throws, or doesn't finish within 15 seconds, is reported as a failed import (with the error message) instead of "no settings". The picker only offers `.json` plus the extensions your importers claim. Params use Safelight's scales: exposure in EV, temperature in Kelvin, most sliders ±100. They are merged over the photo's current edit.

## `GridFilterContribution`

```typescript
interface GridFilterContribution {
  id: string;
  test(photo: CatalogPhoto): boolean; // false hides it from the grid and culling
  reads?: readonly (keyof CatalogPhoto)[]; // the photo fields test reads
  onClear?(): void;                   // called by Library "Clear filters"
}
```

Combined with the Library's own filters (AND). Re-register with the same id when your query changes.

Set `reads` to the photo fields `test` reads, by their top-level name: `["keywords"]`, or `["exif"]` for anything inside `photo.exif`. The grid then filters and sorts again only when one of those fields changes on some photo, or when you register the filter again. Without it, every rating, flag, keyword and background metadata read runs the filter and the sort over the whole catalogue, which a large one feels on each key press. While your filter is off and `test` passes every photo, register it with `reads: []`. Data `test` reads from outside the photo (a collection's members, a keyword tree) is yours to follow: register again when it changes.

## `LibrarySortContribution`

```typescript
interface LibrarySortContribution {
  id: string; label: string;          // id is also the saved sort id
  compare(a: CatalogPhoto, b: CatalogPhoto): number; // ascending; the toolbar flips it
  reads?: readonly (keyof CatalogPhoto)[]; // the photo fields compare reads
}
```

Adds an entry to the Library toolbar's sort menu. Set `reads` as for a grid filter: while your sort is the one in use, the grid then sorts again only when one of those fields changes.

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
