// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A RAW decoded by the decoders the person ordered for its format: libraw and
// an extension's (api.library.registerDecoder). Each is tried in turn until one
// answers; the photo fails only when every one does. libraw is faked; the
// extension's frame is finished inline, as where there is no Worker. Each test
// names its own files: what decode.ts remembers lasts the session.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecodedImageResult, ImageDecodeRequest } from "@/extensions/api/library";
import { dropImageDecoders, registerImageDecoder } from "@/catalog/image-decoders";
import { rotateFloatRGBA } from "@/catalog/orient";
import { useSettings } from "@/state/settings-store";
import { encodeCacheEntry } from "./cache-encode";
import type { DecodeFailure, RawFloatImage } from "./decode-result";

const h = vi.hoisted(() => ({
  /** The file each libraw decode was asked for, in order. */
  libraw: [] as string[],
  librawAnswer: null as (() => Promise<RawFloatImage | DecodeFailure>) | null,
  /** The request each extension decode was asked with, in order. */
  extension: [] as { name: string; request: ImageDecodeRequest }[],
  extensionAnswer: null as ((request: ImageDecodeRequest) => Promise<DecodedImageResult | null>) | null,
}));

vi.mock("./libraw-wasm-adapter", () => ({
  decodeRawFloatViaLibRaw: async (buffer: ArrayBuffer) => {
    h.libraw.push(new TextDecoder().decode(buffer));
    if (!h.librawAnswer) throw new Error("no answer set");
    return h.librawAnswer();
  },
}));

import { decodeRawToBitmap, decodeRawToFloat } from "./decode";

const EXTENSION = "ext.raw/fast@1.2.0";
const LIBRAW = "libraw-0.22.1+1";

const raw = (name: string): File => new File([name], name, { lastModified: 1 });

const librawFrame = (): RawFloatImage => ({
  data: new Float32Array(4).fill(0.5),
  width: 1,
  height: 1,
  colorTemperature: 5200,
  asShotMultipliers: [2, 1, 1.5],
});

/** A 3×2 linear frame, as an extension's decoder answers one. */
function linearFrame(over: Partial<Extract<DecodedImageResult, { kind: "linear" }>> = {}): DecodedImageResult {
  return {
    kind: "linear",
    width: 3,
    height: 2,
    data: Float32Array.from({ length: 24 }, (_, i) => (i % 4 === 3 ? 1 : i / 10)),
    oriented: true,
    ...over,
  };
}

const noAnswer = (): Promise<DecodeFailure> => Promise.resolve({ failure: "transient", timedOut: true });

function register(): void {
  registerImageDecoder("ext.raw", {
    id: "fast",
    label: "Fast",
    version: "1.2.0",
    extensions: [".nef", ".dng"],
    decode: async (file, request) => {
      h.extension.push({ name: await file.text(), request });
      if (!h.extensionAnswer) throw new Error("no answer set");
      return h.extensionAnswer(request);
    },
  });
}

const extensionFirst = (): void =>
  useSettings.setState({ decoderOrder: { nef: ["ext.raw/fast", "libraw"], dng: ["ext.raw/fast", "libraw"] } });

