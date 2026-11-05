// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A weak GPU (a VM's driver, a low-memory card) can refuse a photo's source
// texture, hold less than the develop cap in one texture, or lose its context.
// Each must surface as an error the worker reports, never a silent black frame
// or a TypeError on a null GL object.

import { describe, expect, it } from "vitest";
import { WebGLRenderer } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  drainGlErrors,
  floatImage,
  glHarness,
  identityParams,
  liveFrame,
  withRenderer,
} from "./webgl.test-support";

const WHITE = floatImage(4, 4, () => [1, 1, 1]);
const OPTS = { stages: [], pipeline: LINEAR_PROBE_PIPELINE };

const whiteBitmap = (): Promise<ImageBitmap> =>
  createImageBitmap(new ImageData(new Uint8ClampedArray(4 * 4 * 4).fill(255), 4, 4));

/** Whether every pixel of the canvas is the magenta liveFrame clears to. */
const nothingDrawn = (px: Uint8Array): boolean => px.every((v, i) => v === [255, 0, 255, 255][i % 4]);

interface Refusal {
  /** The texture bound when the first upload ran. */
  into: WebGLTexture | null;
  deleted: WebGLTexture[];
}

/** `fn` on a driver that refuses the first texture upload made meanwhile as out
 *  of memory, and says so only at the next getError. */
function refusingUpload(fn: (refusal: Refusal) => void): void {
  const { gl } = glHarness();
  const { texImage2D, getError, deleteTexture } = gl;
  const refusal: Refusal = { into: null, deleted: [] };
  let refused = false;
  gl.texImage2D = (...args: unknown[]): void => {
    if (!refusal.into) {
      refusal.into = gl.getParameter(gl.TEXTURE_BINDING_2D);
      refused = true;
    }
    Reflect.apply(texImage2D, gl, args);
  };
  gl.getError = (): number => {
    if (!refused) return getError.call(gl);
    refused = false;
    return gl.OUT_OF_MEMORY;
  };
  gl.deleteTexture = (texture: WebGLTexture | null): void => {
    if (texture) refusal.deleted.push(texture);
    deleteTexture.call(gl, texture);
  };
  try {
    fn(refusal);
  } finally {
    gl.texImage2D = texImage2D;
    gl.getError = getError;
    gl.deleteTexture = deleteTexture;
    drainGlErrors(gl);
  }
}

describe("a source the GPU refuses", () => {
  it.each<[string, () => Promise<Parameters<WebGLRenderer["setImage"]>[0]>]>([
    ["a RAW decode", async () => WHITE],
    ["a bitmap", whiteBitmap],
  ])("throws for %s, lets go of its texture and draws nothing", async (_label, source) => {
    const image = await source();
    withRenderer(OPTS, (renderer) => {
      renderer.setParams(identityParams());
      renderer.setImage(WHITE);
      expect(nothingDrawn(liveFrame(renderer))).toBe(false);

      refusingUpload((refusal) => {
        expect(() => renderer.setImage(image)).toThrow("Source upload failed: out of GPU memory");
        expect(refusal.into).not.toBeNull();
        expect(refusal.deleted).toContain(refusal.into);
      });
      expect(nothingDrawn(liveFrame(renderer))).toBe(true);
    });
  });

  // Neighbours are decoded ahead exactly when GPU memory is tight.
  it("keeps the open photo drawing when it is a neighbour decoded ahead", () => {
    withRenderer(OPTS, (renderer) => {
      renderer.setParams(identityParams());
      renderer.uploadSource("open", WHITE);

      refusingUpload(() => {
        expect(() => renderer.uploadSource("next", WHITE, undefined, false, false)).toThrow(
          "Source upload failed: out of GPU memory",
        );
      });
      expect(renderer.hasSource("next")).toBe(false);
      expect(nothingDrawn(liveFrame(renderer))).toBe(false);
      expect(renderer.bindSource("open")).toBe(true);
    });
  });

  it("is not blamed for an error raised before its upload", () => {
    const { gl } = glHarness();
    withRenderer(OPTS, (renderer) => {
      renderer.setParams(identityParams());
      gl.bindTexture(0x1234, null);
      expect(() => renderer.setImage(WHITE)).not.toThrow();
      expect(nothingDrawn(liveFrame(renderer))).toBe(false);
    });
    drainGlErrors(gl);
  });
});

describe("a RAW decode larger than the GPU's texture limit", () => {
  it("is uploaded at the limit and drawn", () => {
    const { gl } = glHarness();
    const { getParameter } = gl;
    gl.getParameter = (pname: number): unknown =>
      pname === gl.MAX_TEXTURE_SIZE ? 8 : getParameter.call(gl, pname);
    try {
      withRenderer(OPTS, (renderer) => {
        renderer.setParams(identityParams());
        renderer.setImage(floatImage(32, 16, () => [1, 1, 1]), 4096);
        expect([renderer.sourceWidth, renderer.sourceHeight]).toEqual([8, 4]);
        expect(nothingDrawn(liveFrame(renderer))).toBe(false);
      });
    } finally {
      gl.getParameter = getParameter;
    }
  });
});

describe("a lost context", () => {
  it("says so when a shader can't be created", () => {
    const { gl } = glHarness();
    const { createShader } = gl;
    withRenderer(OPTS, (renderer) => {
      renderer.setParams(identityParams());
      renderer.setImage(WHITE);
      gl.createShader = (): WebGLShader | null => null;
      try {
        expect(() => renderer.render()).toThrow("WebGL context lost");
      } finally {
        gl.createShader = createShader;
      }
    });
  });

  it("says so when the renderer's textures can't be created", () => {
    const { canvas, gl } = glHarness();
    const { createTexture } = gl;
    Object.assign(gl, { createTexture: () => null });
    try {
      expect(() => new WebGLRenderer(canvas, OPTS)).toThrow("WebGL context lost");
    } finally {
      gl.createTexture = createTexture;
      drainGlErrors(gl);
    }
  });
});

// So a bright frame above can't be one drawn whatever the source.
it("draws nothing before a source is set", () => {
  withRenderer(OPTS, (renderer) => {
    renderer.setParams(identityParams());
    expect(nothingDrawn(liveFrame(renderer))).toBe(true);
  });
});
