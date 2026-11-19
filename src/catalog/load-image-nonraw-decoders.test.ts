// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop's open of a non-RAW photo follows its format's decoder order: a HEIC
// through the HEIF worker as display-referred halves, turned by its manual
// turns alone (its own rotation is applied in the decode), and extension
// decoders before or after core's. Input profiles belong to core's 8-bit
// decoders. The HEIF bridge and the browser decode are faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "./types";
import type { DecodedImageResult, ImageDecoderContribution } from "@/extensions/api/library";
import { dropImageDecoders, registerImageDecoder } from "./image-decoders";
import { dropInputProfiles, registerInputProfiles } from "./input-profiles";
import { useSettings } from "@/state/settings-store";

const h = vi.hoisted(() => ({
  heifFrame: vi.fn(),
  linearFrame: vi.fn(),
  browserDecodes: 0,
}));

vi.mock("./permissions", () => ({ verifyPermission: async () => true }));

vi.mock("@/raw/heif-bridge", () => ({
  decodeHeifFrame: h.heifFrame,
  convertLinearFrame: h.linearFrame,
}));

vi.mock("./storage", () => ({ catalogStorage: () => ({ putPhoto: async () => {} }) }));

vi.mock("@/state/catalog-store", () => ({
  useCatalogStore: { getState: () => ({ photos: [] }) },
}));

import { loadPhotoImage, photoSourceKey } from "./load-image";

const half = (width: number, height: number) => ({
  data: new Uint16Array(width * height * 4),
  width,
  height,
  fullWidth: width * 10,
  fullHeight: height * 10,
});

const bitmap = (width: number, height: number) => ({ width, height, close() {} }) as ImageBitmap;

function photo(name: string, over: Partial<CatalogPhoto> = {}): CatalogPhoto {
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
    width: 4032,
    height: 3024,
    fileSize: 8,
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

function decoder(extensions: string[], answer: () => DecodedImageResult | null): ImageDecoderContribution {
  return { id: "dec", label: "Ext decoder", extensions, decode: async () => answer() };
}

beforeEach(() => {
  useSettings.setState({ decoderOrder: {} });
  h.browserDecodes = 0;
  h.heifFrame.mockReset();
  h.linearFrame.mockReset();
  vi.stubGlobal("createImageBitmap", async () => {
    h.browserDecodes++;
    return bitmap(30, 20);
  });
  vi.stubGlobal(
    "ImageData",
    class {
      readonly data: Uint8ClampedArray;
      readonly width: number;
      readonly height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    },
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  dropImageDecoders("ext.a");
  dropInputProfiles("ext.profiles");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a HEIC in Develop", () => {
  it("decodes in the HEIF worker as display-referred halves, turned by its manual turns only", async () => {
    h.heifFrame.mockResolvedValue({ ok: true, frame: half(4, 3), sourceWidth: 3024, sourceHeight: 4032, hdr: false });
    const p = photo("IMG_1.HEIC", { exif: { orientation: 6 }, rotation: 180 });
    const image = await loadPhotoImage(p, { targetEdge: 2048 });
    expect(h.heifFrame).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ targetEdge: 2048, turn: 90, background: false }),
    );
    expect(image).toMatchObject({ kind: "float16", width: 4, height: 3, displayReferred: true, fullWidth: 40 });
    expect(image).not.toHaveProperty("hdrShownAsSdr");
  });

  it("says when an HDR HEIF is shown without its HDR", async () => {
    h.heifFrame.mockResolvedValue({ ok: true, frame: half(4, 3), sourceWidth: 40, sourceHeight: 30, hdr: true });
    expect(await loadPhotoImage(photo("C0001.HIF"))).toMatchObject({ kind: "float16", hdrShownAsSdr: true });
  });

  it("isn't handed to the input profile resolver", async () => {
    const resolve = vi.fn(async () => null);
    registerInputProfiles("ext.profiles", { resolve });
    h.heifFrame.mockResolvedValue({ ok: true, frame: half(4, 3), sourceWidth: 40, sourceHeight: 30, hdr: false });
    await loadPhotoImage(photo("a.heic"));
    expect(resolve).not.toHaveBeenCalled();
  });

  it("passes to an extension decoder when the worker can't read it", async () => {
    h.heifFrame.mockResolvedValue({ ok: false, reason: "bad" });
    registerImageDecoder(
      "ext.a",
      decoder([".heic"], () => ({ kind: "linear", width: 2, height: 2, data: new Float32Array(16), oriented: true })),
    );
    h.linearFrame.mockResolvedValue({ ok: true, frame: half(2, 2) });
    const image = await loadPhotoImage(photo("a.heic", { exif: { orientation: 6 }, rotation: 90 }));
    expect(h.linearFrame).toHaveBeenCalledWith(expect.any(Float32Array), 2, 2, expect.objectContaining({ turn: 0 }));
    expect(image).toMatchObject({ kind: "float16", displayReferred: true });
  });
});

