// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop's open of a RAW whose format an extension's decoder reads too
// (api.library.registerDecoder). Once that decoder leads, the photo's decodes
// are kept apart from libraw's (the cache key and the GPU source key carry the
// chain's signature), each decoder's verdict on the photo is its own marker,
// the photo goes straight to its camera preview only when every decoder has
// failed on it for good, and the camera match libraw's decodes learned is
// learned again. The cache, the decode and the colour check are faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "./types";
import type { DecodeFailure, RawDecodeRequest, RawFloatImage } from "@/raw/decode";
import type { CameraMatch } from "@/raw/camera-match";
import { CAMERA_MATCH_VERSION } from "@/raw/camera-match";
import { dropImageDecoders, registerImageDecoder } from "./image-decoders";
import { useSettings } from "@/state/settings-store";

const h = vi.hoisted(() => ({
  cached: null as { data: Uint16Array; width: number; height: number; full: null; sample: null } | null,
  /** Final "unsupported" markers, as "decoder key". */
  marked: new Set<string>(),
  /** Each marker lookup, as "kind decoder key". */
  lookups: [] as string[],
  /** Each marker stored, as "kind decoder key". */
  marks: [] as string[],
  /** The key of each cache read. */
  reads: [] as string[],
  /** Each cache write: its key and the verdicts it clears. */
  writes: [] as { key: string; verdicts: { markerKey: string; decoder?: string } | undefined }[],
  /** Each float decode's request and path. */
  decodes: [] as { request: RawDecodeRequest | undefined; path: string | undefined }[],
  decodeResult: (): RawFloatImage | DecodeFailure => ({ failure: "unsupported" }),
  verdict: { use: true, cache: true } as { use: boolean; cache: boolean; match?: CameraMatch },
  cacheMatch: undefined as CameraMatch | undefined,
  preview: null as Blob | null,
}));

vi.mock("./permissions", () => ({ verifyPermission: async () => true }));

vi.mock("@/raw/raw-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/raw/raw-cache")>();
  return {
    rawCacheKey: actual.rawCacheKey,
    decoderMarkerId: actual.decoderMarkerId,
    DECODER_ID: actual.DECODER_ID,
    rawCacheGeneration: () => 1,
    readCachedPreview: async (key: string) => {
      h.reads.push(key);
      return h.cached;
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
      h.writes.push({ key, verdicts });
      return true;
    },
    hasDecodeMarker: async (key: string, kind: string, decoder = actual.DECODER_ID) => {
      h.lookups.push(`${kind} ${decoder} ${key}`);
      return kind === "unsupported" && h.marked.has(`${decoder} ${key}`);
    },
    markDecode: async (key: string, kind: string, _begunIn: number, decoder = actual.DECODER_ID) => {
      h.marks.push(`${kind} ${decoder} ${key}`);
    },
  };
});

vi.mock("@/raw/decode", () => ({
  decodeRawToBitmap: async () => null,
  decodeRawToFloat: async (_file: Blob, request?: RawDecodeRequest, path?: string) => {
    h.decodes.push({ request, path });
    return h.decodeResult();
  },
}));

vi.mock("@/raw/accept-decode", () => ({
  acceptDecode: async () => h.verdict,
  matchCameraPreview: async () => h.cacheMatch,
}));

vi.mock("@/raw/raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/raw/raw-preview")>()),
  extractRawPreview: async () => h.preview,
}));

vi.mock("./storage", () => ({ catalogStorage: () => ({ putPhoto: async () => {} }) }));

vi.mock("@/state/catalog-store", () => ({
  useCatalogStore: { getState: () => ({ photos: [] }) },
}));

import { loadPhotoImage, photoSourceKey } from "./load-image";

const EXTENSION = "ext.raw/fast@1.2.0";
const LIBRAW = "libraw-0.22.1+1";
const SIGNATURE = `${EXTENSION}>libraw`;
const KEY = "v6:DSC00001.NEF:8:0";
const SIGNED_KEY = `${KEY}:${SIGNATURE}`;
const embeddedJpeg = new Blob(["jpeg"], { type: "image/jpeg" });

function floatDecode(extra: Partial<RawFloatImage> = {}): RawFloatImage {
  return { data: new Float32Array(4 * 2 * 4).fill(0.18), width: 4, height: 2, oriented: true, ...extra };
}

