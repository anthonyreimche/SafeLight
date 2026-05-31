// Integration seam for an optional libraw WASM build.
//
// A full RAW decoder (every compression scheme, per-camera color science) is a
// large C library. Rather than vendor a WASM blob the build can't verify, we
// expose a stable hook a real build can register against at runtime:
//
//   globalThis.__safelightLibRaw = {
//     async decode(buffer) { ... return { width, height, rgba } }
//   };
//
// When that hook is present (e.g. a libraw-wasm module loaded from /public or a
// future bundled artifact) the decoder prefers it; otherwise it returns null and
// the pipeline falls back to the in-house decoder, then the embedded preview.

export interface LibRawDecoded {
  width: number;
  height: number;
  rgba: Uint8ClampedArray; // 8-bit RGBA, row-major, top-left origin
}

export interface LibRawModule {
  decode(buffer: ArrayBuffer): Promise<LibRawDecoded | null>;
}

declare global {
  // eslint-disable-next-line no-var
  var __safelightLibRaw: LibRawModule | undefined;
}

let cached: LibRawModule | null | undefined;

// Resolve the registered libraw module once. Returns null when none is present.
export async function getLibRaw(): Promise<LibRawModule | null> {
  if (cached !== undefined) return cached;
  const mod = globalThis.__safelightLibRaw;
  cached =
    mod && typeof mod.decode === "function" ? mod : null;
  return cached;
}

// Test/runtime hook so a build can be registered (or reset) explicitly.
export function registerLibRaw(mod: LibRawModule | null): void {
  cached = mod ?? null;
  if (mod) globalThis.__safelightLibRaw = mod;
}
