// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tests for output color-space handling: the shader matrix, the generated v2
// ICC profiles, and the container rewriters that embed them. Run with `npm test`.

import { describe, it, expect } from "vitest";
import {
  COLOR_SPACES,
  OUT_SPACE_CODE,
  buildIccProfile,
  embedColorProfile,
  outMatrixColumnMajor,
} from "./color-space";
import type { ColorSpaceId } from "./color-space";

const IDS: ColorSpaceId[] = COLOR_SPACES.map((s) => s.value);

type RGB = [number, number, number];

// gl.uniformMatrix3fv(loc, false, m) reads column-major: out[r] = Σc m[c·3+r]·v[c].
function applyGL(m: Float32Array, v: RGB): RGB {
  const out: RGB = [0, 0, 0];
  for (let r = 0; r < 3; r++) out[r] = m[r] * v[0] + m[3 + r] * v[1] + m[6 + r] * v[2];
  return out;
}

function fourcc(b: Uint8Array, off: number): string {
  return String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function bytes(...parts: (number[] | Uint8Array)[]): Uint8Array {
  const flat: number[] = [];
  for (const p of parts) for (const b of p) flat.push(b);
  return new Uint8Array(flat);
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

function blobOf(data: Uint8Array, type: string): Blob {
  return new Blob([data as BlobPart], { type });
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe("outMatrixColumnMajor", () => {
  it("is the identity for sRGB — the live develop view never converts", () => {
    const m = outMatrixColumnMajor("srgb");
    expect(m).toBeInstanceOf(Float32Array);
    expect(m).toHaveLength(9);
    expect(applyGL(m, [0.2, 0.4, 0.6])).toEqual([0.2, 0.4, 0.6]);
  });

  it("maps white to white in every space", () => {
    for (const id of IDS) {
      const [r, g, b] = applyGL(outMatrixColumnMajor(id), [1, 1, 1]);
      expect(r).toBeCloseTo(1, 5);
      expect(g).toBeCloseTo(1, 5);
      expect(b).toBeCloseTo(1, 5);
    }
  });

  it("keeps primaries pure where the target shares sRGB's chromaticity", () => {
    // Adobe RGB (1998) shares sRGB's red and blue chromaticities (only the green
    // primary differs), and Display P3 shares its blue — those primaries must
    // therefore stay single-channel, just rescaled by the gamut normalization.
    const adobe = outMatrixColumnMajor("adobe-rgb");
    const red = applyGL(adobe, [1, 0, 0]);
    expect(red[0]).toBeCloseTo(0.71512561, 7);
    expect([red[1], red[2]]).toEqual([0, 0]);
    const blue = applyGL(adobe, [0, 0, 1]);
    expect(blue[2]).toBeCloseTo(0.95883805, 7);
    expect([blue[0], blue[1]]).toEqual([0, 0]);
    const p3blue = applyGL(outMatrixColumnMajor("display-p3"), [0, 0, 1]);
    expect(p3blue[2]).toBeCloseTo(0.91051993, 7);
    expect([p3blue[0], p3blue[1]]).toEqual([0, 0]);
  });

  it("transposes the row-major source into column-major", () => {
    // Adobe's red row mixes in green (0.2849) while its green row takes no red;
    // reading the array untransposed would swap those two.
    const m = outMatrixColumnMajor("adobe-rgb");
    expect(m[3]).toBeCloseTo(0.28487439, 7); // row 0, col 1
    expect(m[1]).toBe(0); // row 1, col 0
  });
});

describe("OUT_SPACE_CODE", () => {
  it("gives every offered space a distinct shader code, sRGB being the no-op", () => {
    const codes = IDS.map((id) => OUT_SPACE_CODE[id]);
    expect(new Set(codes).size).toBe(IDS.length);
    expect(OUT_SPACE_CODE.srgb).toBe(0);
  });
});

interface IccTag {
  offset: number;
  size: number;
}

function iccTags(icc: Uint8Array): Map<string, IccTag> {
  const dv = view(icc);
  const count = dv.getUint32(128);
  const tags = new Map<string, IccTag>();
  for (let i = 0; i < count; i++) {
    const p = 132 + i * 12;
    tags.set(fourcc(icc, p), { offset: dv.getUint32(p + 4), size: dv.getUint32(p + 8) });
  }
  return tags;
}

// 16-bit sampled 'curv' entry, normalized back to 0..1 linear.
function trcAt(icc: Uint8Array, i: number): number {
  const tag = iccTags(icc).get("rTRC")!;
  return view(icc).getUint16(tag.offset + 12 + i * 2) / 65535;
}

function s15f16At(icc: Uint8Array, off: number): number {
  return view(icc).getInt32(off) / 65536;
}

describe("buildIccProfile", () => {
  it("writes a well-formed v2 RGB monitor-profile header", () => {
    for (const id of IDS) {
      const icc = buildIccProfile(id);
      const dv = view(icc);
      expect(dv.getUint32(0)).toBe(icc.length); // size field covers the padding
      expect(dv.getUint32(8)).toBe(0x02400000); // version 2.4
      expect(fourcc(icc, 12)).toBe("mntr");
      expect(fourcc(icc, 16)).toBe("RGB ");
      expect(fourcc(icc, 20)).toBe("XYZ ");
      expect(fourcc(icc, 36)).toBe("acsp");
      expect(icc.length % 4).toBe(0);
    }
  });

  it("carries the required tags in bounds, with one shared TRC blob", () => {
    const icc = buildIccProfile("prophoto-rgb");
    const tags = iccTags(icc);
    for (const sig of ["desc", "wtpt", "rXYZ", "gXYZ", "bXYZ", "rTRC", "gTRC", "bTRC", "cprt"]) {
      const tag = tags.get(sig);
      expect(tag, sig).toBeDefined();
      expect(tag!.offset).toBeGreaterThanOrEqual(128 + 4 + tags.size * 12);
      expect(tag!.offset + tag!.size).toBeLessThanOrEqual(icc.length);
    }
    expect(tags.get("gTRC")!.offset).toBe(tags.get("rTRC")!.offset);
    expect(tags.get("bTRC")!.offset).toBe(tags.get("rTRC")!.offset);
    expect(fourcc(icc, tags.get("rTRC")!.offset)).toBe("curv");
    expect(view(icc).getUint32(tags.get("rTRC")!.offset + 8)).toBe(1024);
  });

  it("declares the D50 PCS white point in both the header and wtpt", () => {
    const icc = buildIccProfile("srgb");
    const wtpt = iccTags(icc).get("wtpt")!.offset;
    expect(fourcc(icc, wtpt)).toBe("XYZ ");
    for (const [headerOff, tagOff, expected] of [
      [68, wtpt + 8, 0.964212],
      [72, wtpt + 12, 1],
      [76, wtpt + 16, 0.825188],
    ]) {
      expect(s15f16At(icc, headerOff)).toBeCloseTo(expected, 4);
      expect(s15f16At(icc, tagOff)).toBe(s15f16At(icc, headerOff));
    }
  });

  it("tabulates a monotone EOTF anchored at both ends", () => {
    for (const id of IDS) {
      const icc = buildIccProfile(id);
      expect(trcAt(icc, 0)).toBe(0);
      expect(trcAt(icc, 1023)).toBe(1);
      let prev = -1;
      for (let i = 0; i < 1024; i++) {
        const v = trcAt(icc, i);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });

  it("tabulates each space's own transfer function", () => {
    // sRGB mid-grey is ~21.4% linear; Adobe's pure 2.2-ish gamma gives ~21.8%.
    expect(trcAt(buildIccProfile("srgb"), 512)).toBeCloseTo(0.214, 2);
    expect(trcAt(buildIccProfile("adobe-rgb"), 512)).toBeCloseTo(0.218, 2);
    // ProPhoto's linear toe (v < 0.03125, slope 1/16) has to stay straight.
    const romm = buildIccProfile("prophoto-rgb");
    expect(trcAt(romm, 16)).toBeCloseTo(trcAt(romm, 8) * 2, 4);
    expect(trcAt(romm, 16)).toBeCloseTo(16 / 1023 / 16, 5);
  });

  it("names the space in the desc tag", () => {
    const icc = buildIccProfile("adobe-rgb");
    const tag = iccTags(icc).get("desc")!;
    const len = view(icc).getUint32(tag.offset + 8);
    const name = String.fromCharCode(...icc.subarray(tag.offset + 12, tag.offset + 12 + len - 1));
    expect(name).toBe("Adobe RGB (1998) compatible");
  });

  it("caches one profile instance per space", () => {
    expect(buildIccProfile("display-p3")).toBe(buildIccProfile("display-p3"));
    expect(buildIccProfile("display-p3")).not.toBe(buildIccProfile("adobe-rgb"));
  });
});

// A stored-DEFLATE zlib stream still has to inflate with a real inflater.
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function pngChunk(type: string, data: number[]): number[] {
  const len = data.length;
  // The rewriter never verifies CRCs on input, so a zero placeholder is enough.
  return [len >>> 24, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...ascii(type), ...data, 0, 0, 0, 0];
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function samplePng(): Uint8Array {
  return bytes(
    PNG_SIG,
    pngChunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    pngChunk("sRGB", [0]), // must be dropped: it contradicts an embedded profile
    pngChunk("IDAT", [1, 2, 3, 4]),
    pngChunk("IEND", []),
  );
}

function pngChunks(b: Uint8Array): { type: string; data: Uint8Array }[] {
  const dv = view(b);
  const out: { type: string; data: Uint8Array }[] = [];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = dv.getUint32(i);
    out.push({ type: fourcc(b, i + 4), data: b.subarray(i + 8, i + 8 + len) });
    i += 12 + len;
  }
  return out;
}

// SOS header, entropy-coded data and EOI — everything the rewriter must leave
// untouched behind the header segments.
const JPEG_SCAN = bytes([0xff, 0xda, 0x00, 0x08, 1, 0, 0, 0x3f, 0, 0], [0x11, 0x22, 0x33], [0xff, 0xd9]);

function sampleJpeg(): Uint8Array {
  const app0 = bytes([0xff, 0xe0, 0x00, 0x10], ascii("JFIF"), [0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const staleIcc = bytes([0xff, 0xe2, 0x00, 0x14], ascii("ICC_PROFILE"), [0, 1, 1, 9, 9, 9, 9]);
  return bytes([0xff, 0xd8], app0, staleIcc, JPEG_SCAN);
}

function jpegSegments(b: Uint8Array): { marker: number; body: Uint8Array }[] {
  const out: { marker: number; body: Uint8Array }[] = [];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff && b[i + 1] !== 0xda) {
    const len = (b[i + 2] << 8) | b[i + 3];
    out.push({ marker: b[i + 1], body: b.subarray(i + 4, i + 2 + len) });
    i += 2 + len;
  }
  return out;
}

// Minimal simple-format (VP8L) WebP: 14-bit width−1 then 14-bit height−1 after
// the 0x2f signature byte.
function sampleWebp(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  const payload = [
    0x2f,
    w & 0xff,
    ((w >> 8) & 0x3f) | ((h & 0x03) << 6),
    (h >> 2) & 0xff,
    (h >> 10) & 0x0f,
    0x00,
  ];
  const body = bytes(ascii("VP8L"), [payload.length, 0, 0, 0], payload);
  return bytes(ascii("RIFF"), [4 + body.length, 0, 0, 0], ascii("WEBP"), body);
}

function riffChunks(b: Uint8Array): { type: string; data: Uint8Array }[] {
  const dv = view(b);
  const out: { type: string; data: Uint8Array }[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const len = dv.getUint32(i + 4, true);
    out.push({ type: fourcc(b, i), data: b.subarray(i + 8, i + 8 + len) });
    i += 8 + len + (len & 1);
  }
  return out;
}

describe("embedColorProfile", () => {
  it("passes sRGB straight through — it is the assumed default", async () => {
    const blob = blobOf(samplePng(), "image/png");
    expect(await embedColorProfile(blob, "srgb")).toBe(blob);
  });

  it("returns the original blob for a container it cannot rewrite", async () => {
    const avif = blobOf(new Uint8Array([1, 2, 3, 4]), "image/avif");
    expect(await embedColorProfile(avif, "adobe-rgb")).toBe(avif);
  });

  it("ships the untagged file rather than a corrupt one when the bytes lie", async () => {
    const notPng = blobOf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), "image/png");
    expect(await embedColorProfile(notPng, "adobe-rgb")).toBe(notPng);
  });

  it("inserts a deflated iCCP chunk before IDAT and drops conflicting chunks", async () => {
    const icc = buildIccProfile("adobe-rgb");
    const out = await blobBytes(
      await embedColorProfile(blobOf(samplePng(), "image/png"), "adobe-rgb"),
    );
    expect(Array.from(out.subarray(0, 8))).toEqual(PNG_SIG);
    const chunks = pngChunks(out);
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "iCCP", "IDAT", "IEND"]);

    const iccp = chunks[1].data;
    const nul = iccp.indexOf(0);
    expect(String.fromCharCode(...iccp.subarray(0, nul))).toBe("ICC Profile");
    expect(iccp[nul + 1]).toBe(0); // compression method: deflate
    expect(await inflate(iccp.subarray(nul + 2))).toEqual(icc);
  });

  it("replaces any stale ICC APP2 in a JPEG, keeping JFIF first", async () => {
    const icc = buildIccProfile("display-p3");
    const out = await blobBytes(
      await embedColorProfile(blobOf(sampleJpeg(), "image/jpeg"), "display-p3"),
    );

    const segs = jpegSegments(out);
    expect(segs.map((s) => s.marker)).toEqual([0xe0, 0xe2]); // APP0 then the new APP2
    const app2 = segs[1].body;
    expect(String.fromCharCode(...app2.subarray(0, 11))).toBe("ICC_PROFILE");
    expect(app2[12]).toBe(1); // chunk 1
    expect(app2[13]).toBe(1); // of 1 — the profile fits one segment
    expect(app2.subarray(14)).toEqual(icc);
    expect(out.subarray(out.length - JPEG_SCAN.length)).toEqual(JPEG_SCAN);
  });

  it("promotes a simple WebP to a VP8X container carrying the ICCP chunk", async () => {
    const icc = buildIccProfile("prophoto-rgb");
    const src = sampleWebp(100, 50);
    const out = await blobBytes(
      await embedColorProfile(blobOf(src, "image/webp"), "prophoto-rgb"),
    );

    expect(fourcc(out, 0)).toBe("RIFF");
    expect(fourcc(out, 8)).toBe("WEBP");
    expect(view(out).getUint32(4, true)).toBe(out.length - 8);

    const chunks = riffChunks(out);
    expect(chunks.map((c) => c.type)).toEqual(["VP8X", "ICCP", "VP8L"]);
    const vp8x = chunks[0].data;
    expect(vp8x).toHaveLength(10);
    expect(vp8x[0] & 0x20).toBe(0x20); // ICC-present flag
    expect((vp8x[4] | (vp8x[5] << 8) | (vp8x[6] << 16)) + 1).toBe(100);
    expect((vp8x[7] | (vp8x[8] << 8) | (vp8x[9] << 16)) + 1).toBe(50);
    expect(chunks[1].data).toEqual(icc);
    expect(chunks[2].data).toEqual(src.subarray(20));
  });
});
