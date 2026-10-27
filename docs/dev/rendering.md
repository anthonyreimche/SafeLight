# How a photo is rendered

If your extension changes pixels, read this first. It explains what happens to a photo between the file and the screen, which values your code gets at each point, and how far an extension can take over colour handling.

## Overview

Every photo is drawn by a single GPU program, a large fragment shader that runs once for each output pixel. Safelight assembles this shader from its own processing blocks plus the GLSL that extensions register, and rebuilds it whenever the set of registered stages changes. The same shader draws the Develop view, thumbnails, captures and exports, so what you see in Develop is what gets exported.

The shader works in two halves, with the display transform in the middle:

- **Before the display transform**, the colour is a variable called `lin`, which holds linear light. Values are proportional to the light in the scene, so doubling a value makes it one stop brighter. Highlights can go well above 1.0, and colours outside the sRGB gamut show up as negative channel values.
- **After the display transform**, the colour is called `c`. It's sRGB-encoded, the values a screen expects, mostly between 0 and 1.

An extension can add processing stages to either half, or replace the display transform itself.

## The steps in order

```
 file
  │  Decode (CPU, in a worker)
  │    RAW:  linear float, camera colour matrix and as-shot white balance applied
  │    JPEG, PNG, TIFF: sRGB values
  ▼
 ┌─ GPU program, once per pixel ─────────────────────────────────────┐
 │                                                                    │
 │  1  Crop, straighten, transform: pick the source position srcUv    │
 │       ◆ geometry stages              move srcUv                    │
 │  2  Sample the image, apply heal and clone spots                   │
 │  3  Convert to linear light; RAW only: default tone baseline       │
 │                                                     colour is lin  │
 │       ◆ decode stages                                              │
 │       ◆ noise-reduction stages       replace the core denoiser     │
 │  4  Core noise reduction                                           │
 │  5  Highlight reconstruction (RAW), white balance, exposure,       │
 │     highlights and shadows with the tone shoulder,                 │
 │     the tone part of each mask                                     │
 │       ◆ scene-linear stages                                        │
 │       ◆ tone-map stages                                            │
 │                                                                    │
 │  6  DISPLAY TRANSFORM   c = pipelineToDisplay(lin)                 │
 │       ◆ registerPipeline replaces this step                        │
 │                                                       colour is c  │
 │  7  Whites, Blacks, Contrast, Dehaze, Clarity, Texture,            │
 │     Tone Curve, HSL, Vibrance, Saturation, Color Grading,          │
 │     Sharpening, the display part of each mask                      │
 │       ◆ display-adjust stages                                      │
 │       ◆ effects stages               core Vignette and Grain       │
 │       ◆ output-encode stages                                       │
 │  8  Output encode: convert to the output colour space,             │
 │     clip to [0, 1]                                                 │
 └────────────────────────────────────────────────────────────────────┘
  ▼
 screen, thumbnail or exported file
```

Each ◆ marks a phase where extension stages can run. Within a phase, stages run in order of their `priority`, lowest first, with 100 as the default. Vignette and Grain are stages themselves, registered by Safelight Core in the `effects` phase at priorities 50 and 60, so an `effects` stage at the default priority runs after both of them.

To see the actual shader layout for the open photo, including where your own stage landed, turn on the Developer Tools extension and open its **Pipeline** tab. See [Debugging](extensions/debugging.md).

## Which hook do I want?

Most pixel work is done with a processing stage, and the phase you pick depends on the kind of maths you're doing. Maths that models light, such as exposure, white balance or a colour matrix, belongs before the display transform in `scene-linear`. Maths written for display values, such as split toning or Lab adjustments, belongs after it in `display-adjust`.

