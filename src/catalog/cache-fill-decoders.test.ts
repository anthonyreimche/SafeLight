// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The cache work for a RAW whose format an extension's decoder reads too
// (api.library.registerDecoder): the entry is kept for the chain of decoders,
// each decoder's verdict on the photo is its own marker, and a photo every
// decoder has failed on for good is left alone. The decode, the colour check
// and the cache are faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecodeFailure, RawDecodeRequest, RawFloatImage } from "@/raw/decode";
import { CAMERA_MATCH_VERSION } from "@/raw/camera-match";
import { rawPhoto } from "@/raw/raw-photo.test-support";
import { useSettings } from "@/state/settings-store";
import { dropImageDecoders, registerImageDecoder } from "./image-decoders";

const h = vi.hoisted(() => ({
  decodes: [] as (RawDecodeRequest | undefined)[],
  decodeResult: (): RawFloatImage | DecodeFailure => ({ failure: "unsupported" }),
  verdict: { use: true, cache: true } as { use: boolean; cache: boolean; match?: { exposure: number; shadows: number } },
  /** Final "unsupported" markers, as "decoder key". */
  marked: new Set<string>(),
  /** Each marker stored, as "kind decoder key". */
  marks: [] as string[],
  /** The key of each write. */
  writes: [] as string[],
  /** The verdicts each write clears. */
  cleared: [] as ({ markerKey: string; decoder?: string } | undefined)[],
}));

vi.mock("@/raw/decode", () => ({
  decodeRawToFloat: async (_file: Blob, request?: RawDecodeRequest) => {
    h.decodes.push(request);
    return h.decodeResult();
  },
}));

vi.mock("@/raw/accept-decode", () => ({ acceptDecode: async () => h.verdict }));

vi.mock("@/raw/raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/raw/raw-preview")>()),
  extractRawPreview: async () => null,
}));

vi.mock("@/raw/raw-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/raw/raw-cache")>();
  return {
    rawCacheKey: actual.rawCacheKey,
    decoderMarkerId: actual.decoderMarkerId,
    rawCacheGeneration: () => 0,
    hasDecodeMarker: async (key: string, kind: string, decoder = actual.DECODER_ID) =>
      kind === "unsupported" && h.marked.has(`${decoder} ${key}`),
    markDecode: async (key: string, kind: string, _begunIn: number, decoder = actual.DECODER_ID) => {
      h.marks.push(`${kind} ${decoder} ${key}`);
    },
    writeCachedPreview: async (
      key: string,
      _data: Float32Array,
      _width: number,
      _height: number,
      _begunIn: number,
      _entry?: unknown,
      verdicts?: { markerKey: string; decoder?: string },
    ) => {
      h.writes.push(key);
      h.cleared.push(verdicts);
      return true;
    },
  };
});

vi.mock("./storage", () => ({ catalogStorage: () => ({ putPhoto: async () => {} }) }));

vi.mock("@/state/catalog-store", () => ({
  useCatalogStore: { getState: () => ({ photos: [] }) },
}));

import { fillCacheEntry } from "./cache-fill";

const EXTENSION = "ext.raw/fast@1.2.0";
const LIBRAW = "libraw-0.22.1+1";
const SIGNATURE = `${EXTENSION}>libraw`;
const KEY = "v6:a.NEF:64:0";

const decoded = (extra: Partial<RawFloatImage> = {}): RawFloatImage => ({
  data: new Float32Array(4).fill(0.5),
  width: 1,
  height: 1,
  oriented: true,
  ...extra,
});

beforeEach(() => {
  h.decodes = [];
  h.decodeResult = () => decoded({ decoder: EXTENSION, signature: SIGNATURE });
  h.verdict = { use: true, cache: true };
  h.marked = new Set();
  h.marks = [];
  h.writes = [];
  h.cleared = [];
  useSettings.setState({ decoderOrder: { nef: ["ext.raw/fast", "libraw"] }, rawCacheEnabled: true });
  registerImageDecoder("ext.raw", {
    id: "fast",
    label: "Fast",
    version: "1.2.0",
    extensions: [".nef"],
    decode: async () => null,
  });
});

