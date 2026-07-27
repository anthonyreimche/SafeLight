// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Guards the capabilities every other .webgl.test.ts relies on. If this fails,
// the browser provider is misconfigured and the rest of the WebGL suite will
// fail for reasons unrelated to the code under test.

import { describe, expect, it } from "vitest";

const context = (): WebGL2RenderingContext => {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) throw new Error("WebGL2 unavailable");
  return gl;
};

describe("WebGL2 test environment", () => {
  it("provides a WebGL2 context", () => {
    expect(context()).toBeTruthy();
  });

  it("compiles a #version 300 es shader", () => {
    const gl = context();
    const sh = gl.createShader(gl.FRAGMENT_SHADER);
    if (!sh) throw new Error("createShader failed");
    gl.shaderSource(
      sh,
      `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(1.0); }`,
    );
    gl.compileShader(sh);
    expect(gl.getShaderParameter(sh, gl.COMPILE_STATUS)).toBe(true);
  });

  it("supports the float-texture and texture-unit budget the renderer assumes", () => {
    const gl = context();
    // renderer.ts renders into RGBA16F and binds extension prepasses on units
    // 12-15, so anything below 16 units breaks the pipeline.
    expect(gl.getExtension("EXT_color_buffer_float")).toBeTruthy();
    expect(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)).toBeGreaterThanOrEqual(16);
  });

  it("round-trips a colour through a framebuffer", () => {
    const gl = context();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    expect(gl.checkFramebufferStatus(gl.FRAMEBUFFER)).toBe(gl.FRAMEBUFFER_COMPLETE);

    gl.clearColor(0.25, 0.5, 0.75, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    expect(Array.from(px)).toEqual([64, 128, 191, 255]);
  });
});
