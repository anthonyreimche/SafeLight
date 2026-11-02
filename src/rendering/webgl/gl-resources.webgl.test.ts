// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The GPU resources the renderer and its passes share: what the context can
// do, read once, and the colour targets every pass allocates the same way.

import { afterEach, describe, expect, it } from "vitest";
import {
  SCRATCH_UNIT,
  allocateChecked,
  allocateInto,
  drainErrors,
  readCaps,
  releaseTarget,
  workingFormat,
} from "./gl-resources";
import { drainGlErrors, glHarness, trackGlObjects } from "./webgl.test-support";

afterEach(() => drainGlErrors(glHarness().gl));

describe("readCaps", () => {
  it("reads what the context renders and holds", () => {
    const { gl } = glHarness();
    const caps = readCaps(gl, { norm16: true });
    expect(caps.colorBufferFloat).toBe(true);
    expect(caps.maxTextureSize).toBe(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    expect(caps.textureUnits).toBe(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS));
    expect(caps.combinedTextureUnits).toBe(gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS));
  });

  it("probes no norm16 format when asked not to", () => {
    const { gl } = glHarness();
    const getExtension = gl.getExtension.bind(gl);
    const asked: string[] = [];
    gl.getExtension = ((name: string) => {
      asked.push(name);
      return getExtension(name);
    }) as typeof gl.getExtension;
    try {
      expect(readCaps(gl, { norm16: false }).norm16).toBe(0);
      expect(asked).not.toContain("EXT_texture_norm16");
    } finally {
      gl.getExtension = getExtension;
    }
  });
});

describe("workingFormat", () => {
  it("is half float with float render targets and 8-bit without", () => {
    const { gl } = glHarness();
    expect(workingFormat(gl, true)).toEqual({ internalFormat: gl.RGBA16F, type: gl.HALF_FLOAT });
    expect(workingFormat(gl, false)).toEqual({ internalFormat: gl.RGBA8, type: gl.UNSIGNED_BYTE });
  });
});

describe("drainErrors", () => {
  it("empties the error queue", () => {
    const { gl } = glHarness();
    gl.bindTexture(0x1234, null);
    drainErrors(gl);
    expect(gl.getError()).toBe(gl.NO_ERROR);
  });
});

describe("allocateChecked", () => {
  it("makes a complete target on the scratch unit and leaves no framebuffer bound", () => {
    const { gl } = glHarness();
    const { target, ok } = allocateChecked(gl, gl.RGBA16F, gl.HALF_FLOAT, 4, 4);
    try {
      expect(ok).toBe(true);
      expect(gl.getParameter(gl.ACTIVE_TEXTURE)).toBe(gl.TEXTURE0 + SCRATCH_UNIT);
      expect(gl.getParameter(gl.TEXTURE_BINDING_2D)).toBe(target.tex);
      expect(gl.getParameter(gl.FRAMEBUFFER_BINDING)).toBeNull();
    } finally {
      releaseTarget(gl, target);
    }
  });

  it("isn't refused for an error raised before it", () => {
    const { gl } = glHarness();
    gl.bindTexture(0x1234, null);
    const { target, ok } = allocateChecked(gl, gl.RGBA8, gl.UNSIGNED_BYTE, 2, 2);
    releaseTarget(gl, target);
    expect(ok).toBe(true);
  });

  it("frees what it made once released", () => {
    const { gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      releaseTarget(gl, allocateChecked(gl, gl.RGBA8, gl.UNSIGNED_BYTE, 2, 2).target);
      expect([tally.live.texture, tally.live.framebuffer]).toEqual([0, 0]);
    } finally {
      tally.restore();
    }
  });
});

describe("allocateInto", () => {
  it("reallocates an existing target on the active unit with the sampling asked", () => {
    const { gl } = glHarness();
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    try {
      gl.activeTexture(gl.TEXTURE3);
      expect(allocateInto(gl, tex, fbo, workingFormat(gl, true), 8, 4, gl.LINEAR)).toBe(true);
      expect(gl.getParameter(gl.TEXTURE_BINDING_2D)).toBe(tex);
      expect(gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER)).toBe(gl.LINEAR);
      expect(gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S)).toBe(gl.CLAMP_TO_EDGE);
      expect(gl.getParameter(gl.FRAMEBUFFER_BINDING)).toBeNull();
    } finally {
      gl.activeTexture(gl.TEXTURE0);
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fbo);
    }
  });
});
