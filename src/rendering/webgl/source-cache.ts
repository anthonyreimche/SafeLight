// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Decoded sources kept resident on the GPU, keyed by sourceKey (photo id +
// decode variant), so re-opening a photo or re-rendering its (edited)
// thumbnail reuses the uploaded texture instead of decoding and uploading
// again. Bounded by a byte budget with LRU eviction; the bound source is
// pinned. Also the source upload's own helpers: the caps that bound a texture
// to the develop edge, the hand-built float mip chain and the search image.

import { halfToFloat32, halfToFloatTable } from "@/raw/half-float";
import type { StoredSample } from "@/rendering/source-sample";
import { created, setSampling } from "./gl-resources";

// Default GPU source-cache budget (bytes) before LRU eviction kicks in. Overridable
// per renderer via setCacheBudget (driven by the gpuSourceCacheBytes preference).
const DEFAULT_SOURCE_CACHE_BYTES = 512 * 1024 * 1024;

// Long edge of the CPU source search image (source-pixels.ts) (and the disabled content-aware
// fill). The picker searches the pyramid level that suits each spot, so this
// only sets how fine the smallest spots are matched: at 1024 a 0.004-radius
// dust spot still spans several pixels.
export const FILL_EDGE = 1024;

// How far a cached source's aspect may stray from its decoded frame's before a
// completed entry's size and sample are refused for it. The preview's own
// rounding stays far inside this; a frame turned the other way does not.
const SAMPLE_ASPECT_TOLERANCE = 0.01;

/** The 8-bit search image of a source (source-pixels.ts). */
export interface SourceFill {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

// A decoded source kept resident on the GPU. `tex` is owned by the cache; its
// derived render state is restored verbatim on bind so a re-open matches the
// original decode exactly.
export interface SourceEntry {
  tex: WebGLTexture;
  width: number;
  height: number;
  linear: boolean;
  applyBaseCurve: boolean;
  baselineGain: number;
  baselineShadows: number;
  isFallbackPreview: boolean;
  // The decoded frame's size before the upload cap, and the native-resolution
  // centre of a live float decode or of the cache entry a float16 source came
  // from (source-sample.ts); null for anything else.
  fullWidth: number;
  fullHeight: number;
  sample: StoredSample | null;
  fill: SourceFill | null;
  // The output-size cap this source was uploaded with. Restored on bind so a
  // cache-hit render doesn't inherit a stale cap from the previously-active
  // source (which sized the output wrong — the export-bug class).
  maxEdge: number;
  bytes: number;
  lastUsed: number;
}

/** A source as an upload leaves it, before the cache sizes and stamps it. */
export type UploadedSource = Omit<SourceEntry, "bytes" | "lastUsed">;

export class SourceCache {
  private readonly gl: WebGL2RenderingContext;
  private readonly entries = new Map<string, SourceEntry>();
  private budget = DEFAULT_SOURCE_CACHE_BYTES;
  private tick = 0;
  private boundKey: string | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /** The bound source's key, which eviction never takes; null while the
   *  renderer draws a texture of its own. */
  get bound(): string | null {
    return this.boundKey;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Sets the LRU byte budget; evicts immediately if already over. */
  setBudget(bytes: number): void {
    this.budget = Math.max(0, bytes);
    this.evict();
  }

  /** Takes `entry`'s texture and holds it under `key`; bind() draws it.
   *  Nothing is evicted until evict(). */
  add(key: string, entry: UploadedSource): void {
    // RGBA16F (float RAW, fresh or cached) = 8 bytes/px; 8-bit bitmap = 4 — the
    // format the upload actually took. ×4/3 accounts for the mip chain. The
    // sample sits in memory beside the texture (up to 8 MB), so the budget counts it.
    const texture = Math.round(entry.width * entry.height * (entry.linear ? 8 : 4) * (4 / 3));
    this.entries.set(key, {
      ...entry,
      bytes: texture + (entry.sample?.data.byteLength ?? 0),
      lastUsed: ++this.tick,
    });
  }

  /** The entry under `key`, now the bound source, or undefined when none is resident. */
  bind(key: string): SourceEntry | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    e.lastUsed = ++this.tick;
    this.boundKey = key;
    return e;
  }

  /** No source is bound: the renderer draws a texture of its own. */
  unbind(): void {
    this.boundKey = null;
  }

