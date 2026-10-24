// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A Display-P3 frame survives the app's path from the render worker to the main
// canvas: worker OffscreenCanvas (WebGL2) → transferToImageBitmap → postMessage →
// 2D drawImage on a main-thread HTMLCanvasElement. Process version 3's P3 output
// rests on the tag riding the bitmap through that hop. The subject is Chromium's
// canvas colour management (getImageData reads the 2D backing store, so the
// compositor is not involved), which needs a real browser: this runs from
// vitest.webgl.config.ts (`npm run test:webgl`).

import { describe, expect, it } from "vitest";

// The worker is a Blob URL to keep the test in one file. It clears a tagged
// drawing buffer to pure red, as the render worker would hand over a frame, on a
// context made with the renderer's own attributes: preserveDrawingBuffer can
// change how transferToImageBitmap takes the buffer.
const WORKER_SOURCE = `
self.onmessage = (e) => {
  const canvas = new OffscreenCanvas(4, 4);
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error("WebGL2 is unavailable in the worker");
  if (!("drawingBufferColorSpace" in gl)) throw new Error("drawingBufferColorSpace is unsupported");
  gl.drawingBufferColorSpace = e.data.space;
  gl.clearColor(1, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const bitmap = canvas.transferToImageBitmap();
  self.postMessage({ bitmap, tagged: gl.drawingBufferColorSpace }, [bitmap]);
};`;

interface Reply {
  bitmap: ImageBitmap;
  tagged: string;
}

async function drawnOnP3Canvas(space: PredefinedColorSpace) {
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  const worker = new Worker(url, { type: "module" });
  try {
    const { bitmap, tagged } = await new Promise<Reply>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<Reply>) => resolve(e.data);
      worker.onerror = (e) => reject(new Error(`worker: ${e.message}`));
      worker.postMessage({ space });
    });
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 4;
    const ctx = canvas.getContext("2d", { colorSpace: "display-p3" });
    if (!ctx) throw new Error("2D context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixel = ctx.getImageData(0, 0, 1, 1, { colorSpace: "display-p3" }).data;
    return { tagged, rgb: [pixel[0], pixel[1], pixel[2]] };
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}

const expectNear = (rgb: number[], expected: number[], tolerance: number) =>
  expect(
    rgb.every((v, i) => Math.abs(v - expected[i]) <= tolerance),
    `read back (${rgb}), expected (${expected}) ±${tolerance}`,
  ).toBe(true);

describe("a worker frame drawn onto a Display-P3 2D canvas", () => {
  it("keeps P3 red when the drawing buffer is tagged display-p3", async () => {
    const { tagged, rgb } = await drawnOnP3Canvas("display-p3");
    expect(tagged).toBe("display-p3");
    expectNear(rgb, [255, 0, 0], 1);
  });

  it("converts sRGB red into P3 when the drawing buffer is tagged srgb (control)", async () => {
    const { tagged, rgb } = await drawnOnP3Canvas("srgb");
    expect(tagged).toBe("srgb");
    expectNear(rgb, [234, 51, 35], 2);
  });
});
