# Local patches to the vendored libraw-wasm

The files here are a build of libraw-wasm (ybouane/LibRaw-Wasm) against LibRaw 0.22.1; see `vite.config.ts`. They are kept minified as built, except for the patches below. Re-apply them whenever the build is replaced, unless upstream has fixed them.

## 1. `index.js`: settle a call whose worker failed (2026-10-08)

`runFn` stores its promise's callbacks as `{ error: reject, return: resolve }`, but the `onmessage` handler destructures `{ return: r, throw: e }`. When the worker answers a failed call with `{ error: "…" }`, the handler calls `undefined(...)` and throws, so the call never settles. That happens on a wasm trap, an abort or a failed module load.

Patch: in the handler, `let{return:r,throw:e}=this.waitForWorker` becomes `let{return:r,error:e}=this.waitForWorker`. A failed call now rejects with the worker's message.

A call whose error carries no message still resolves `undefined`, as before. LibRaw's own C++ errors arrive that way.

Covered by `src/raw/libraw-wasm-wrapper.test.ts`. The same bug is in the published libraw-wasm 1.4 (`dist/index.js`).