| You want to... | Use | Phase |
|---|---|---|
| Change each pixel's colour with light-based maths (exposure, white balance, channel mixing, colour matrices) | [`registerProcessingStage`](api/contributions.md#processingstagecontribution--gpu-stage) | `scene-linear` |
| Change each pixel's colour with maths written for display values (split toning, Lab adjustments) | `registerProcessingStage` | `display-adjust` |
| Add an effect on top of the finished look (glow, grain, borders) | `registerProcessingStage` | `effects` |
| Use neighbouring pixels (blur, sharpen, denoise, local contrast) | a stage with `passes` | any colour phase |
| Warp the image (lens distortion, liquify) | a stage | `geometry` |
| Replace the tone mapper and the whole scene-to-screen rendering | [`registerPipeline`](api/contributions.md#pipelinecontribution--display-transform) | replaces step 6 |
| Change the exported file's pixels (mats, watermarks) | [`registerExportProcessor`](api/contributions.md#exportprocessorcontribution) with `processPixels` | after step 8, export only |
| Read the rendered image (scopes, analysis) | [`api.develop.captureFrame`](api/stores.md#apidevelop) | none |

If you're not sure, start with a single stage without passes in `scene-linear` or `display-adjust`. [Colour Correction](https://github.com/anthonyreimche/Colour-Correction) is a small real example: one `display-adjust` stage and the panel that drives it.

## Writing a stage

A stage is a piece of GLSL that reads and modifies the colour variable for its phase:

```js
api.registerProcessingStage({
  id: "com.example.warmth.stage",
  name: "Warmth",
  phase: "scene-linear",
  uniforms: [{ key: "amount", glslType: "float", default: 0, range: { min: -1, max: 1 } }],
  glsl: `lin *= vec3(1.0 + 0.2 * amount, 1.0, 1.0 - 0.2 * amount);`,
});
```

Things to know when writing the GLSL:

- **The variable depends on the phase.** It's `vec2 srcUv` (the position in the source image) in `geometry`, `vec3 lin` before the display transform, and `vec3 c` after it.
- **Uniforms are referred to by their `key`**, as `amount` is above. Safelight renames them behind the scenes, so two extensions can both use a uniform called `amount` without clashing.
- **Your code runs in its own block**, so local variables stay local. Shared functions go in `helpers`.
- **Built-in helpers** you can call: `luma()`, `srgbToLinear()` and `linearToSrgb()`.

## Per-photo settings: the param bag

Uniform values are stored with each photo. Alongside the regular develop settings, every photo's edit has a param bag, a flat map of extension values. A uniform's value is stored there under `"{stageId}.{key}"`, so the example above uses `"com.example.warmth.stage.amount"`. When the bag has no value for a key, the uniform's `default` is used.

You never bind uniforms yourself. Your panel writes to the bag, and the renderer picks up the new value on the next frame. Because the values are part of the edit, undo, history, copy and paste of settings, presets, syncing between windows and export all handle them without extra code.

This also means your stage must leave the image unchanged at its default values. Every registered stage runs on every photo, so a stage that alters the image at its defaults changes the look of photos people have already finished the moment they install your extension.

## The values you get

| | Before the display transform (`lin`) | After it (`c`) |
|---|---|---|
| Encoding | Linear light | sRGB-encoded |
| Primaries | Rec.709 (the same as sRGB) | Rec.709 |
| Range | Unclamped. Highlights above 1.0, out-of-gamut colours as negative channels. | Clipped to [0, 1] just before your stage, unless you declare `space` |
| Highlights | From `scene-linear` on, already rolled off by the core's tone shoulder, unless the display transform turns it off | Whatever the display transform made of them |

A few practical consequences:

- **Guard against negative channels.** They break `log`, `pow` and `sqrt`, so clamp a `lin` channel or use its absolute value before calling them.
- **Declare `space` if you need different values**, for example `space: { encoding: "linear", primaries: "rec2020" }`. Safelight converts the colour into that space before your GLSL runs and back afterwards. A display-phase stage that declares `space` also receives the unclipped values. See [Values a stage sees](api/contributions.md#values-a-stage-sees-space).
- **A display-phase stage without `space` clips the image for everything after it**, even when the stage itself does nothing. If your maths only needs [0, 1] while it's active, declare `space: { encoding: "perceptual" }`, which involves no conversion and no clip, and clamp inside your own `if` block. (Version 1 photos are clipped at that point anyway, see [Process versions](#process-versions).)

## Colour management: what you can and can't change

Safelight's colour handling has four parts. Extensions can take over some of them and work around the others.

| Part | Handled by | What an extension can do |
|---|---|---|
| **Input** (camera RGB to working space) | The RAW decoder, which applies the camera's colour matrix and the as-shot white balance | Can't replace the matrix. Out-of-gamut colours arrive as negative channels instead of being clipped, so a `decode` stage can still apply its own 3×3 correction. |
| **Working space** | The core: linear Rec.709 before the display transform, sRGB-encoded Rec.709 after it | A stage can ask for Rec.2020 or another encoding with `space`. The conversion in and out is exact. |
| **Scene to display** (tone and gamut mapping into sRGB) | The display transform, picked per photo in Develop's bottom bar | Supply your own with `registerPipeline`. With `skipBaseCurve` and `skipToneShoulder` set, it gets untouched scene-linear values and owns the whole rendering. It must return sRGB-encoded values. |
| **Output** (sRGB to the screen or file's space) | The core, once, at step 8: sRGB on screen; sRGB, Display P3, Adobe RGB or ProPhoto on export, with a matching ICC profile | Can't replace it. An `output-encode` stage runs just before it. Don't convert to the output space yourself, or the image gets converted twice. |

In practice, a colour management extension today is mostly a display transform with both skip flags set, plus stages that work in Rec.2020 through `space` where needed. [Advanced Rendering](https://github.com/anthonyreimche/Advanced-Rendering) ships ten display transforms and is a good place to see how they're written.

## Process versions

Every edit records the rendering version it was made with, in `params.processVersion`. Updating Safelight never changes the look of an existing edit, because old edits keep rendering with their own version.

- **Version 1** covers edits made before process versions existed. It's frozen, and it clips the colour to [0, 1] at more points along the way, so stages after the display transform get clipped values even if they declare `space`.
- **Version 2** is used for every new edit. It keeps the full range through the display half wherever no tool needs [0, 1].

Users move a photo to the current version with **Update processing** or **Reset all edits**. If your stage looks different on one photo than on another, check the photo's version first. Extensions can read `processVersion` but should never write it. [Process versions](api/contributions.md#process-versions) in the reference has the full list of differences.

## Further reading

- [How Safelight works](concepts.md) covers the core, how extensions are loaded, and what they can access.
- The [contribution reference](api/contributions.md#processingstagecontribution--gpu-stage) documents every field of a stage, including passes, textures, `reads`, masks and inter-stage variables.
- Real extensions worth reading: [Colour Correction](https://github.com/anthonyreimche/Colour-Correction) (one `display-adjust` stage and a panel), [Glow](https://github.com/anthonyreimche/Glow) (a stage with passes) and [Lens Correction](https://github.com/anthonyreimche/Lens-Correction) (stages in four phases, including `geometry`).
