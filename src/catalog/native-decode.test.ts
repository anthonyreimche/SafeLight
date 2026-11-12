// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A photo's RAW decoded at full size for the detail overlay: the decoder, the
// permission check, the library sources and the luminance encoder are faked,
// and the cache and catalogue writers are watched to stay untouched.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "./types";
import type { RawFloatImage } from "@/raw/decode";
import type { DecodeFailure } from "@/raw/decode-result";

interface Request {
  background?: boolean;
  signal?: AbortSignal;
  turn?: number;
  cacheEdge?: number;
  targetEdge?: number;
}

const h = vi.hoisted(() => ({
  permission: true,
  held: true,
  isSource: false,
  decodes: [] as { request: Request | undefined; path: string | undefined }[],
  decodeResult: (): Promise<unknown> => Promise.resolve(null),
  encodes: [] as { data: Float32Array; priority: { background?: boolean; signal?: AbortSignal } | undefined }[],
  encodeResult: (): Promise<Uint16Array> => Promise.resolve(new Uint16Array(0)),
  fileReads: 0,
  forbidden: {
    readCachedPreview: vi.fn(),
    writeCachedPreview: vi.fn(),
    markDecode: vi.fn(),
    hasDecodeMarker: vi.fn(),
    rememberLearned: vi.fn(),
    rememberSourceFrame: vi.fn(),
    acceptDecode: vi.fn(),
    matchCameraPreview: vi.fn(),
    extractRawPreview: vi.fn(),
    extractRawPreviewDecoded: vi.fn(),
  },
}));

vi.mock("./permissions", () => ({ verifyPermission: async () => h.permission }));

vi.mock("@/project/library-sources", () => ({
  isSourceFile: () => h.isSource,
  sourceOriginalHeld: async () => h.held,
}));

vi.mock("@/raw/decode", () => ({
  decodeRawToFloat: async (_file: Blob, request: Request | undefined, path: string | undefined) => {
    h.decodes.push({ request, path });
    return h.decodeResult();
  },
}));

vi.mock("@/raw/frame-bridge", () => ({
  encodeFrameLuma: async (data: Float32Array, priority: { background?: boolean; signal?: AbortSignal } | undefined) => {
    h.encodes.push({ data, priority });
    return h.encodeResult();
  },
}));

vi.mock("@/raw/raw-cache", () => ({
  readCachedPreview: h.forbidden.readCachedPreview,
  writeCachedPreview: h.forbidden.writeCachedPreview,
  markDecode: h.forbidden.markDecode,
  hasDecodeMarker: h.forbidden.hasDecodeMarker,
}));

vi.mock("./decode-learned", () => ({
  rememberLearned: h.forbidden.rememberLearned,
  rememberSourceFrame: h.forbidden.rememberSourceFrame,
}));

vi.mock("@/raw/accept-decode", () => ({
  acceptDecode: h.forbidden.acceptDecode,
  matchCameraPreview: h.forbidden.matchCameraPreview,
}));

vi.mock("@/raw/raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/raw/raw-preview")>()),
  extractRawPreview: h.forbidden.extractRawPreview,
  extractRawPreviewDecoded: h.forbidden.extractRawPreviewDecoded,
}));

import { decodeNativeFrame } from "./native-decode";

const file = new File(["raw"], "a.NEF");

function handleOf(getFile: () => Promise<File>): FileSystemFileHandle {
  const partial: Partial<FileSystemFileHandle> = { kind: "file", name: "a.NEF", getFile };
  return partial as FileSystemFileHandle;
}

function photo(over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
    id: "p1",
    filename: "a.NEF",
    relPath: "Trip/a.NEF",
    folder: "Trip",
    directoryHandle: {} as FileSystemDirectoryHandle,
    fileHandle: handleOf(async () => {
      h.fileReads++;
      return file;
    }),
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 0,
    mimeType: "",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 0,
    dateImported: 0,
    exif: {},
    ...over,
  };
}

function frame(over: Partial<RawFloatImage> = {}): RawFloatImage {
  return { data: new Float32Array(2 * 1 * 4).fill(0.5), width: 2, height: 1, oriented: true, ...over };
}

const live = { signal: new AbortController().signal, background: false };

beforeEach(() => {
  h.permission = true;
  h.held = true;
  h.isSource = false;
  h.decodes = [];
  h.encodes = [];
  h.fileReads = 0;
  h.decodeResult = async () => frame();
  h.encodeResult = async () => Uint16Array.of(1, 2);
  for (const fn of Object.values(h.forbidden)) fn.mockReset();
});

