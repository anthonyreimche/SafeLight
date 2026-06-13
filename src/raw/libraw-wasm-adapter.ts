// Adapter around the bundled `libraw-wasm` build. Decodes a RAW file to a
// full-precision LINEAR float RGBA buffer (sensor data with real highlight
// headroom), using camera white balance and linear gamma so our shader pipeline
// owns all the tonal/WB work. Runs in libraw's Web Worker off the main thread.
//
// Requires the page to be cross-origin isolated (COOP/COEP) for libraw's shared
// memory — see vite.config.ts. If anything is unavailable, returns null and the
// caller falls back to the in-house decoder / embedded preview. It logs the
// reason so a silent fallback can be diagnosed.

import type { RawFloatImage } from "./decode";

type LibRawCtor = new () => {
  open(data: Uint8Array, settings?: Record<string, unknown>): Promise<void>;
  metadata(full?: boolean): Promise<Record<string, unknown>>;
  imageData(): Promise<unknown>;
};

let ctorPromise: Promise<LibRawCtor | null> | null = null;

async function getCtor(): Promise<LibRawCtor | null> {
  if (!ctorPromise) {
    ctorPromise = import("libraw-wasm")
      .then((m) => (m.default ?? null) as LibRawCtor | null)
      .catch((e) => {
        console.warn("[libraw] module import failed", e);
        return null;
      });
  }
  return ctorPromise;
}

// Why the most recent attempt did (not) use libraw — surfaced in the UI.
export let lastLibRawStatus = "not attempted";

const num = (v: unknown): number =>
  typeof v === "number" && isFinite(v) ? v : 0;

export async function decodeRawFloatViaLibRaw(
  buffer: ArrayBuffer,
): Promise<RawFloatImage | null> {
  if (typeof Worker === "undefined") {
    lastLibRawStatus = "no Worker support";
    console.warn("[libraw]", lastLibRawStatus);
    return null;
  }
  // What libraw actually needs is SharedArrayBuffer. On http(s) that means
  // cross-origin isolation (COOP/COEP); in Electron the app:// scheme can't
  // become crossOriginIsolated, so SAB is re-enabled via a feature flag
  // instead and crossOriginIsolated stays false. Gate on SAB itself.
  if (typeof SharedArrayBuffer === "undefined") {
    lastLibRawStatus = globalThis.crossOriginIsolated
      ? "no SharedArrayBuffer support"
      : "no SharedArrayBuffer (not cross-origin isolated — restart dev server for COOP/COEP)";
    console.warn("[libraw]", lastLibRawStatus);
    return null;
  }
  
  // Check if buffer is reasonable size (at least 1MB for a RAW file)
  if (buffer.byteLength < 1024 * 1024) {
    lastLibRawStatus = `file too small (${buffer.byteLength} bytes)`;
    console.warn("[libraw]", lastLibRawStatus);
    return null;
  }
  
  const Ctor = await getCtor();
  if (!Ctor) {
    lastLibRawStatus = "module failed to load";
    return null;
  }

  const raw = new Ctor();
  try {
    await raw.open(new Uint8Array(buffer), {
      outputBps: 16,
      useCameraWb: true,
      outputColor: 1,
      gamm: [1, 1],
      // No content-driven auto-brighten: it scaled each image so ~1% of pixels
      // clipped to white, destroying exactly the data Highlights recovery needs
      // (and made baseline brightness vary per image). LR uses a fixed baseline.
      // NOTE: images now decode slightly darker than before — that's the removed
      // auto-gain, not a regression; compensate (if desired) via base curve.
      noAutoBright: true,
      userQual: 3,
      // Blend-reconstruct clipped highlights from the unclipped channels (dcraw
      // mode 2) instead of clipping to flat white — closest to LR's recovery of
      // near-blown detail. Modes 3+ (rebuild) can paint magenta; 2 is safe.
      highlight: 2,
      noAutoScale: false,
    });
    const meta = await raw.metadata(false);
    const px: unknown = await raw.imageData();

    // imageData() may return undefined on WASM errors even if metadata succeeded
    if (!px) {
      lastLibRawStatus = "imageData returned undefined (WASM error)";
      console.warn("[libraw]", lastLibRawStatus, "metadata =", meta);
      return null;
    }

    // imageData may be a bare typed array of pixels or an object carrying dims.
    let pixels: Uint8Array | Uint16Array;
    let width = 0;
    let height = 0;
    const obj = px as { data?: unknown; width?: unknown; height?: unknown };
    if (obj && obj.data && (obj.width || obj.height)) {
      pixels = obj.data as Uint8Array | Uint16Array;
      width = num(obj.width);
      height = num(obj.height);
    } else {
      pixels = px as Uint8Array | Uint16Array;
      width = num(meta.width) || num(meta.iwidth) || num(meta.raw_width);
      height = num(meta.height) || num(meta.iheight) || num(meta.raw_height);
    }

    if (width < 2 || height < 2 || !pixels || !("length" in pixels)) {
      lastLibRawStatus = "decoded but missing dimensions";
      console.warn("[libraw] missing dims; metadata =", meta, "px =", px);
      return null;
    }

    // Check if pixel data size is reasonable (at least 1 byte per pixel)
    if (pixels.length < width * height) {
      lastLibRawStatus = `insufficient pixel data (${pixels.length} bytes for ${width}×${height})`;
      console.warn("[libraw]", lastLibRawStatus);
      return null;
    }

    const n = width * height;
    // LibRaw may return 3-channel (RGB) or 4-channel (RGBX) data. Use the
    // actual per-pixel stride for the loop so RGBX data isn't misread as RGB.
    const stride = pixels.length >= n * 4 ? 4
                 : pixels.length >= n * 3 ? 3
                 : pixels.length >= n     ? 1
                 : 0;
    if (stride === 0) {
      lastLibRawStatus = `pixel/size mismatch (${pixels.length} for ${width}x${height})`;
      console.warn("[libraw]", lastLibRawStatus);
      return null;
    }
    const inv = pixels instanceof Uint16Array ? 1 / 65535 : 1 / 255;
    const data = new Float32Array(n * 4);
    for (let i = 0, o = 0, s = 0; i < n; i++, o += 4, s += stride) {
      const r = pixels[s] * inv;
      const g = stride >= 3 ? pixels[s + 1] * inv : r;
      const b = stride >= 3 ? pixels[s + 2] * inv : r;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 1;
    }
    lastLibRawStatus = `libraw ${pixels instanceof Uint16Array ? 16 : 8}-bit ${stride}ch ${width}×${height}`;
    console.info("[libraw] decoded", lastLibRawStatus);
    return { data, width, height };
  } catch (e) {
    lastLibRawStatus = `decode error: ${e instanceof Error ? e.message : String(e)}`;
    console.warn("[libraw] decode failed", e);
    return null;
  }
}