  /** Forgets `key`'s entry. A bound entry's texture is left alive and the
   *  source unbound, and true says the caller owns that texture now. */
  drop(key: string): boolean {
    const e = this.entries.get(key);
    if (!e) return false;
    this.entries.delete(key);
    if (this.boundKey !== key) {
      this.gl.deleteTexture(e.tex);
      return false;
    }
    this.boundKey = null;
    return true;
  }

  /** Hands the resident entry under `key` its decoded size and centre sample.
   *  Refused, with nothing changed, for a key not resident, for an entry that
   *  already has a sample or is not a linear decode, for a size that is not
   *  positive and finite, and for a size whose aspect disagrees with the
   *  entry's. Nothing is evicted until evict(). */
  attachSample(key: string, fullWidth: number, fullHeight: number, sample: StoredSample): boolean {
    if (!(fullWidth > 0 && fullHeight > 0)) return false;
    const e = this.entries.get(key);
    if (!e || e.sample || !e.linear || e.isFallbackPreview) return false;
    const aspect = fullWidth / fullHeight;
    if (!Number.isFinite(aspect) || !(Math.abs(e.width / e.height - aspect) <= SAMPLE_ASPECT_TOLERANCE * aspect)) return false;
    e.fullWidth = fullWidth;
    e.fullHeight = fullHeight;
    e.sample = sample;
    e.bytes += sample.data.byteLength;
    return true;
  }

  /** Evicts least-recently-used entries until the budget holds, never the bound one. */
  evict(): void {
    let total = 0;
    for (const e of this.entries.values()) total += e.bytes;
    if (total <= this.budget) return;
    const ordered = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, e] of ordered) {
      if (total <= this.budget) break;
      if (key === this.boundKey) continue;
      this.gl.deleteTexture(e.tex);
      this.entries.delete(key);
      total -= e.bytes;
    }
  }

  /** Frees every resident texture, the bound one's included. */
  dispose(): void {
    for (const e of this.entries.values()) this.gl.deleteTexture(e.tex);
    this.entries.clear();
  }
}

/** A texture for a source upload: mipmapped, as Texture/Clarity/Dehaze take a
 *  cheap multi-scale blur from it (textureLod). */
export function createSourceTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = created(gl.createTexture());
  gl.bindTexture(gl.TEXTURE_2D, tex);
  setSampling(gl, gl.TEXTURE_2D, gl.LINEAR, gl.LINEAR_MIPMAP_LINEAR);
  return tex;
}

// Box-halve an RGBA Float32 image (linear space). Used to build a float mip chain
// by hand: WebGL2 cannot generateMipmap on RGBA16F without float colour buffers,
// but it can sample manually supplied float mip levels with trilinear filtering,
// which the local-contrast taps (Texture/Clarity/Dehaze/Sharpen) need. Working in
// 16-bit float keeps real precision and HDR headroom so a big exposure push
// doesn't posterize into bands.
function halveRGBAF(src: Float32Array, w: number, h: number) {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = new Float32Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
      const i00 = (y0 * w + x0) * 4, i01 = (y0 * w + x1) * 4;
      const i10 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
      const o = (y * nw + x) * 4;
      for (let k = 0; k < 4; k++) {
        out[o + k] = (src[i00 + k] + src[i01 + k] + src[i10 + k] + src[i11 + k]) * 0.25;
      }
    }
  }
  return { data: out, w: nw, h: nh };
}

// halveRGBAF over half floats, each read as the float it holds, with the same
// arithmetic: the level is the one halving their floats gives, bit for bit.
function halveRGBA16(src: Uint16Array, w: number, h: number) {
  const t = halfToFloatTable();
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = new Float32Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
      const i00 = (y0 * w + x0) * 4, i01 = (y0 * w + x1) * 4;
      const i10 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
      const o = (y * nw + x) * 4;
      for (let k = 0; k < 4; k++) {
        out[o + k] = (t[src[i00 + k]] + t[src[i01 + k]] + t[src[i10 + k]] + t[src[i11 + k]]) * 0.25;
      }
    }
  }
  return { data: out, w: nw, h: nh };
}

/** One level of a source's mip chain: RGBA floats, or half floats as a cache
 *  stores them. */
export interface MipLevel {
  data: Float32Array | Uint16Array;
  w: number;
  h: number;
}

/** A linear source's mip levels, level 0 first: the image as given, then each
 *  box-halved from the one before, down to 1×1, as Float32. Level 1 reads a
 *  cached preview's halves as the floats they hold, so its chain is the one
 *  those floats give. */
