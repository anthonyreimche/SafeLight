// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A cached develop preview is half floats. Converting them to floats for the
// upload only for the driver to store them as halves again cost a whole-image
// pass and allocation on every cache hit; they upload as they are instead. The
// texture, and so every frame drawn from it, must hold what the floats did.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROCESS_VERSION, DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";
import { encodeHalf, halfToFloat32 } from "@/raw/half-float";
import type { Float16Source } from "@/rendering/source-sample";
import { uploadFloatMips } from "./source-cache";
import type { WebGLRenderer } from "./renderer";
import { builtinStages, differing, drainGlErrors, glHarness, withRenderer } from "./webgl.test-support";

vi.mock("@/raw/half-float", { spy: true });

beforeEach(() => {
  vi.mocked(halfToFloat32).mockClear();
});

const W = 29;
const H = 19;

/** Scene-linear texels as a cache stores them, with headroom, negatives and
 *  values down in the half subnormals. */
function cached(): Float16Source {
  const floats = new Float32Array(W * H * 4);
  for (let i = 0; i < floats.length; i++) {
    const x = Math.sin(i * 12.9898) * 43758.5453;
    const r = x - Math.floor(x);
    floats[i] = i % 4 === 3 ? 1 : (r - 0.05) * 2 ** ((i % 7) - 4);
  }
  return { kind: "float16", data: encodeHalf(floats), width: W, height: H };
}

interface Upload {
  level: number;
  type: number;
  data: unknown;
}

/** The texImage2D calls made into RGBA16F while `fn` runs. */
function halfFloatUploads(fn: () => void): Upload[] {
  const { gl } = glHarness();
  const { texImage2D } = gl;
  const uploads: Upload[] = [];
  gl.texImage2D = (...args: unknown[]): void => {
    if (args.length >= 9 && args[2] === gl.RGBA16F) {
      uploads.push({ level: Number(args[1]), type: Number(args[7]), data: args[8] });
    }
    Reflect.apply(texImage2D, gl, args);
  };
  try {
    fn();
  } finally {
    gl.texImage2D = texImage2D;
  }
  return uploads;
}

describe("a cached half-float source", () => {
  it("uploads its own halves at level 0 when it fits, unconverted", () => {
    const source = cached();
    const uploads = halfFloatUploads(() =>
      withRenderer(undefined, (renderer) => renderer.setImage(source)),
    );
    const base = uploads.find((u) => u.level === 0);
    expect(base?.type).toBe(glHarness().gl.HALF_FLOAT);
    expect(base?.data).toBe(source.data);
    expect(halfToFloat32).not.toHaveBeenCalled();
  });

  it("uploads from its floats when it is capped smaller", () => {
    const source = cached();
    const uploads = halfFloatUploads(() =>
      withRenderer(undefined, (renderer) => renderer.uploadSource("k", source, 8, false, true, true)),
    );
    expect(uploads.find((u) => u.level === 0)?.type).toBe(glHarness().gl.FLOAT);
    expect(halfToFloat32).toHaveBeenCalledWith(source.data);
  });

  it("holds what its floats held, at every level", () => {
    const { gl } = glHarness();
    expect(gl.getExtension("EXT_color_buffer_float")).not.toBeNull();
    const source = cached();
    const fromHalves = levels(gl, () => uploadFloatMips(gl, source.data, W, H));
    const fromFloats = levels(gl, () => uploadFloatMips(gl, halfToFloat32(source.data), W, H));
    expect(fromHalves.length).toBe(fromFloats.length);
    fromHalves.forEach((level, i) => expect(differing(level, fromFloats[i])).toBe(0));
  });

  it("renders the frame its floats rendered", () => {
    const source = cached();
    const floats = { kind: "float" as const, data: halfToFloat32(source.data), width: W, height: H };
    const frame = (open: (r: WebGLRenderer) => void) =>
      withRenderer({ stages: builtinStages() }, (renderer) => {
        open(renderer);
        renderer.setParams({
          ...DEFAULT_DEVELOP_PARAMS,
          processVersion: CURRENT_PROCESS_VERSION,
          dehaze: 40,
          texture: 35,
          clarity: 30,
        });
        // Drawn smaller than the source, so the frame reads its mips too.
        renderer.setViewport({ x: 0, y: 0, w: 1, h: 1 }, 11, 7);
        const captured = renderer.captureFloatFrame();
        if (!captured) throw new Error("captureFloatFrame returned null");
        return captured;
      });
    const fromHalves = frame((r) => r.setImage(source));
    const fromFloats = frame((r) => r.setImage(floats));
    expect([fromHalves.width, fromHalves.height]).toEqual([11, 7]);
    expect(differing(fromHalves.data, fromFloats.data)).toBe(0);
  });
});

/** Each mip level `upload` writes into a fresh texture bound for it, read back as floats. */
function levels(gl: WebGL2RenderingContext, upload: () => void): Float32Array[] {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  upload();
  const out: Float32Array[] = [];
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    for (let level = 0, w = W, h = H; ; level++, w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, level);
      expect(gl.checkFramebufferStatus(gl.FRAMEBUFFER)).toBe(gl.FRAMEBUFFER_COMPLETE);
      const px = new Float32Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
      out.push(px);
      if (w === 1 && h === 1) break;
    }
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    drainGlErrors(gl);
  }
  return out;
}