afterEach(() => {
  dropImageDecoders("ext.raw");
  useSettings.setState({ decoderOrder: {} });
});

describe("fillCacheEntry once an extension's decoder leads", () => {
  it("writes the entry kept for the chain", async () => {
    expect(await fillCacheEntry(rawPhoto("a.NEF"), 0)).toBe("taken");

    expect(h.writes).toEqual([`${KEY}:${SIGNATURE}`]);
    expect(h.cleared).toEqual([{ markerKey: KEY, decoder: EXTENSION }]);
  });

  it("asks the decode for the photo's orientation, for a frame its decoder leaves unturned", async () => {
    await fillCacheEntry(rawPhoto("a.NEF", { exif: { orientation: 8 } }), 0);

    expect(h.decodes[0]?.orientation).toBe(8);
  });

  it("writes nothing, and learns nothing, from a decode made under other decoders", async () => {
    h.decodeResult = () => decoded({ decoder: LIBRAW });
    h.verdict = { use: true, cache: true, match: { exposure: 0.4, shadows: 10 } };
    const photo = rawPhoto("a.NEF");

    expect(await fillCacheEntry(photo, 0)).toBe("nothing");
    expect(h.writes).toEqual([]);
    expect(photo.exif).not.toHaveProperty("cameraMatchVersion");
  });

  it("leaves a photo every decoder has failed on for good undecoded", async () => {
    h.marked.add(`${EXTENSION} ${KEY}`);
    h.marked.add(`${LIBRAW} ${KEY}`);

    expect(await fillCacheEntry(rawPhoto("a.NEF"), 0)).toBe("nothing");
    expect(h.decodes).toEqual([]);
  });

  it("asks the decode to pass by the decoders that have, with the photo's white balance", async () => {
    h.marked.add(`${EXTENSION} ${KEY}`);

    await fillCacheEntry(rawPhoto("a.NEF", { exif: { asShotMultipliers: [2, 1, 1.5] } }), 0);

    expect([...(h.decodes[0]?.ruledOut ?? [])]).toEqual([EXTENSION]);
    expect(h.decodes[0]?.asShotMultipliers).toEqual([2, 1, 1.5]);
  });

  it("strikes each decoder that found nothing usable", async () => {
    h.decodeResult = () => ({ failure: "unsupported", unsupportedBy: [EXTENSION, LIBRAW] });

    await fillCacheEntry(rawPhoto("a.NEF"), 0);

    expect(h.marks).toEqual([`unsupported ${EXTENSION} ${KEY}`, `unsupported ${LIBRAW} ${KEY}`]);
  });

  it("strikes a decoder that failed ahead of the one that answered", async () => {
    h.decodeResult = () => decoded({ decoder: LIBRAW, unsupportedBy: [EXTENSION] });

    await fillCacheEntry(rawPhoto("a.NEF"), 0);

    expect(h.marks).toEqual([`unsupported ${EXTENSION} ${KEY}`]);
  });

  it("marks the decoder that answered with the colour check's verdict", async () => {
    h.verdict = { use: true, cache: false };
    await fillCacheEntry(rawPhoto("a.NEF"), 0);
    h.verdict = { use: false, cache: false };
    await fillCacheEntry(rawPhoto("a.NEF"), 0);

    expect(h.marks).toEqual([`suspicious ${EXTENSION} ${KEY}`, `unsupported ${EXTENSION} ${KEY}`]);
  });

  it("learns the camera match again over one libraw's decodes learned", async () => {
    h.verdict = { use: true, cache: true, match: { exposure: 0.4, shadows: 10 } };
    const photo = rawPhoto("a.NEF", {
      exif: { baselineExposure: 1.5, baselineShadows: 20, cameraMatchVersion: CAMERA_MATCH_VERSION },
    });

    await fillCacheEntry(photo, 0);

    expect(photo.exif).toMatchObject({ baselineExposure: 0.4, baselineShadows: 10, cameraMatchDecoders: SIGNATURE });
  });
});