beforeEach(() => {
  h.libraw = [];
  h.extension = [];
  h.librawAnswer = () => Promise.resolve(librawFrame());
  h.extensionAnswer = () => Promise.resolve(linearFrame());
  useSettings.setState({ decoderOrder: {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  register();
});

afterEach(() => {
  dropImageDecoders("ext.raw");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("decodeRawToFloat while libraw leads", () => {
  it("asks libraw alone when it answers", async () => {
    const image = await decodeRawToFloat(raw("A1.NEF"));

    expect(h.libraw).toEqual(["A1.NEF"]);
    expect(h.extension).toEqual([]);
    expect(image).toEqual({ ...librawFrame(), oriented: true, decoder: LIBRAW });
  });

  it("asks the extension's decoder once libraw fails", async () => {
    h.librawAnswer = () => Promise.resolve({ failure: "unsupported", reason: "imageData returned undefined" });

    const image = await decodeRawToFloat(raw("A2.NEF"));

    expect(h.extension.map((e) => e.name)).toEqual(["A2.NEF"]);
    expect(image).toMatchObject({ width: 3, height: 2, decoder: EXTENSION, unsupportedBy: [LIBRAW] });
  });
});

describe("decodeRawToFloat once an extension's decoder leads", () => {
  beforeEach(extensionFirst);

  it("takes its frame without asking libraw", async () => {
    const image = await decodeRawToFloat(raw("B1.NEF"));

    expect(h.libraw).toEqual([]);
    if ("failure" in image) throw new Error(image.failure);
    expect(image.data).toEqual(Float32Array.from({ length: 24 }, (_, i) => (i % 4 === 3 ? 1 : i / 10)));
    expect(image).toMatchObject({ width: 3, height: 2, oriented: true, decoder: EXTENSION });
    expect(image).not.toHaveProperty("unsupportedBy");
  });

  it("keeps what the decoder reports of the photo", async () => {
    h.extensionAnswer = () =>
      Promise.resolve(
        linearFrame({ oriented: false, asShotMultipliers: [2.1, 1, 1.4], colorTemperature: 4800, rawExposureBias: -0.72 }),
      );

    const image = await decodeRawToFloat(raw("B2.NEF"));

    expect(image).toMatchObject({
      oriented: false,
      asShotMultipliers: [2.1, 1, 1.4],
      colorTemperature: 4800,
      rawExposureBias: -0.72,
    });
  });

  it("leaves out what the decoder reports that isn't usable", async () => {
    h.extensionAnswer = () =>
      Promise.resolve(
        linearFrame({ asShotMultipliers: [NaN, 1, 1] as [number, number, number], colorTemperature: -5, rawExposureBias: 0 }),
      );

    const image = await decodeRawToFloat(raw("B3.NEF"));

    expect(image).not.toHaveProperty("asShotMultipliers");
    expect(image).not.toHaveProperty("colorTemperature");
    expect(image).not.toHaveProperty("rawExposureBias");
  });

  it("asks for the file by its path, for the background, with the photo's white balance", async () => {
    await decodeRawToFloat(
      raw("B4.NEF"),
      { background: true, targetEdge: 1000, asShotMultipliers: [2, 1, 1.5] },
      "2026/B4.NEF",
    );

    expect(h.extension[0].request).toMatchObject({
      name: "2026/B4.NEF",
      targetEdge: 1000,
      fullSize: false,
      asShotMultipliers: [2, 1, 1.5],
      background: true,
    });
    expect(h.extension[0].request.signal).toBeInstanceOf(AbortSignal);
  });

  it("asks for the full size whenever core needs the native frame", async () => {
    await decodeRawToFloat(raw("B5.NEF"));
    await decodeRawToFloat(raw("B6.NEF"), { targetEdge: 1000, cacheEdge: 3072 });

    expect(h.extension.map((e) => e.request.fullSize)).toEqual([true, true]);
  });

  it("turns the frame as asked and builds the cache entry from it", async () => {
    const image = await decodeRawToFloat(raw("B7.NEF"), { turn: 90, cacheEdge: 2 });

    if ("failure" in image) throw new Error(image.failure);
    const linear = linearFrame();
    const turned = rotateFloatRGBA(linear.data as Float32Array, 3, 2, 90);
    expect(image).toMatchObject({ width: 2, height: 3, turned: 90 });
    expect(image.data).toEqual(turned.data);
    expect(image.entry).toEqual(encodeCacheEntry(turned.data, 2, 3, 2));
  });

  it("turns a frame the decoder left unturned upright by the photo's orientation, entry and all", async () => {
    h.extensionAnswer = () => Promise.resolve(linearFrame({ oriented: false }));

    const image = await decodeRawToFloat(raw("B10.NEF"), { orientation: 6, cacheEdge: 3 });

    if ("failure" in image) throw new Error(image.failure);
    const turned = rotateFloatRGBA(linearFrame().data as Float32Array, 3, 2, 90);
    expect(image).toMatchObject({ width: 2, height: 3, oriented: true });
    expect(image).not.toHaveProperty("turned");
    expect(image.data).toEqual(turned.data);
    expect(image.entry).toEqual(encodeCacheEntry(turned.data, 2, 3, 3));
  });

  it("adds the manual turn to the photo's orientation, and says only the manual turn was asked", async () => {
    h.extensionAnswer = () => Promise.resolve(linearFrame({ oriented: false }));

    const image = await decodeRawToFloat(raw("B11.NEF"), { orientation: 6, turn: 90 });

    if ("failure" in image) throw new Error(image.failure);
    expect(image.data).toEqual(rotateFloatRGBA(linearFrame().data as Float32Array, 3, 2, 180).data);
    expect(image).toMatchObject({ width: 3, height: 2, oriented: true, turned: 90 });
  });

  it("leaves the orientation alone for a frame the decoder turned upright", async () => {
    const image = await decodeRawToFloat(raw("B12.NEF"), { orientation: 6 });

    if ("failure" in image) throw new Error(image.failure);
    expect(image).toMatchObject({ width: 3, height: 2, oriented: true });
    expect(image.data).toEqual(linearFrame().data);
  });

  it("names the decoders it decoded under", async () => {
    expect(await decodeRawToFloat(raw("B13.NEF"))).toMatchObject({ signature: "ext.raw/fast@1.2.0>libraw" });
  });

  it("reads a reduced frame as libraw's half-size decode", async () => {
    h.extensionAnswer = () => Promise.resolve(linearFrame({ sourceWidth: 6, sourceHeight: 4 }));

    const image = await decodeRawToFloat(raw("B8.NEF"), { targetEdge: 3 });

    expect(image).toMatchObject({ halfSize: true, sourceWidth: 6, sourceHeight: 4 });
  });

  it("makes a NaN channel 0", async () => {
    h.extensionAnswer = () => Promise.resolve(linearFrame({ data: new Float32Array(24).fill(NaN) }));

    const image = await decodeRawToFloat(raw("B9.NEF"));

    if ("failure" in image) throw new Error(image.failure);
    expect([...image.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);
  });

  it("falls through to libraw when the decoder answers nothing", async () => {
    h.extensionAnswer = () => Promise.resolve(null);

    const image = await decodeRawToFloat(raw("C1.NEF"));

    expect(h.libraw).toEqual(["C1.NEF"]);
    expect(image).toEqual({
      ...librawFrame(),
      oriented: true,
      decoder: LIBRAW,
      unsupportedBy: [EXTENSION],
      signature: "ext.raw/fast@1.2.0>libraw",
    });
  });

  it("falls through to libraw when the decoder throws", async () => {
    h.extensionAnswer = () => Promise.reject(new Error("bad header"));

    const image = await decodeRawToFloat(raw("C2.NEF"));

    expect(image).toMatchObject({ decoder: LIBRAW, unsupportedBy: [EXTENSION] });
  });

  it("calls the photo unsupported only when every decoder is", async () => {
    h.extensionAnswer = () => Promise.resolve(null);
    h.librawAnswer = () => Promise.resolve({ failure: "unsupported", reason: "imageData returned undefined" });

    const image = await decodeRawToFloat(raw("C3.NEF"));

    expect(image).toMatchObject({ failure: "unsupported", unsupportedBy: [EXTENSION, LIBRAW] });
    expect("failure" in image && image.reason).toMatch(/Fast couldn't read this file.*imageData returned undefined/);
  });

  it("keeps a failure that may pass transient", async () => {
    h.extensionAnswer = () => Promise.resolve(null);
    h.librawAnswer = noAnswer;

    const image = await decodeRawToFloat(raw("C4.NEF"));

    expect(image).toMatchObject({ failure: "transient", timedOut: true, unsupportedBy: [EXTENSION] });
  });

  it("passes by a decoder that has failed on the file for good", async () => {
    const image = await decodeRawToFloat(raw("C5.NEF"), { ruledOut: new Set([EXTENSION]) });

    expect(h.extension).toEqual([]);
    expect(image).toMatchObject({ decoder: LIBRAW });
  });

  it("asks nobody when every decoder has", async () => {
    const image = await decodeRawToFloat(raw("C6.NEF"), { ruledOut: new Set([EXTENSION, LIBRAW]) });

    expect(h.extension).toEqual([]);
    expect(h.libraw).toEqual([]);
    expect(image).toMatchObject({ failure: "unsupported" });
  });

  it("stops at a request abandoned while the decoder ran", async () => {
    const controller = new AbortController();
    h.extensionAnswer = () => {
      controller.abort();
      return new Promise(() => {});
    };

    const image = await decodeRawToFloat(raw("C7.NEF"), { signal: controller.signal });

    expect(image).toEqual({ failure: "aborted" });
    expect(h.libraw).toEqual([]);
  });
});

describe("decodeRawToFloat, background work and a decoder that gave no answer", () => {
  it("still asks the extension's decoder after libraw gave none", async () => {
    h.librawAnswer = noAnswer;
    h.extensionAnswer = () => Promise.resolve(null);
    await decodeRawToFloat(raw("D1.NEF"), { background: true });
    h.extensionAnswer = () => Promise.resolve(linearFrame());

    const image = await decodeRawToFloat(raw("D1.NEF"), { background: true });

    expect(h.libraw).toEqual(["D1.NEF"]);
    expect(h.extension.map((e) => e.name)).toEqual(["D1.NEF", "D1.NEF"]);
    expect(image).toMatchObject({ decoder: EXTENSION });
  });

  it("still asks libraw after the extension's decoder gave none", async () => {
    extensionFirst();
    vi.useFakeTimers();
    h.extensionAnswer = () => new Promise(() => {});
    const first = decodeRawToFloat(raw("D2.NEF"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await first).toMatchObject({ decoder: LIBRAW });

    const image = await decodeRawToFloat(raw("D2.NEF"), { background: true });

    expect(h.extension).toHaveLength(1);
    expect(h.libraw).toEqual(["D2.NEF", "D2.NEF"]);
    expect(image).toMatchObject({ decoder: LIBRAW });
  });

  it("passes the file over once no decoder answered", async () => {
    vi.useFakeTimers();
    h.librawAnswer = noAnswer;
    h.extensionAnswer = () => new Promise(() => {});
    const first = decodeRawToFloat(raw("D3.NEF"));
    await vi.advanceTimersByTimeAsync(120_000);
    await first;

    const again = await decodeRawToFloat(raw("D3.NEF"), { background: true });

    expect(again).toEqual({ failure: "transient", reason: "no answer earlier this session", passedOver: true });
  });
});

describe("decodeRawToFloat taking over a decode nobody waits for", () => {
  it("doesn't take over one begun under other decoders", async () => {
    let answer: (image: RawFloatImage) => void = () => {};
    h.librawAnswer = () => new Promise((resolve) => (answer = resolve));
    const left = new AbortController();
    const first = decodeRawToFloat(raw("F1.NEF"), { signal: left.signal });
    await vi.waitFor(() => expect(h.libraw).toEqual(["F1.NEF"]));
    left.abort();
    extensionFirst();

    const second = decodeRawToFloat(raw("F1.NEF"));
    answer(librawFrame());

    expect(await second).toMatchObject({ decoder: EXTENSION, signature: "ext.raw/fast@1.2.0>libraw" });
    await first;
  });
});

describe("decodeRawToBitmap", () => {
  it("leaves a RAW an extension's decoder leads for to the float decode, unread", async () => {
    extensionFirst();
    const file = raw("E1.DNG");
    const reads = vi.spyOn(file, "arrayBuffer");

    expect(await decodeRawToBitmap(file)).toBeNull();
    expect(reads).not.toHaveBeenCalled();
  });

  it("reads it while libraw leads", async () => {
    const file = raw("E2.DNG");
    const reads = vi.spyOn(file, "arrayBuffer");

    await decodeRawToBitmap(file);

    expect(reads).toHaveBeenCalled();
  });
});
