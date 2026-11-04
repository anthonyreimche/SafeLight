# Recipes

Short, complete examples for the jobs people ask about most. Each one works as the whole `index.js` of a no-build extension (see [Your first extension](first-extension.md) for the folder layout and the reload loop). Swap `com.example` for your own id.

← [Building Extensions](README.md)

| Recipe | Uses |
|---|---|
| [A Library right-click item that adds a keyword](#library-menu-item-that-adds-a-keyword) | `registerGridMenuItem`, `useCatalogStore` |
| [A copyright stamp on export](#copyright-stamp-on-export) | `registerExportProcessor` with `processPixels` |
| [A sidecar file next to each photo](#a-sidecar-file-next-to-each-photo) | `registerCatalogHooks` |
| [A 3D LUT](#a-3d-lut) | a stage with a `lut` texture, `setStageTexture` |
| [A theme](#a-theme) | `registerTheme` |
| [A slider that changes the photo](first-extension.md) | a stage, a panel and `useParamScope` |

## Library menu item that adds a keyword

```js
export function activate(api) {
  const catalog = () => api.stores.useCatalogStore.getState();

  api.registerGridMenuItem({
    id: "com.example.client-pick.mark",
    label: (ids) => (ids.length > 1 ? `Mark ${ids.length} as client pick` : "Mark as client pick"),
    onClick: (ids) => catalog().addKeywords(ids, ["client pick"]),
  });
}
```

- The item appears in the Library grid's right-click menu, under the core items. `ids` are the photos it applies to: the selection, or the photo you right-clicked.
- `addKeywords` saves the change to the catalogue, updates other windows and fires every extension's `onMetadataChange` hook. The same store has `removeKeywords`, `applyRating`, `applyColorLabel` and `applyFlag`. See [useCatalogStore](../api/stores.md#usecatalogstore).

## Copyright stamp on export

```js
export function activate(api) {
  api.registerExportProcessor({
    id: "com.example.copyright-stamp",
    label: "Copyright stamp",
    settings: [
      { key: "on", label: "Add stamp", type: "boolean", default: false },
      { key: "text", label: "Text", type: "string", default: "© Your Name" },
    ],
    async processPixels(frame, photo, settings) {
      if (!settings.on) return;
      const { width, height, data } = frame;
      const size = Math.round(Math.min(width, height) * 0.03);

      // Draw the text as an alpha mask, then blend it into the 16-bit pixels.
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      ctx.font = `${size}px sans-serif`;
      ctx.textAlign = "right";
      ctx.fillStyle = "#fff";
      ctx.fillText(String(settings.text), width - size, height - size);
      const mask = ctx.getImageData(0, 0, width, height).data;

      for (let i = 0; i < mask.length; i += 4) {
        const a = (mask[i + 3] / 255) * 0.6;
        if (a === 0) continue;
        for (let ch = 0; ch < 3; ch++) data[i + ch] += (65535 - data[i + ch]) * a;
      }
    },
  });
}
```

- The processor gets its own section in the Export panel, built from `settings`. It runs on every export, so keep a switch like `on` and return early when it's off.
- `processPixels` gets the pixels before encoding: RGBA, top to bottom, 0 to 65535, already in the file's colour space. Change `frame.data` in place. The file keeps its bit depth, ICC profile and metadata.
- Prefer it to `process`, which receives the encoded file. Re-encoding that file in a canvas drops the embedded ICC profile and EXIF.
- This draws on the full-size image in JavaScript, which takes a moment on large exports. Draw only the box around the text if speed matters.
- This stamps pixels only. **Preferences ▸ Export ▸ Include metadata** copies the photo's camera EXIF into the file, but there's no helper for adding fields of your own, such as a copyright notice. A `process` step could write them into the encoded file itself.

## A sidecar file next to each photo

```js
export function activate(api) {
  api.registerCatalogHooks({
    id: "com.example.sidecar",
    async onPhotoImport({ dir, fileName }) {
      const data = await readSidecar(dir, fileName);
      return data ? { rating: data.rating, keywords: data.keywords } : undefined;
    },
    async onMetadataChange({ photos }) {
      for (const photo of photos) {
        if (photo.copyOf) continue;              // virtual copies share the master's file
        queueWrite(photo);                       // don't hold up the change; see below
      }
    },
    async onPhotoRemove({ photo, dir, fileName }) {
      if (photo.copyOf) return;
      if (await fileExists(dir, fileName)) return; // removed from the catalogue only
      await deleteSidecar(dir, fileName);
    },
  });
}

async function readSidecar(dir, fileName) {
  try {
    const handle = await dir.getFileHandle(`${fileName}.json`);
    return JSON.parse(await (await handle.getFile()).text());
  } catch {
    return null;
  }
}

async function writeSidecar(dir, fileName, data) {
  const handle = await dir.getFileHandle(`${fileName}.json`, { create: true });
  const out = await handle.createWritable();
  await out.write(JSON.stringify(data, null, 2));
  await out.close();
}
```

`queueWrite`, `fileExists` and `deleteSidecar` are left to you. Things that catch people out:

- **`onPhotoRemove` fires for both** removing a photo from the catalogue and deleting it from disk. Only delete your sidecar when the image itself is gone, or a catalogue clean-up wipes the user's data.
- **Virtual copies** (`photo.copyOf` is set) point at the same file as their master. Skip them, or a copy overwrites the master's sidecar.
- **Hooks run inside the change.** A slow write delays the user's action, and a hook gets 60 seconds before it's abandoned. Queue writes and do them in the background, as [XMP Tools](https://github.com/anthonyreimche/XMP-Tools) does.
- `dir` is a `FileSystemDirectoryHandle` for the photo's folder. There's no access by path. On a read-only folder, writes fail, so catch errors.

## A 3D LUT

WebGL2 stages get 2D textures only, so a 3D LUT goes in as a 2D atlas: the blue slices laid side by side. The stage samples it with trilinear interpolation it does itself.

```js
const STAGE = "com.example.lut.stage";
const N = 17; // LUT size per axis

export function activate(api) {
  api.registerProcessingStage({
    id: STAGE,
    name: "LUT",
    phase: "effects",
    space: { encoding: "perceptual" },
    uniforms: [{ key: "amount", glslType: "float", default: 0, range: { min: 0, max: 1 } }],
    textures: [{ key: "lut", kind: "lut", width: N * N, height: N, format: "rgba16f" }],
    helpers: `
      vec3 lutFetch(vec3 i) {
        return texture(lut, vec2((i.b * ${N}.0 + i.r + 0.5) / ${N * N}.0, (i.g + 0.5) / ${N}.0)).rgb;
      }
      vec3 lutSample(vec3 rgb) {
        vec3 p = clamp(rgb, 0.0, 1.0) * ${N - 1}.0;
        vec3 i0 = floor(p), f = p - i0, i1 = min(i0 + 1.0, ${N - 1}.0);
        vec3 x00 = mix(lutFetch(i0), lutFetch(vec3(i1.r, i0.g, i0.b)), f.r);
        vec3 x10 = mix(lutFetch(vec3(i0.r, i1.g, i0.b)), lutFetch(vec3(i1.r, i1.g, i0.b)), f.r);
        vec3 x01 = mix(lutFetch(vec3(i0.r, i0.g, i1.b)), lutFetch(vec3(i1.r, i0.g, i1.b)), f.r);
        vec3 x11 = mix(lutFetch(vec3(i0.r, i1.g, i1.b)), lutFetch(i1), f.r);
        return mix(mix(x00, x10, f.g), mix(x01, x11, f.g), f.b);
      }`,
    glsl: `
      if (amount > 0.0 && textureSize(lut, 0).x >= ${N * N}) {
        c = mix(c, lutSample(c), amount);
      }`,
  });

  // Fill the atlas: rgba16f takes a Float32Array of 4 floats per texel.
  const data = new Float32Array(N * N * N * 4);
  for (let b = 0; b < N; b++)
    for (let g = 0; g < N; g++)
      for (let r = 0; r < N; r++) {
        const i = (g * N * N + b * N + r) * 4;  // row g, column b * N + r
        const [R, G, B] = myLook(r / (N - 1), g / (N - 1), b / (N - 1));
        data.set([R, G, B, 1], i);
      }
  api.setStageTexture(STAGE, "lut", { data, width: N * N, height: N, format: "rgba16f", version: 1 });
}

function myLook(r, g, b) {
  return [r, g * 0.97, b * 0.9]; // replace with values parsed from a .cube file
}
```

- In GLSL the texture is a `sampler2D` named by its `key`.
- A `lut` texture is one copy shared by every photo, not a per-photo value. To let each photo pick a different LUT, store the choice as a uniform and pack the LUTs you offer into one atlas, or keep to one LUT at a time.
- Call `setStageTexture` again with a higher `version` to swap the data. You can call it any time, not only from `activate`.
- The `textureSize` check leaves the image untouched until data arrives.
- A .cube file lists red fastest, then green, then blue, which is the loop order above. A file the user picks can be read with `<input type="file">` in your panel and kept with `api.settings`.
- [JPG Tone Match](https://github.com/anthonyreimche/JPG-Tone-Match) is a full working example, including keeping values outside 0..1.

## A theme

```js
export function activate(api) {
  api.registerTheme({
    id: "com.example.theme.dusk",
    name: "Dusk",
    colorScheme: "dark",
    vars: { "--color-surface-0": "#14121a", "--color-accent": "#c08cff" },
  });
}
```

Pick it under **Preferences ▸ Interface ▸ Theme**. Variables you leave out keep the stock values. The full list is in [Theming tokens](../api/components.md#theming-tokens), and [Slate Theme](https://github.com/anthonyreimche/Slate-Theme) is a complete one.