export function* mipChain(data: Float32Array | Uint16Array, w: number, h: number): Generator<MipLevel> {
  yield { data, w, h };
  if (w <= 1 && h <= 1) return;
  let level = data instanceof Uint16Array ? halveRGBA16(data, w, h) : halveRGBAF(data, w, h);
  yield level;
  while (level.w > 1 || level.h > 1) {
    level = halveRGBAF(level.data, level.w, level.h);
    yield level;
  }
}

/** Uploads a linear image into the bound texture as RGBA16F, with its mip
 *  chain built by hand (trilinear taps for Texture/Clarity/Dehaze/Sharpen).
 *  Half floats go up as HALF_FLOAT: RGBA16F holds the very halves FLOAT of
 *  their floats would round to, without a whole-image conversion first. */
export function uploadFloatMips(gl: WebGL2RenderingContext, data: Float32Array | Uint16Array, w: number, h: number): void {
  let level = 0;
  for (const m of mipChain(data, w, h)) {
    const type = m.data instanceof Uint16Array ? gl.HALF_FLOAT : gl.FLOAT;
    gl.texImage2D(gl.TEXTURE_2D, level++, gl.RGBA16F, m.w, m.h, 0, gl.RGBA, type, m.data);
  }
}

/** capFloatToEdge for a cached preview's halves: kept as they are when they
 *  fit, so neither the upload nor the search image converts them; otherwise
 *  their floats, averaged down as a decode's are. */
export function capHalfToEdge(
  data: Uint16Array,
  W: number,
  H: number,
  maxEdge: number,
): { data: Float32Array | Uint16Array; width: number; height: number } {
  if (Math.min(1, maxEdge / Math.max(W, H)) >= 1) return { data, width: W, height: H };
  return capFloatToEdge(halfToFloat32(data), W, H, maxEdge);
}

// Box-average a linear Float32 RGBA image down so its long edge ≤ maxEdge.
// Returns the input unchanged when it already fits. Bounds the GPU texture,
// the hand-built float mip chain, AND the source-pixels copy to the develop cap —
// without this a full-res sensor decode (e.g. 24MP NEF → 384 MB Float32) was
// uploaded whole, OOMing low-RAM machines even though the canvas was capped.
export function capFloatToEdge(
  data: Float32Array,
  W: number,
  H: number,
  maxEdge: number,
): { data: Float32Array; width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(W, H));
  if (scale >= 1) return { data, width: W, height: H };
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * H) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * H) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * W) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * W) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const si = (sy * W + sx) * 4;
          r += data[si]; g += data[si + 1]; b += data[si + 2]; a += data[si + 3]; n++;
        }
      }
      const di = (y * w + x) * 4;
      out[di] = r / n; out[di + 1] = g / n; out[di + 2] = b / n; out[di + 3] = a / n;
    }
  }
  return { data: out, width: w, height: h };
}

export function downsampleDrawable(img: TexImageSource, W: number, H: number): SourceFill {
  const scale = Math.min(1, FILL_EDGE / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const c: HTMLCanvasElement | OffscreenCanvas =
    typeof document !== "undefined"
      ? document.createElement("canvas")
      : new OffscreenCanvas(w, h);
  c.width = w; c.height = h;
  const ctx = c.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return { data: new Uint8ClampedArray(w * h * 4), w, h };
  ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

// Downscale a drawable (ImageBitmap) so its long edge ≤ maxEdge before it is
// uploaded as a texture. Returns the input unchanged when it already fits. An
// oversized bitmap (a full-res camera JPEG on a small GPU) otherwise fails
// texImage2D and renders black; capping matches the float path. The GPU draw is
// a bilinear box-down (adequate for a display source, unlike the mip-tapped
// float path). Falls back to the original drawable if a 2D context is
// unavailable, so behaviour degrades to the previous (uncapped) upload.
export function capDrawableToEdge(
  img: ImageBitmap,
  W: number,
  H: number,
  maxEdge: number,
): { source: TexImageSource; width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(W, H));
  if (scale >= 1) return { source: img, width: W, height: H };
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const c: HTMLCanvasElement | OffscreenCanvas =
    typeof document !== "undefined"
      ? document.createElement("canvas")
      : new OffscreenCanvas(w, h);
  c.width = w; c.height = h;
  const ctx = c.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return { source: img, width: W, height: H };
  ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);
  return { source: c, width: w, height: h };
}
