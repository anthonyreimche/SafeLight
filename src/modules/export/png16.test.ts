// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tests for the 16-bit PNG writer. A hand-rolled chunk parser and Up-filter
// undo (deliberately not shared with the encoder) read the file back, so the
// container, the filter bytes and the big-endian samples are checked against
// the PNG spec rather than against the encoder's own assumptions. Run with
// `npm test`.

import { describe, it, expect, vi } from "vitest";
import { encodePng16 } from "./png16.ts";
import { buildIccProfile, crc32 } from "@/rendering/color-space";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ICC_NAME = "ICC Profile\0";

interface Chunk {
  type: string;
  data: Bytes;
}

type Bytes = Uint8Array<ArrayBuffer>;

async function bytesOf(blob: Blob): Promise<Bytes> {
  return new Uint8Array(await blob.arrayBuffer());
}

// Splits a PNG into chunks, failing the test on a bad signature or any CRC
// that doesn't match its type + data.
function parseChunks(png: Bytes): Chunk[] {
  expect(Array.from(png.subarray(0, 8))).toEqual(SIGNATURE);
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Chunk[] = [];
  let at = 8;
  while (at < png.length) {
    const size = dv.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + size);
    expect(dv.getUint32(at + 8 + size), `CRC of ${type}`).toBe(crc32(png.subarray(at + 4, at + 8 + size)));
    chunks.push({ type, data });
    at += 12 + size;
  }
  expect(at).toBe(png.length);
  return chunks;
}

async function inflate(zlib: Bytes): Promise<Bytes> {
  const stream = new Blob([zlib]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function onlyChunk(chunks: Chunk[], type: string): Chunk {
  const found = chunks.filter((c) => c.type === type);
  expect(found.length, `${type} chunks`).toBe(1);
  return found[0];
}

// Inverts the PNG filters row by row. Only None and Up are expected; anything
// else fails, so a stray filter type can't pass as a round trip.
function unfilter(scanlines: Uint8Array, rowBytes: number, height: number): { filters: number[]; rows: Uint8Array[] } {
  expect(scanlines.length).toBe(height * (1 + rowBytes));
  const filters: number[] = [];
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const at = y * (1 + rowBytes);
    const filter = scanlines[at];
    filters.push(filter);
    const row = scanlines.slice(at + 1, at + 1 + rowBytes);
    if (filter === 2) {
      for (let i = 0; i < rowBytes; i++) row[i] = (row[i] + rows[y - 1][i]) & 0xff;
    } else {
      expect(filter, `filter type of row ${y}`).toBe(0);
    }
    rows.push(row);
  }
  return { filters, rows };
}

// Every RGB sample of every unfiltered row against the RGBA source. A row holds
// RGB only, so an alpha sample leaking in would also fail unfilter's length check.
function expectSamples(rows: Uint8Array[], src: Uint16Array, width: number): void {
  rows.forEach((bytes, y) => {
    const row = new DataView(bytes.buffer);
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        const got = row.getUint16((x * 3 + c) * 2);
        const want = src[(y * width + x) * 4 + c];
        if (got !== want) expect.fail(`sample x=${x} y=${y} c=${c}: got ${got}, want ${want}`);
      }
    }
  });
}

// Differing width and height so a transposition shows. The pattern falls as
// well as rises down the rows, so the bytewise Up filter wraps below zero, and
// both bytes of each sample carry information. Alpha is a distinct marker value.
const W = 7;
const H = 5;
const ALPHA = 0xabcd;

function image(): Uint16Array {
  const rgba = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      rgba[i] = (x * 9000 + y * 300) & 0xffff;
      rgba[i + 1] = (65535 - y * 12000 - x * 17) & 0xffff;
      rgba[i + 2] = ((x * 257) ^ (y * 4099)) & 0xffff;
      rgba[i + 3] = ALPHA;
    }
  }
  const specials = [0, 1, 255, 256, 32767, 65535];
  specials.forEach((v, k) => { rgba[(2 * W + k) * 4] = v; });
  return rgba;
}

