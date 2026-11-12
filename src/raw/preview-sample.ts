// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A RAW's embedded camera preview read as a small linear sample, for the colour
// check on the decode and the camera match (accept-decode.ts). Reading it costs
// a JPEG decode, so a caller that has the preview while its RAW still decodes
// begins the sample then. A leaf module: it pulls in nothing from the app.

export interface LinearPixels {
  data: Float32Array;
  width: number;
  height: number;
}

/** A preview's sample under way: null when the preview can't be read. */
export type PreviewSample = Promise<LinearPixels | null>;

const SAMPLE_EDGE = 64;

/** The embedded JPEG preview as a 64 px linear sample, or null when it can't be
 *  read, which leaves the decode trusted. Never rejects. */
export async function samplePreview(preview: Blob): PreviewSample {
  try {
    // Use ImageBitmap resize so we don't pull a big JPEG into a canvas.
    const thumb = await createImageBitmap(preview, {
      resizeWidth: SAMPLE_EDGE,
      resizeHeight: SAMPLE_EDGE,
      resizeQuality: "pixelated",
    });
    try {
      return bitmapToFloat(thumb);
    } finally {
      thumb.close();
    }
  } catch {
    return null;
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
function bitmapToFloat(bitmap: ImageBitmap): LinearPixels {
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
  if (!gl) throw new Error("WebGL2 unavailable for pixel readback");

  const pixels = new Uint8Array(width * height * 4);
  let tex: WebGLTexture | null = null;
  let fb: WebGLFramebuffer | null = null;
  try {
    tex = gl.createTexture();
    if (!tex) throw new Error("createTexture failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);

    fb = gl.createFramebuffer();
    if (!fb) throw new Error("createFramebuffer failed");
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  } finally {
    if (fb) gl.deleteFramebuffer(fb);
    if (tex) gl.deleteTexture(tex);
    // Free the context immediately, even after a failed readback: browsers cap
    // live WebGL contexts (~16), and a batch RAW prefetch calls this once per
    // decode, so a leaked context per call would evict an older one, including
    // a live canvas.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  // Apply the inverse sRGB transfer function (IEC 61966-2-1) to linearize.
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