function photo(exif: CatalogPhoto["exif"] = {}): CatalogPhoto {
  const name = "DSC00001.NEF";
  const file = new File([new Uint8Array(8)], name);
  return {
    id: "p1",
    filename: name,
    relPath: name,
    folder: "",
    directoryHandle: null,
    fileHandle: { kind: "file", name, getFile: async () => file } as FileSystemFileHandle,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 8,
    mimeType: "",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 0,
    dateImported: 0,
    exif,
  };
}

const extensionFirst = (): void => useSettings.setState({ decoderOrder: { nef: ["ext.raw/fast", "libraw"] } });

beforeEach(() => {
  h.cached = null;
  h.marked = new Set();
  h.lookups = [];
  h.marks = [];
  h.reads = [];
  h.writes = [];
  h.decodes = [];
  h.decodeResult = () => ({ failure: "unsupported" });
  h.verdict = { use: true, cache: true };
  h.cacheMatch = undefined;
  h.preview = embeddedJpeg;
  useSettings.setState({ decoderOrder: {}, rawCacheEnabled: true });
  registerImageDecoder("ext.raw", {
    id: "fast",
    label: "Fast",
    version: "1.2.0",
    extensions: [".nef"],
    decode: async () => null,
  });
  vi.stubGlobal("createImageBitmap", async (): Promise<ImageBitmap> => ({ width: 6000, height: 4000, close() {} }) as ImageBitmap);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  dropImageDecoders("ext.raw");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("photoSourceKey of a RAW", () => {
  it("stays as it was while libraw leads", () => {
    expect(photoSourceKey(photo())).toBe("p1:0");
  });

  it("names the decoders once an extension's leads", () => {
    extensionFirst();

    expect(photoSourceKey(photo())).toBe(`p1:0:d${SIGNATURE}`);
  });
});

describe("loadPhotoImage once an extension's decoder leads", () => {
  beforeEach(extensionFirst);

  it("reads the cache entry kept for the chain and asks each decoder's marker", async () => {
    h.decodeResult = () => floatDecode({ decoder: EXTENSION });

    await loadPhotoImage(photo());

    expect(h.reads).toEqual([SIGNED_KEY]);
    expect(h.lookups).toEqual([`unsupported ${EXTENSION} ${KEY}`, `unsupported ${LIBRAW} ${KEY}`]);
  });

  it("asks the decode to pass by a decoder that failed on the photo for good, with the photo's white balance", async () => {
    h.marked.add(`${EXTENSION} ${KEY}`);
    h.decodeResult = () => floatDecode({ decoder: LIBRAW });

    await loadPhotoImage(photo({ asShotMultipliers: [2, 1, 1.5] }));

    expect(h.decodes).toHaveLength(1);
    expect([...(h.decodes[0].request?.ruledOut ?? [])]).toEqual([EXTENSION]);
    expect(h.decodes[0].request?.asShotMultipliers).toEqual([2, 1, 1.5]);
  });

  it("opens the camera's preview without decoding once every decoder has", async () => {
    h.marked.add(`${EXTENSION} ${KEY}`);
    h.marked.add(`${LIBRAW} ${KEY}`);

    const image = await loadPhotoImage(photo());

    expect(h.decodes).toEqual([]);
    expect(image).toMatchObject({ kind: "bitmap", fallback: { from: "embedded", unsupported: true } });
  });

  it("strikes each decoder that found nothing usable", async () => {
    h.decodeResult = () => ({ failure: "unsupported", unsupportedBy: [EXTENSION, LIBRAW] });

    await loadPhotoImage(photo());

    expect(h.marks).toEqual([`unsupported ${EXTENSION} ${KEY}`, `unsupported ${LIBRAW} ${KEY}`]);
  });

  it("strikes a decoder that failed ahead of the one that answered", async () => {
    h.decodeResult = () => floatDecode({ decoder: LIBRAW, unsupportedBy: [EXTENSION] });

    await loadPhotoImage(photo());

    expect(h.marks).toEqual([`unsupported ${EXTENSION} ${KEY}`]);
  });

  it("strikes the decoder whose colours didn't match the camera's preview", async () => {
    h.decodeResult = () => floatDecode({ decoder: EXTENSION });
    h.verdict = { use: false, cache: false };

    await loadPhotoImage(photo());

    expect(h.marks).toEqual([`unsupported ${EXTENSION} ${KEY}`]);
  });

  it("marks the decoder whose decode was marginal", async () => {
    h.decodeResult = () => floatDecode({ decoder: EXTENSION });
    h.verdict = { use: true, cache: false };

    await loadPhotoImage(photo());

    expect(h.marks).toEqual([`suspicious ${EXTENSION} ${KEY}`]);
  });

  it("writes the entry for the chain and clears the verdicts of the decoder that made it", async () => {
    h.decodeResult = () => floatDecode({ decoder: EXTENSION, signature: SIGNATURE });

    await loadPhotoImage(photo());

    expect(h.writes).toEqual([{ key: SIGNED_KEY, verdicts: { markerKey: KEY, decoder: EXTENSION } }]);
  });

  it("asks the decode for the photo's orientation, for a frame its decoder leaves unturned", async () => {
    h.decodeResult = () => floatDecode({ decoder: EXTENSION, signature: SIGNATURE });

    await loadPhotoImage(photo({ orientation: 6 }));

    expect(h.decodes[0].request?.orientation).toBe(6);
  });

  it("keeps a decode made under other decoders out of the chain's entry and camera match", async () => {
    h.decodeResult = () => floatDecode({ decoder: LIBRAW });
    h.verdict = { use: true, cache: true, match: { exposure: 0.4, shadows: 10 } };
    const p = photo();

    const image = await loadPhotoImage(p);

    expect(image).toMatchObject({ kind: "float" });
    expect(h.writes).toEqual([]);
    expect(p.exif).not.toHaveProperty("cameraMatchVersion");
  });

  it("keeps the white balance the decoder reports for a photo that had none", async () => {
    h.decodeResult = () => floatDecode({ decoder: EXTENSION, asShotMultipliers: [2.2, 1, 1.3], colorTemperature: 4700 });
    const p = photo();

    await loadPhotoImage(p);

    expect(p.exif).toMatchObject({ asShotMultipliers: [2.2, 1, 1.3], colorTemperature: 4700 });
  });
});

describe("loadPhotoImage and the camera match", () => {
  const librawMatched = (): CatalogPhoto =>
    photo({ cameraMake: "Acme", baselineExposure: 1.5, baselineShadows: 20, cameraMatchVersion: CAMERA_MATCH_VERSION });

  it("keeps libraw's match while libraw leads", async () => {
    h.decodeResult = () => floatDecode();
    h.verdict = { use: true, cache: true, match: { exposure: 0.4, shadows: 0 } };

    expect(await loadPhotoImage(librawMatched())).toMatchObject({ baselineExposure: 1.5, baselineShadows: 20 });
  });

  it("learns it again for an extension's decode, and keeps which decoders it was learned under", async () => {
    extensionFirst();
    h.decodeResult = () => floatDecode({ decoder: EXTENSION, signature: SIGNATURE });
    h.verdict = { use: true, cache: true, match: { exposure: 0.4, shadows: 10 } };
    const p = librawMatched();

    expect(await loadPhotoImage(p)).toMatchObject({ baselineExposure: 0.4, baselineShadows: 10 });
    expect(p.exif).toMatchObject({ baselineExposure: 0.4, cameraMatchDecoders: SIGNATURE });
  });

  it("doesn't render an extension's cached decode with libraw's match", async () => {
    extensionFirst();
    h.cached = { data: new Uint16Array(4 * 2 * 4), width: 4, height: 2, full: null, sample: null };
    h.cacheMatch = undefined;

    const image = await loadPhotoImage(librawMatched());

    expect(image).toMatchObject({ kind: "float16" });
    expect(image).not.toHaveProperty("baselineExposure");
  });

  it("doesn't learn libraw's from an extension's decode begun before libraw led again", async () => {
    h.decodeResult = () => floatDecode({ decoder: EXTENSION, signature: SIGNATURE });
    h.verdict = { use: true, cache: true, match: { exposure: 0.9, shadows: 0 } };
    const p = photo({ baselineExposure: 0.4, baselineShadows: 10, cameraMatchVersion: CAMERA_MATCH_VERSION, cameraMatchDecoders: SIGNATURE });

    await loadPhotoImage(p);

    expect(p.exif).toMatchObject({ baselineExposure: 0.4, cameraMatchDecoders: SIGNATURE });
    expect(h.writes).toEqual([]);
  });

  it("learns libraw's again once libraw leads once more", async () => {
    h.decodeResult = () => floatDecode();
    h.verdict = { use: true, cache: true, match: { exposure: 0.9, shadows: 0 } };
    const p = photo({ baselineExposure: 0.4, baselineShadows: 10, cameraMatchVersion: CAMERA_MATCH_VERSION, cameraMatchDecoders: SIGNATURE });

    expect(await loadPhotoImage(p)).toMatchObject({ baselineExposure: 0.9 });
    expect(p.exif.cameraMatchDecoders).toBeUndefined();
  });
});