describe("decodeNativeFrame", () => {
  it("returns the frame's luminance halves at its size", async () => {
    const out = await decodeNativeFrame(photo(), live);

    expect(out).toEqual({ data: Uint16Array.of(1, 2), width: 2, height: 1 });
  });

  describe("photos that cannot give a frame", () => {
    it("misses for good on a photo that is not a RAW", async () => {
      expect(await decodeNativeFrame(photo({ filename: "a.jpg" }), live)).toEqual({ miss: "never" });
      expect(h.decodes).toHaveLength(0);
    });

    it("misses for good on a photo with no file handle", async () => {
      expect(await decodeNativeFrame(photo({ fileHandle: undefined }), live)).toEqual({ miss: "never" });
      expect(h.decodes).toHaveLength(0);
    });

    it("misses for good when access to the original is not granted, without asking for it", async () => {
      h.permission = false;

      expect(await decodeNativeFrame(photo(), live)).toEqual({ miss: "never" });
      expect(h.fileReads).toBe(0);
      expect(h.decodes).toHaveLength(0);
    });

    it("misses for good on a library source's original that is not held, reading nothing", async () => {
      h.isSource = true;
      h.held = false;

      expect(await decodeNativeFrame(photo(), live)).toEqual({ miss: "never" });
      expect(h.fileReads).toBe(0);
      expect(h.decodes).toHaveLength(0);
    });

    it("decodes a library source's original that is held", async () => {
      h.isSource = true;

      expect(await decodeNativeFrame(photo(), live)).toMatchObject({ width: 2 });
    });

    it("misses for good on a file that cannot be read", async () => {
      const unreadable = photo({
        fileHandle: handleOf(async () => {
          throw new Error("gone");
        }),
      });

      expect(await decodeNativeFrame(unreadable, live)).toEqual({ miss: "never" });
    });
  });

  describe("an abandoned request", () => {
    it("misses for a retry before anything is called", async () => {
      const gone = new AbortController();
      gone.abort();

      expect(await decodeNativeFrame(photo(), { signal: gone.signal, background: false })).toEqual({ miss: "retry" });
      expect(h.fileReads).toBe(0);
      expect(h.decodes).toHaveLength(0);
      expect(h.encodes).toHaveLength(0);
    });

    it("misses for a retry when abandoned while the original is read, decoding nothing", async () => {
      const gone = new AbortController();
      const p = photo({
        fileHandle: handleOf(async () => {
          gone.abort();
          return file;
        }),
      });

      expect(await decodeNativeFrame(p, { signal: gone.signal, background: false })).toEqual({ miss: "retry" });
      expect(h.decodes).toHaveLength(0);
    });

    it("misses for a retry when abandoned during the decode, encoding nothing", async () => {
      const gone = new AbortController();
      h.decodeResult = async () => {
        gone.abort();
        return frame();
      };

      expect(await decodeNativeFrame(photo(), { signal: gone.signal, background: false })).toEqual({ miss: "retry" });
      expect(h.encodes).toHaveLength(0);
    });

    it("misses for a retry when abandoned during the encode", async () => {
      const gone = new AbortController();
      h.encodeResult = async () => {
        gone.abort();
        return new Uint16Array(2);
      };

      expect(await decodeNativeFrame(photo(), { signal: gone.signal, background: false })).toEqual({ miss: "retry" });
    });
  });

  describe("the decode request", () => {
    it("asks for the full frame with no cache entry, under the caller's signal and priority", async () => {
      const ctl = new AbortController();

      await decodeNativeFrame(photo(), { signal: ctl.signal, background: true });

      expect(h.decodes).toEqual([{ request: { background: true, signal: ctl.signal }, path: "Trip/a.NEF" }]);
    });

    it("asks for the manual turn the way the open does, leaving out a zero turn", async () => {
      h.decodeResult = async () => frame({ turned: 90 });

      await decodeNativeFrame(photo({ rotation: 90, exif: { orientation: 1 } }), live);

      expect(h.decodes[0].request).toMatchObject({ turn: 90 });
      expect(h.decodes[0].request).not.toHaveProperty("cacheEdge");
      expect(h.decodes[0].request).not.toHaveProperty("targetEdge");
      h.decodes = [];

      await decodeNativeFrame(photo({ rotation: 0, exif: { orientation: 1 } }), live);

      expect(h.decodes[0].request).not.toHaveProperty("turn");
    });

    it("takes the camera's own orientation off the turn, as the decoder applies it", async () => {
      await decodeNativeFrame(photo({ rotation: 90, exif: { orientation: 6 } }), live);

      expect(h.decodes[0].request).not.toHaveProperty("turn");
    });
  });

  describe("a failed decode", () => {
    const failed = (f: DecodeFailure) => () => Promise.resolve(f);

    it.each([
      ["passed over", { failure: "transient", passedOver: true } as DecodeFailure, "retry"],
      ["aborted", { failure: "aborted" } as DecodeFailure, "retry"],
      ["transient", { failure: "transient", reason: "busy" } as DecodeFailure, "retry"],
      ["unsupported", { failure: "unsupported", reason: "no" } as DecodeFailure, "never"],
    ])("misses on a decode that was %s", async (_name, failure, miss) => {
      h.decodeResult = failed(failure);

      expect(await decodeNativeFrame(photo(), live)).toEqual({ miss });
      expect(h.encodes).toHaveLength(0);
    });

    it("misses for a retry when the decode throws", async () => {
      h.decodeResult = () => Promise.reject(new Error("worker lost"));

      expect(await decodeNativeFrame(photo(), live)).toEqual({ miss: "retry" });
    });
  });

  describe("a frame that is not usable as it is", () => {
    it.each([
      ["not oriented", { oriented: false }],
      ["not oriented, unset", { oriented: undefined }],
      ["half size", { halfSize: true }],
      ["suspicious", { suspicious: true }],
    ])("misses for good on a frame that is %s", async (_name, over) => {
      h.decodeResult = async () => frame(over);

      expect(await decodeNativeFrame(photo(), live)).toEqual({ miss: "never" });
      expect(h.encodes).toHaveLength(0);
    });

    it("misses for good on a frame above the held-pixel limit, encoding nothing", async () => {
      h.decodeResult = async () => frame({ width: 8001, height: 8000 });

      expect(await decodeNativeFrame(photo(), live)).toEqual({ miss: "never" });
      expect(h.encodes).toHaveLength(0);
    });

    it("encodes a frame of exactly the limit", async () => {
      h.decodeResult = async () => frame({ width: 8000, height: 8000 });

      expect(await decodeNativeFrame(photo(), live)).toMatchObject({ width: 8000, height: 8000 });
    });

    it("misses for good when the requested turn was not applied", async () => {
      h.decodeResult = async () => frame();

      expect(await decodeNativeFrame(photo({ rotation: 90, exif: { orientation: 1 } }), live)).toEqual({
        miss: "never",
      });
      expect(h.encodes).toHaveLength(0);
    });

    it("misses for good when only part of the requested turn was applied", async () => {
      h.decodeResult = async () => frame({ turned: 90 });

      expect(await decodeNativeFrame(photo({ rotation: 180, exif: { orientation: 1 } }), live)).toEqual({
        miss: "never",
      });
    });

    it("misses for good when a turn was applied that was not asked for", async () => {
      h.decodeResult = async () => frame({ turned: 90 });

      expect(await decodeNativeFrame(photo(), live)).toEqual({ miss: "never" });
    });
  });

  describe("the encode", () => {
    it("hands the frame's floats over at the priority of the request", async () => {
      const ctl = new AbortController();
      const f = frame();
      h.decodeResult = async () => f;

      await decodeNativeFrame(photo(), { signal: ctl.signal, background: true });
      await decodeNativeFrame(photo(), { signal: ctl.signal, background: false });

      expect(h.encodes.map((e) => e.data)).toEqual([f.data, f.data]);
      expect(h.encodes.map((e) => e.priority?.background ?? false)).toEqual([true, false]);
      expect(h.encodes.map((e) => e.priority?.signal)).toEqual([ctl.signal, ctl.signal]);
    });

    it("misses for a retry when the encode fails", async () => {
      h.encodeResult = () => Promise.reject(new Error("boom"));

      expect(await decodeNativeFrame(photo(), live)).toEqual({ miss: "retry" });
    });

    it("misses for a retry when the encode was abandoned while it waited", async () => {
      h.encodeResult = () => Promise.reject(new DOMException("the decode was abandoned", "AbortError"));

      expect(await decodeNativeFrame(photo(), live)).toEqual({ miss: "retry" });
    });
  });

  describe("side effects", () => {
    it("writes no cache entry, marker or catalogue field, and reads no preview, whatever the outcome", async () => {
      const results: (() => Promise<unknown>)[] = [
        async () => frame(),
        async () => ({ failure: "unsupported" }) satisfies DecodeFailure,
        async () => ({ failure: "transient", passedOver: true }) satisfies DecodeFailure,
        async () => frame({ suspicious: true }),
      ];
      for (const result of results) {
        h.decodeResult = result;
        await decodeNativeFrame(photo(), live);
      }

      for (const [name, fn] of Object.entries(h.forbidden)) expect([name, fn.mock.calls.length]).toEqual([name, 0]);
    });
  });
});
