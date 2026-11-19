// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A non-RAW grid preview follows its format's decoder order: core's own
// decoders, the HEIF worker, and extension decoders, each passing a file it
// can't read to the next. The HEIF bridge, the thumbnail pool and the browser
// decode are faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecodedImageResult, ImageDecoderContribution } from "@/extensions/api/library";
import { dropImageDecoders, registerImageDecoder } from "@/catalog/image-decoders";

const h = vi.hoisted(() => ({
  decoderOrder: {} as Record<string, string[]>,
  heifThumb: vi.fn(),
  pixelsThumb: vi.fn(),
  processThumb: vi.fn(),
  browserDecodes: 0,
}));

vi.mock("@/raw/heif-bridge", () => ({
  decodeHeifThumb: h.heifThumb,
  convertPixelsThumb: h.pixelsThumb,
}));

vi.mock("./import-thumb-pool", () => ({ processThumb: h.processThumb }));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ previewSource: "auto", thumbMaxEdge: 640, decoderOrder: h.decoderOrder }),
  useSettings: { subscribe: () => () => {} },
}));

import { decodeImportBitmap, workerThumb } from "./import-decode";

const bitmap = (width: number, height: number) => ({ width, height, close() {} }) as ImageBitmap;

const file = (name: string) => new File([new Uint8Array([1, 2, 3])], name);

function decoder(extensions: string[], answer: DecodedImageResult | null): ImageDecoderContribution {
  return { id: "dec", label: "Ext decoder", extensions, decode: async () => answer };
}

const rgba = (width: number, height: number, oriented: boolean): DecodedImageResult => ({
  kind: "rgba8",
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4),
  oriented,
});

beforeEach(() => {
  h.decoderOrder = {};
  h.browserDecodes = 0;
  h.heifThumb.mockReset();
  h.pixelsThumb.mockReset();
  h.processThumb.mockReset().mockResolvedValue({ ok: true, thumb: new Blob(), width: 10, height: 8 });
  vi.stubGlobal("createImageBitmap", async () => {
    h.browserDecodes++;
    return bitmap(30, 20);
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  dropImageDecoders("ext.a");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a non-RAW grid preview", () => {
  it("decodes a HEIC in the HEIF worker at the thumbnail size, upright, with its full size", async () => {
    h.heifThumb.mockResolvedValue({ ok: true, bitmap: bitmap(480, 640), width: 480, height: 640, sourceWidth: 3024, sourceHeight: 4032 });
    const decoded = await decodeImportBitmap(file("IMG_1.HEIC"), 6, { background: true });
    expect(h.heifThumb).toHaveBeenCalledWith(expect.any(File), expect.objectContaining({ maxEdge: 640, background: true }));
    expect(decoded).toMatchObject({ oriented: true, sourceWidth: 3024, sourceHeight: 4032 });
  });

  it("passes a HEIC the worker can't read to an extension decoder after it", async () => {
    h.heifThumb.mockResolvedValue({ ok: false, reason: "bad" });
    registerImageDecoder("ext.a", decoder([".heic"], rgba(40, 30, true)));
    h.pixelsThumb.mockResolvedValue({ ok: true, bitmap: bitmap(40, 30), width: 40, height: 30 });
    const decoded = await decodeImportBitmap(file("a.heic"), 1);
    expect(h.pixelsThumb).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rgba8", width: 40, height: 30 }),
      expect.objectContaining({ maxEdge: 640 }),
    );
    expect(decoded).toMatchObject({ oriented: true, sourceWidth: 40, sourceHeight: 30 });
  });

  it("tries an extension decoder the person put first ahead of the browser", async () => {
    registerImageDecoder("ext.a", decoder([".jpg"], rgba(40, 30, false)));
    h.decoderOrder = { jpeg: ["ext.a/dec", "browser"] };
    h.pixelsThumb.mockResolvedValue({ ok: true, bitmap: bitmap(40, 30), width: 40, height: 30 });
    const decoded = await decodeImportBitmap(file("a.jpg"), 1);
    expect(decoded).toMatchObject({ oriented: false });
    expect(h.browserDecodes).toBe(0);
  });

  it("falls back to the browser when the extension decoder put first reads nothing", async () => {
    registerImageDecoder("ext.a", decoder([".jpg"], null));
    h.decoderOrder = { jpeg: ["ext.a/dec", "browser"] };
    const decoded = await decodeImportBitmap(file("a.jpg"), 1);
    expect(decoded).toMatchObject({ oriented: false });
    expect(h.browserDecodes).toBe(1);
  });

  it("gives nothing when every decoder fails", async () => {
    h.heifThumb.mockResolvedValue({ ok: false, reason: "bad" });
    registerImageDecoder("ext.a", decoder([".heic"], null));
    expect(await decodeImportBitmap(file("a.heic"), 1)).toBeNull();
  });
});

describe("the import worker pool", () => {
  it("takes a JPEG while the browser decode leads its chain", async () => {
    expect(await workerThumb(file("a.jpg"), 1)).not.toBeNull();
    expect(h.processThumb).toHaveBeenCalled();
  });

  it("leaves a HEIC and a format an extension decoder leads to the decoder chain, unread", async () => {
    registerImageDecoder("ext.a", decoder([".png"], null));
    h.decoderOrder = { png: ["ext.a/dec"] };
    expect(await workerThumb(file("a.heic"), 1)).toBeNull();
    expect(await workerThumb(file("a.png"), 1)).toBeNull();
    expect(h.processThumb).not.toHaveBeenCalled();
  });
});
