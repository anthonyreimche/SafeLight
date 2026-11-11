// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The codes an input profile's transform is applied to, read with Chromium's
// real decoders: a file's own 8-bit values, which the browser leaves alone even
// when the file embeds a profile it would otherwise convert to sRGB from. Runs
// from vitest.webgl.config.ts (`npm run test:webgl`).

import { describe, expect, it } from "vitest";
import { buildIccProfile } from "@/rendering/color-space";
import { readCodes } from "./profile-frame";

const W = 4;
const H = 2;
// Saturated codes, which an Adobe RGB → sRGB conversion moves a long way.
const CODES = Uint8ClampedArray.from({ length: W * H * 4 }, (_, i) =>
  i % 4 === 3 ? 255 : [[20, 200, 40], [230, 30, 60], [10, 60, 220], [128, 128, 128]][Math.floor(i / 4) % 4][i % 4],
);

async function png(): Promise<Uint8Array<ArrayBuffer>> {
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2D context");
  ctx.putImageData(new ImageData(CODES.slice(), W, H), 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** `file` with an iCCP chunk holding `profile` after its IHDR. */
async function withProfile(file: Uint8Array<ArrayBuffer>, profile: Uint8Array): Promise<Blob> {
  const zipped = new Uint8Array(
    await new Response(new Blob([profile.slice()]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer(),
  );
  const body = new Uint8Array([...new TextEncoder().encode("icc"), 0, 0, ...zipped]);
  const typed = new Uint8Array([...new TextEncoder().encode("iCCP"), ...body]);
  const chunk = new Uint8Array(12 + body.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.length);
  chunk.set(typed, 4);
  view.setUint32(8 + body.length, crc32(typed));
  const ihdrEnd = 8 + 25;
  return new Blob([file.subarray(0, ihdrEnd), chunk, file.subarray(ihdrEnd)], { type: "image/png" });
}

describe("readCodes in Chromium", () => {
  it("reads a PNG's codes as it holds them", async () => {
    const { codes, width, height } = await readCodes(new Blob([await png()]), "browser");

    expect([width, height]).toEqual([W, H]);
    expect([...codes]).toEqual([...CODES]);
  });

  it("leaves the codes of a PNG with an embedded Adobe RGB profile unconverted", async () => {
    const tagged = await withProfile(await png(), buildIccProfile("adobe-rgb"));

    // The browser's own decode converts it: the profile is read.
    const converted = await createImageBitmap(tagged);
    const ctx = new OffscreenCanvas(W, H).getContext("2d");
    ctx?.drawImage(converted, 0, 0);
    expect([...(ctx?.getImageData(0, 0, W, H).data ?? [])]).not.toEqual([...CODES]);

    expect([...(await readCodes(tagged, "browser")).codes]).toEqual([...CODES]);
  });

  it("reads a netpbm file's codes through its own decoder", async () => {
    const header = new TextEncoder().encode(`P6\n${W} ${H}\n255\n`);
    const rgb = CODES.filter((_, i) => i % 4 !== 3);
    const { codes } = await readCodes(new Blob([header, rgb]), "netpbm");

    expect([...codes]).toEqual([...CODES]);
  });
});