describe("encodePng16", () => {
  it("round-trips every RGB sample through a valid 16-bit RGB PNG", async () => {
    const src = image();
    const blob = await encodePng16(src, W, H, {});
    expect(blob.type).toBe("image/png");

    const bytes = await bytesOf(blob);
    // IEND's CRC is a fixed value, so it pins the crc32 the parser checks with.
    expect(Array.from(bytes.subarray(-12))).toEqual([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const chunks = parseChunks(bytes);
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);

    const ihdr = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset, chunks[0].data.byteLength);
    expect(chunks[0].data.length).toBe(13);
    expect(ihdr.getUint32(0)).toBe(W);
    expect(ihdr.getUint32(4)).toBe(H);
    expect(Array.from(chunks[0].data.subarray(8))).toEqual([16, 2, 0, 0, 0]);
    expect(chunks[2].data.length).toBe(0);

    const { filters, rows } = unfilter(await inflate(onlyChunk(chunks, "IDAT").data), W * 6, H);
    expect(filters).toEqual([0, 2, 2, 2, 2]);
    expectSamples(rows, src, W);
  });

  it("keeps the Up filter continuous across the encoder's row bands", async () => {
    // ~2.6 MB of scanlines: about three of the encoder's 1 MiB bands.
    const w = 1100;
    const h = 400;
    const src = new Uint16Array(w * h * 4);
    for (let i = 0; i < src.length; i++) src[i] = (i * 40503 + (i >> 9) * 977) & 0xffff;
    const chunks = parseChunks(await bytesOf(await encodePng16(src, w, h, {})));
    const { filters, rows } = unfilter(await inflate(onlyChunk(chunks, "IDAT").data), w * 6, h);
    expect(filters[0]).toBe(0);
    expect(filters.slice(1).every((f) => f === 2)).toBe(true);
    expectSamples(rows, src, w);
  });

  // Chromium's CompressionStream works on the main thread without yielding, as
  // this pass-through stand-in does, so only the encoder's own yields let a
  // ticker on the event loop run between two bands.
  it("yields to the event loop before each band", async () => {
    let ticks = 0;
    const ticker = new MessageChannel();
    ticker.port1.onmessage = () => {
      ticks++;
      ticker.port2.postMessage(null);
    };
    const ticksAtBand: number[] = [];
    vi.stubGlobal("CompressionStream", class extends TransformStream<Uint8Array, Uint8Array> {
      constructor() {
        super({ transform: (band, out) => { ticksAtBand.push(ticks); out.enqueue(band); } });
      }
    });
    const w = 1100;
    const h = 400;
    try {
      ticker.port2.postMessage(null);
      await encodePng16(new Uint16Array(w * h * 4), w, h, {});
    } finally {
      ticker.port1.close();
      vi.unstubAllGlobals();
    }
    expect(ticksAtBand.length, "bands").toBeGreaterThanOrEqual(3);
    ticksAtBand.slice(1).forEach((t, i) => expect(t, `ticks by band ${i + 1}`).toBeGreaterThan(ticksAtBand[i]));
  });

  it("writes the first pixel's red sample big-endian", async () => {
    const rgba = new Uint16Array(W * H * 4);
    rgba[0] = 0x1234;
    const chunks = parseChunks(await bytesOf(await encodePng16(rgba, W, H, {})));
    const scanlines = await inflate(onlyChunk(chunks, "IDAT").data);
    expect(Array.from(scanlines.subarray(0, 3))).toEqual([0, 0x12, 0x34]);
  });

  it("embeds the ICC profile in an iCCP chunk between IHDR and IDAT", async () => {
    const icc = buildIccProfile("display-p3");
    const chunks = parseChunks(await bytesOf(await encodePng16(image(), W, H, { icc })));
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "iCCP", "IDAT", "IEND"]);

    const { data } = onlyChunk(chunks, "iCCP");
    const name = String.fromCharCode(...data.subarray(0, ICC_NAME.length));
    expect(name).toBe(ICC_NAME);
    expect(data[ICC_NAME.length]).toBe(0);
    expect(await inflate(data.subarray(ICC_NAME.length + 1))).toEqual(icc);
  });

  it("writes no iCCP chunk without a profile", async () => {
    const chunks = parseChunks(await bytesOf(await encodePng16(image(), W, H, {})));
    expect(chunks.some((c) => c.type === "iCCP")).toBe(false);
  });
});