describe("a JPEG with an extension decoder", () => {
  it("decodes with the extension's when the person put it first, as a bitmap turned by the photo's rotation", async () => {
    registerImageDecoder(
      "ext.a",
      decoder([".jpg"], () => ({ kind: "rgba8", width: 2, height: 1, data: new Uint8ClampedArray(8), oriented: false })),
    );
    useSettings.setState({ decoderOrder: { jpeg: ["ext.a/dec", "browser"] } });
    const image = await loadPhotoImage(photo("a.jpg"));
    expect(image).toMatchObject({ kind: "bitmap" });
    expect(image).not.toHaveProperty("fallback");
  });

  it("falls back to the browser when the extension's reads nothing", async () => {
    registerImageDecoder("ext.a", decoder([".jpg"], () => null));
    useSettings.setState({ decoderOrder: { jpeg: ["ext.a/dec", "browser"] } });
    const image = await loadPhotoImage(photo("a.jpg"));
    expect(image).toMatchObject({ kind: "bitmap" });
    expect(h.browserDecodes).toBeGreaterThan(0);
  });

  it("keeps the browser's decode while core's leads, with the extension's after it", async () => {
    const decode = vi.fn(async () => null);
    registerImageDecoder("ext.a", { ...decoder([".jpg"], () => null), decode });
    await loadPhotoImage(photo("a.jpg"));
    expect(decode).not.toHaveBeenCalled();
  });
});

describe("the GPU source key of a non-RAW photo", () => {
  it("is as before while core's decoder leads", () => {
    registerImageDecoder("ext.a", decoder([".heic"], () => null));
    expect(photoSourceKey(photo("a.heic"))).toBe("p1:0");
  });

  it("carries the chain's signature once an extension decoder leads", () => {
    registerImageDecoder("ext.a", { ...decoder([".heic"], () => null), version: "2" });
    useSettings.setState({ decoderOrder: { heif: ["ext.a/dec", "heif"] } });
    expect(photoSourceKey(photo("a.heic"))).toBe("p1:0:dext.a/dec@2>heif");
  });

  it("keeps the input profile revision while core's 8-bit decoder may still read the file", () => {
    registerInputProfiles("ext.profiles", { resolve: async () => null });
    const profiles = photoSourceKey(photo("a.jpg")).slice("p1:0".length);
    registerImageDecoder("ext.a", decoder([".jpg"], () => null));
    useSettings.setState({ decoderOrder: { jpeg: ["ext.a/dec", "browser"] } });
    expect(profiles).not.toBe("");
    expect(photoSourceKey(photo("a.jpg"))).toBe(`p1:0:dext.a/dec@1>browser${profiles}`);
  });

  it("leaves the input profile revision out of a HEIC's", () => {
    registerInputProfiles("ext.profiles", { resolve: async () => null });
    expect(photoSourceKey(photo("a.heic"))).toBe("p1:0");
  });
});
