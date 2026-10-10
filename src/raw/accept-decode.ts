// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Whether a full RAW decode may be shown and whether it may be remembered.
// Develop's load and the background pre-decode both ask, so a bad decode is
// kept out of the develop-preview cache by either. A leaf module on purpose:
// the importers' tests replace it wholesale, which only works while it pulls
// in nothing from the app.

export interface DecodeVerdict {
  /** The decode's colours agree with the camera's own preview. */
  use: boolean;
  /** `use`, and the decode is not marginal (inferred dimensions). */
  cache: boolean;
}

interface Pixels {
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * `upright` is the decode as it would be cached (already turned); `preview` the
 * embedded JPEG, or null when the camera stored none (the decode is trusted).
 */
export async function acceptDecode(
  decode: { suspicious?: boolean },
  upright: Pixels,
  preview: Blob | null,
): Promise<DecodeVerdict> {
  const use = !preview || (await rawColorMatchesPreview(upright, preview));
  return { use, cache: use && !decode.suspicious };
}

export interface ChannelMeans {
  r: number;
  g: number;
  b: number;
}

export interface BalanceComparison {
  /** R/G and B/G of each image. */
  rawRG: number;
  preRG: number;
  rawBG: number;
  preBG: number;
  /** How far apart the two R/G (and B/G) ratios are, as a factor of at least 1. */
  rgFactor: number;
  bgFactor: number;
  ok: boolean;
}

/**
 * Compares two images' R/G and B/G balance and flags a mismatch when either
 * ratio differs by 2x or more. That catches the LibRaw <0.21 Canon EOS R bug
 * (wrong colour matrix, badly shifted R/B gains) without rejecting legitimate
 * warm or cool shots. A preview channel that reads back empty or not as a
 * number leaves nothing to compare against, so the decode stands: some Mesa
 * drivers read every pixel back as zero, which says nothing about the decode.
 */
export function compareBalance(raw: ChannelMeans, preview: ChannelMeans): BalanceComparison {
  const rg = raw.g || 1e-6;
  const pg = preview.g || 1e-6;

  const rawRG = raw.r / rg, preRG = preview.r / pg;
  const rawBG = raw.b / rg, preBG = preview.b / pg;

  const rgFactor = Math.max(rawRG / preRG, preRG / rawRG);
  const bgFactor = Math.max(rawBG / preBG, preBG / rawBG);
  const comparable = [preview.r, preview.g, preview.b].every((m) => Number.isFinite(m) && m > 0);
  const ok = !comparable || (rgFactor < 2.0 && bgFactor < 2.0);
  return { rawRG, preRG, rawBG, preBG, rgFactor, bgFactor, ok };
}

// Compare the decoded RAW float image's channel balance against the embedded
// JPEG preview (the camera's own rendering — always color-correct).
// Returns true when the decode looks plausible, false when it should be rejected.
async function rawColorMatchesPreview(raw: Pixels, previewBlob: Blob): Promise<boolean> {
  try {
    // Downscale the preview to 64 px for a fast sample; use ImageBitmap resize
    // so we don't pull a big JPEG into a canvas.
    const thumb = await createImageBitmap(previewBlob, {
      resizeWidth: 64,
      resizeHeight: 64,
      resizeQuality: "pixelated",
    });
    const pf = bitmapToFloat(thumb);
    thumb.close();

    // Mean R/G/B of the JPEG preview (linear after inverse-sRGB in bitmapToFloat).
    let pR = 0, pG = 0, pB = 0;
    for (let i = 0; i < pf.data.length; i += 4) {
      pR += pf.data[i]; pG += pf.data[i + 1]; pB += pf.data[i + 2];
    }
    const pN = pf.data.length / 4;

    // Mean R/G/B of the RAW decode, sampled at a stride to keep it fast.
    const n = raw.width * raw.height;
    const step = Math.max(1, Math.floor(n / 4096));
    let rR = 0, rG = 0, rB = 0, rN = 0;
    for (let i = 0; i < n * 4; i += step * 4) {
      rR += raw.data[i]; rG += raw.data[i + 1]; rB += raw.data[i + 2]; rN++;
    }

    if (!rN || !pN) return true;
    const balance = compareBalance(
      { r: rR / rN, g: rG / rN, b: rB / rN },
      { r: pR / pN, g: pG / pN, b: pB / pN },
    );

    console.info(
      `[load] RAW vs JPEG — R/G: ${balance.rawRG.toFixed(2)} vs ${balance.preRG.toFixed(2)}` +
      ` (×${balance.rgFactor.toFixed(2)}),` +
      ` B/G: ${balance.rawBG.toFixed(2)} vs ${balance.preBG.toFixed(2)}` +
      ` (×${balance.bgFactor.toFixed(2)})`,
    );

    return balance.ok;
  } catch {
    return true; // if comparison fails, trust the decode
  }
}

// Read an ImageBitmap into a linear Float32 RGBA image via a temporary WebGL2
// framebuffer. This is more reliable than OffscreenCanvas.getContext("2d")
// readback on Mesa/Linux, where accelerated 2D canvas readback can silently
// return all-zero data.
//
// Pixel layout: texImage2D without UNPACK_FLIP_Y places image row 0 at texture
// y=0 (OpenGL bottom). readPixels reads y=0 first (framebuffer bottom = texture
// y=0 = image row 0), so the output array is already top-to-bottom — no flip
// needed. This matches the layout the renderer expects for Float32 images.
function bitmapToFloat(bitmap: ImageBitmap): Pixels {
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
  if (!gl) throw new Error("WebGL2 unavailable for pixel readback");

  const tex = gl.createTexture();
  if (!tex) throw new Error("createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);

  const fb = gl.createFramebuffer();
  if (!fb) throw new Error("createFramebuffer failed");
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  gl.deleteFramebuffer(fb);
  gl.deleteTexture(tex);
  // Free the context immediately: browsers cap live WebGL contexts (~16), and a
  // batch RAW prefetch calls this once per decode, so a leaked context per call
  // would evict an older one — including a live canvas.
  gl.getExtension("WEBGL_lose_context")?.loseContext();

  // Apply the inverse sRGB transfer function (IEC 61966-2-1) to linearise.
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]     / 255;
    const g = pixels[i + 1] / 255;
    const b = pixels[i + 2] / 255;
    data[i]     = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
    data[i + 1] = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
    data[i + 2] = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
    data[i + 3] = 1.0;
  }

  return { data, width, height };
}
