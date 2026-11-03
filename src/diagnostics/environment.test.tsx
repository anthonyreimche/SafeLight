// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, describe, expect, it, vi } from "vitest";

const PARAMETERS: Record<number, string | number> = { 1: "vendor", 2: "renderer", 3: "GLSL 3.00", 4: 8192, 5: 1024 };

/** A probe context that offers `extensions` and nothing else. */
function stubProbeContext(extensions: string[]): void {
  const context = {
    VENDOR: 1,
    RENDERER: 2,
    SHADING_LANGUAGE_VERSION: 3,
    MAX_TEXTURE_SIZE: 4,
    MAX_FRAGMENT_UNIFORM_VECTORS: 5,
    getParameter: (name: number) => PARAMETERS[name],
    getExtension: (name: string) => (extensions.includes(name) ? {} : null),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as RenderingContext,
  );
}

async function freshReadWebGLInfo() {
  vi.resetModules();
  return (await import("./environment")).readWebGLInfo;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readWebGLInfo", () => {
  it("reports float render targets when the GPU offers EXT_color_buffer_float", async () => {
    stubProbeContext(["EXT_color_buffer_float"]);
    expect((await freshReadWebGLInfo())()?.colorBufferFloat).toBe(true);
  });

  // The develop program's uniforms grow with masks and stages; a driver with few
  // vectors fails to link it.
  it("reports the fragment uniform vectors", async () => {
    stubProbeContext([]);
    expect((await freshReadWebGLInfo())()?.fragmentUniformVectors).toBe(1024);
  });

  it("reports none when it doesn't", async () => {
    stubProbeContext([]);
    expect((await freshReadWebGLInfo())()?.colorBufferFloat).toBe(false);
  });

  // A WebGL1 context never offers EXT_color_buffer_float, so reading it would blame
  // float render targets when the real gap is WebGL2 itself.
  it("has nothing to report without WebGL2, even with WebGL1", async () => {
    stubProbeContext(["EXT_color_buffer_float"]);
    const probe = vi.mocked(HTMLCanvasElement.prototype.getContext);
    const webgl1 = probe.getMockImplementation() ?? (() => null);
    probe.mockImplementation(function (this: HTMLCanvasElement, type: string) {
      return type === "webgl2" ? null : webgl1.call(this, type);
    } as typeof HTMLCanvasElement.prototype.getContext);
    expect((await freshReadWebGLInfo())()).toBeNull();
  });
});

// Chromium refuses WebGL for a couple of minutes after a GPU reset. A probe that
// lands in that window must not stand for the whole session.
describe("readWebGLInfo after a refused context", () => {
  it("asks again once WebGL is back", async () => {
    stubProbeContext([]);
    const probe = vi.mocked(HTMLCanvasElement.prototype.getContext);
    const working = probe.getMockImplementation()!;
    probe.mockImplementation(() => null);
    const read = await freshReadWebGLInfo();
    expect(read()).toBeNull();
    probe.mockImplementation(working);
    expect(read()?.renderer).toBe("renderer");
  });
});
