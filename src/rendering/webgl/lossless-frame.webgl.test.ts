// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The premise of `renderPhotoFrame(…, { lossless: true })`: a frame a stage wrote
// as data (a 16-bit exposure code split across R and G, validity in B) comes back
// from the worker as a PNG with every channel byte intact, where the JPEG it
// replaces for such a frame does not. The render worker encodes a WebGL2
// OffscreenCanvas with convertToBlob, and the extension decodes the blob with
// createImageBitmap and reads it back through a 2D canvas, so this spec runs that
// same chain on bytes it knows.

import { beforeAll, describe, expect, it } from "vitest";

const WIDTH = 64;
const HEIGHT = 64;

type Region = readonly [from: number, to: number];

interface Pattern {
  /** RGBA, row-major from the top row, alpha 255 throughout. */
  bytes: Uint8Array;
  /** Pixel ranges of the three kinds of content. */
  regions: { adjacent: Region; corners: Region; random: Region };
}

/** A small deterministic generator: the same "random" pixels on every run. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildPattern(): Pattern {
  const pixels: [number, number, number][] = [];

  // R and G one step apart, either way round, at every value, and the carry of a
  // 16-bit code from its low byte (G) into its high byte (R): the neighbouring
  // codes a measurement told apart.
  for (let k = 0; k < 255; k++) {
    pixels.push([k, k + 1, 255], [k + 1, k, 255]);
  }
  for (let high = 0; high < 255; high++) {
    pixels.push([high, 255, 255], [high + 1, 0, 255]);
  }
  const adjacentEnd = pixels.length;

  for (const r of [0, 255]) {
    for (const g of [0, 255]) {
      for (const b of [0, 255]) pixels.push([r, g, b]);
    }
  }
  const cornersEnd = pixels.length;

  const next = generator(0x5afe11);
  while (pixels.length < WIDTH * HEIGHT) {
    pixels.push([
      Math.floor(next() * 256),
      Math.floor(next() * 256),
      Math.floor(next() * 256),
    ]);
  }

  const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
  pixels.forEach(([r, g, b], i) => bytes.set([r, g, b, 255], i * 4));
  return {
    bytes,
    regions: {
      adjacent: [0, adjacentEnd],
      corners: [adjacentEnd, cornersEnd],
      random: [cornersEnd, pixels.length],
    },
  };
}

const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

// The texture's top row lands on the canvas's top row, so a pixel keeps its place
// in `bytes` all the way to getImageData.
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uData;
out vec4 fragColor;
void main() {
  ivec2 at = ivec2(int(gl_FragCoord.x), ${HEIGHT - 1} - int(gl_FragCoord.y));
  fragColor = vec4(texelFetch(uData, at, 0).rgb, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader returned null");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "shader failed to compile");
  }
  return shader;
}

/** Draw `bytes` the way the renderer draws a frame: a fragment shader writing the
 *  default framebuffer of a context made with the renderer's own attributes. */
function render(bytes: Uint8Array): { canvas: OffscreenCanvas; gl: WebGL2RenderingContext } {
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const gl = canvas.getContext("webgl2", {
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error("WebGL2 unavailable");

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "program failed to link");
  }

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, WIDTH, HEIGHT, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, "uData"), 0);
  gl.viewport(0, 0, WIDTH, HEIGHT);
  gl.bindVertexArray(gl.createVertexArray());
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return { canvas, gl };
}

/** What the framebuffer holds, rows from the top. */
function readFramebuffer(gl: WebGL2RenderingContext): Uint8Array {
  const bottomUp = new Uint8Array(WIDTH * HEIGHT * 4);
  gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp);
  const topDown = new Uint8Array(bottomUp.length);
  const stride = WIDTH * 4;
  for (let row = 0; row < HEIGHT; row++) {
    topDown.set(bottomUp.subarray(row * stride, (row + 1) * stride), (HEIGHT - 1 - row) * stride);
  }
  return topDown;
}

/** Encode, decode with createImageBitmap and read back through a 2D canvas: the
 *  trip a frame takes from the render worker to the extension. */
async function roundTrip(canvas: OffscreenCanvas, options: ImageEncodeOptions): Promise<Uint8ClampedArray> {
  const blob = await canvas.convertToBlob(options);
  expect(blob.type).toBe(options.type);
  const bitmap = await createImageBitmap(blob);
  expect([bitmap.width, bitmap.height]).toEqual([WIDTH, HEIGHT]);
  const target = document.createElement("canvas");
  target.width = WIDTH;
  target.height = HEIGHT;
  const context = target.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, WIDTH, HEIGHT).data;
}

/** How many channel values in the pixel range differ from what was drawn. */
function differing(actual: ArrayLike<number>, expected: Uint8Array, [from, to]: Region): number {
  let count = 0;
  for (let i = from * 4; i < to * 4; i++) {
    if (actual[i] !== expected[i]) count++;
  }
  return count;
}

describe("a frame that carries data, encoded by convertToBlob", () => {
  const pattern = buildPattern();
  const { bytes, regions } = pattern;
  const whole: Region = [0, WIDTH * HEIGHT];
  let canvas: OffscreenCanvas;
  let written: Uint8Array;

  beforeAll(() => {
    const drawn = render(bytes);
    canvas = drawn.canvas;
    written = readFramebuffer(drawn.gl);
  });

  it("is drawn with the bytes it was given, of all three kinds", () => {
    const size = ([from, to]: Region) => to - from;
    expect(size(regions.adjacent)).toBe(1020);
    expect(size(regions.corners)).toBe(8);
    expect(size(regions.random)).toBeGreaterThan(3000);
    expect(differing(written, bytes, whole)).toBe(0);
  });

  describe("as a PNG", () => {
    let decoded: Uint8ClampedArray;

    beforeAll(async () => {
      decoded = await roundTrip(canvas, { type: "image/png" });
    });

    it.each(["adjacent", "corners", "random"] as const)(
      "keeps every byte of the %s pixels",
      (name) => {
        expect(differing(decoded, bytes, regions[name])).toBe(0);
      },
    );

    it("keeps every byte of the frame", () => {
      expect(differing(decoded, bytes, whole)).toBe(0);
      expect(Array.from(decoded)).toEqual(Array.from(bytes));
    });
  });

  describe("as a JPEG at quality 0.9, the control", () => {
    let decoded: Uint8ClampedArray;

    beforeAll(async () => {
      decoded = await roundTrip(canvas, { type: "image/jpeg", quality: 0.9 });
    });

    it.each(["adjacent", "random"] as const)("loses bytes of the %s pixels", (name) => {
      expect(differing(decoded, bytes, regions[name])).toBeGreaterThan(0);
    });

    it("does not give the frame back", () => {
      expect(differing(decoded, bytes, whole)).toBeGreaterThan(0);
    });
  });
});
