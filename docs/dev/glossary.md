# Glossary

The words these docs use, in plain terms. Imaging terms first, then Safelight's own.

## Imaging and GPU terms

| Term | Meaning |
|---|---|
| **Linear light** | Pixel values proportional to the amount of light. Doubling a value makes it one stop brighter. Maths that models light (exposure, white balance, colour mixing) is simplest here. |
| **Display-encoded, sRGB-encoded** | Values passed through the sRGB curve, the way a screen expects them, mostly from 0 to 1. Maths written for "how it looks" (curves, split toning) usually assumes these. |
| **Primaries, gamut** | The red, green and blue a colour space is built on, and the range of colours they can make. Safelight works in Rec.709 (the same primaries as sRGB). Colours outside it show up as negative channel values. |
| **Clipping** | Cutting values off at 0 or 1. Detail beyond the limit is lost for every step after it. |
| **Display transform, tone mapper** | The step that turns scene light, which can be far brighter than 1.0, into values a screen can show. Users pick one per photo in Develop's bottom bar. |
| **Shader, GLSL** | A small program that runs on the GPU. Safelight draws a photo with one fragment shader that runs once for each output pixel. GLSL is the C-like language it's written in. |
| **Uniform** | An input to a shader that has the same value for every pixel, such as a slider's value. |
| **Texture, LUT** | An image or table the shader can read from. A LUT (lookup table) maps input colours to output colours. |
| **Pass** | An extra full-image draw before the main one, for work that needs neighbouring pixels, such as blurs. |

## Safelight terms

| Term | Meaning |
|---|---|
| **Core** | The part of Safelight that's always there: projects, the catalogue, RAW decoding, the renderer, edit history, export, the window and the extension manager. |
| **Extension** | A folder with a `safelight.json` and a JavaScript file. Almost every tool, including the stock ones, is an extension. |
| **Essentials** | The extensions that make up Safelight's standard editor: Library, Develop, Basic, White Balance, Tone Curve, HSL, Crop, Masking and the rest. They're installed on first launch and can be updated, rolled back or turned off like any other. |
| **Manifest** | `safelight.json`: the extension's id, name, version and the file to load. |
| **`activate(api)`** | The function your extension exports. Safelight calls it when the extension starts and passes in `api`, which is everything you can use. |
| **Contribution, `register*`** | Something your extension adds, such as a panel, stage, theme or shortcut. Every `register*` call adds one. Safelight removes them all when the extension stops. |
| **Module** | A top-level view with its own tab, such as Library, Develop or Map. |
| **Panel** | A dockable box of UI inside a module. Users can drag, hide and rearrange panels. |
| **Slot** | A named spot in Safelight's own UI where an extension can add a component, such as the Develop toolbar. |
| **Processing stage** | A piece of GLSL an extension adds to the shader that draws every photo. |
| **Phase** | Where in the processing order a stage runs, such as `scene-linear` or `display-adjust`. See [How a photo is rendered](rendering.md). |
| **`lin`, `c`, `srcUv`** | The variable a stage changes: `lin` is the linear colour before the display transform, `c` the display-encoded colour after it, and `srcUv` the position in the source image for geometry stages. |
| **Param bag** | The per-photo store for extension values, saved in the photo's edit next to the stock settings. Keys look like `"{stage id}.{uniform key}"`. Undo, presets, copy and paste and export all include it. |
| **Param scope** | What a panel reads and writes through `api.develop.useParamScope()`: the photo's param bag, or a mask's when the panel is shown inside a mask. |
| **Process version** | The rendering version an edit was made with. Old edits keep their look when Safelight updates. See [Process versions](rendering.md#process-versions). |
| **Dev folder** | A folder on your disk that Safelight loads extensions from directly, for testing without publishing. Needs the Developer Tools extension. See [Debugging](extensions/debugging.md). |
| **Store, registry** | The in-app list of extensions, built from GitHub repos tagged `safelight-extension`. The trust registry marks reviewed extensions as verified and can ban harmful ones. |

## Web and build terms

| Term | Meaning |
|---|---|
| **ES module (ESM)** | A JavaScript file that uses `export` and `import`. Safelight loads your `main` file as one. |
| **Bundle, bundler** | A bundler (Vite, rolldown, esbuild) combines your source files and npm packages into one file. You only need one for TypeScript, JSX or npm packages. |
| **External** | A package the bundler leaves out of the bundle. React must be external, because Safelight passes in its own copy as `api.react`. |
| **Zustand store** | The state containers Safelight's UI uses. `api.stores.useDevelopStore` and the others are hooks you call in a component, or `.getState()` outside one. |
