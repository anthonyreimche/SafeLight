// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecodedImageResult, ImageDecoderContribution } from "@/extensions/api/library";
import { useSettings } from "@/state/settings-store";
import {
  chainSignature,
  decoderChain,
  decoderList,
  dropImageDecoders,
  formatOf,
  isExtensionEntry,
  keepingAbsent,
  missingLeadOwners,
  onDecodersChanged,
  registerImageDecoder,
  runExtensionDecoder,
  unregisterImageDecoder,
  withDecoderOrder,
  type ExtensionChainEntry,
} from "./image-decoders";

const rgba8 = (width: number, height: number, oriented = false): Extract<DecodedImageResult, { kind: "rgba8" }> => ({
  kind: "rgba8",
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4),
  oriented,
});

const linear = (width: number, height: number, oriented = false): Extract<DecodedImageResult, { kind: "linear" }> => ({
  kind: "linear",
  width,
  height,
  data: new Float32Array(width * height * 4),
  oriented,
});

function decoder(over: Partial<ImageDecoderContribution> = {}): ImageDecoderContribution {
  return {
    id: "fast",
    label: "Fast decoder",
    extensions: [".heic"],
    decode: async () => rgba8(2, 2, true),
    ...over,
  };
}

const request = { name: "a.heic", fullSize: false, background: false };

function extensionEntry(formatId: string): ExtensionChainEntry {
  const entry = decoderChain(formatId).find(isExtensionEntry);
  if (!entry) throw new Error("no extension decoder in the chain");
  return entry;
}

beforeEach(() => {
  useSettings.setState({ decoderOrder: {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const owner of ["ext.a", "ext.b"]) dropImageDecoders(owner);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("formats", () => {
  it("groups each standard extension under its format, case-insensitively", () => {
    expect(formatOf("IMG_1.HEIC")?.id).toBe("heif");
    expect(formatOf("a.heif")?.id).toBe("heif");
    expect(formatOf("a.hif")?.id).toBe("heif");
    expect(formatOf("a.jpeg")?.id).toBe("jpeg");
    expect(formatOf("a.JPG")?.id).toBe("jpeg");
    expect(formatOf("a.tif")?.id).toBe("tiff");
    expect(formatOf("a.pgm")?.id).toBe("netpbm");
  });

  it("gives every RAW extension a format of its own, marked raw", () => {
    expect(formatOf("DSC_1.NEF")).toMatchObject({ id: "nef", raw: true, label: "NEF" });
    expect(formatOf("a.cr3")).toMatchObject({ id: "cr3", raw: true });
    expect(formatOf("a.heic")?.raw).toBe(false);
  });

  it("knows no format for other names", () => {
    expect(formatOf("a.jxl")).toBeNull();
    expect(formatOf("README")).toBeNull();
  });
});

describe("the chain for a format", () => {
  it("is core's own decoder alone by default, with an empty signature", () => {
    expect(decoderChain("heif").map((e) => e.id)).toEqual(["heif"]);
    expect(decoderChain("jpeg").map((e) => e.id)).toEqual(["browser"]);
    expect(decoderChain("tiff").map((e) => e.id)).toEqual(["tiff"]);
    expect(decoderChain("netpbm").map((e) => e.id)).toEqual(["netpbm"]);
    expect(decoderChain("nef").map((e) => e.id)).toEqual(["libraw"]);
    expect(chainSignature("heif")).toBe("");
  });

  it("puts a newly registered extension decoder after core's, keeping the signature empty", () => {
    registerImageDecoder("ext.a", decoder());
    expect(decoderChain("heif").map((e) => e.id)).toEqual(["heif", "ext.a/fast"]);
    expect(chainSignature("heif")).toBe("");
    expect(decoderChain("jpeg").map((e) => e.id)).toEqual(["browser"]);
  });

  it("follows the saved order, and signs the decoders up to core's", () => {
    registerImageDecoder("ext.a", decoder({ version: "1.2.0" }));
    useSettings.setState({ decoderOrder: { heif: ["ext.a/fast", "heif"] } });
    expect(decoderChain("heif").map((e) => e.id)).toEqual(["ext.a/fast", "heif"]);
    expect(chainSignature("heif")).toBe("ext.a/fast@1.2.0>heif");
  });

  it("leaves saved decoders that aren't registered out of the chain and its signature", () => {
    useSettings.setState({ decoderOrder: { heif: ["ext.a/fast", "heif"] } });
    expect(decoderChain("heif").map((e) => e.id)).toEqual(["heif"]);
    expect(chainSignature("heif")).toBe("");
  });

  it("appends decoders missing from the saved order: core first, then extensions as they came", () => {
    registerImageDecoder("ext.b", decoder({ id: "slow" }));
    registerImageDecoder("ext.a", decoder());
    useSettings.setState({ decoderOrder: { heif: ["ext.a/fast"] } });
    expect(decoderChain("heif").map((e) => e.id)).toEqual(["ext.a/fast", "heif", "ext.b/slow"]);
  });

  it("ignores saved ids that aren't strings", () => {
    useSettings.setState({ decoderOrder: { heif: [3, null, "heif"] as unknown as string[] } });
    expect(decoderChain("heif").map((e) => e.id)).toEqual(["heif"]);
  });

  it("signs an unversioned decoder with version 1", () => {
    registerImageDecoder("ext.a", decoder({ extensions: [".nef"] }));
    useSettings.setState({ decoderOrder: { nef: ["ext.a/fast"] } });
    expect(chainSignature("nef")).toBe("ext.a/fast@1>libraw");
  });
});

describe("registering", () => {
  it("lists the decoders by format, with core's labels", () => {
    registerImageDecoder("ext.a", decoder({ extensions: [".heic", ".HEIF"] }));
    const listed = decoderList();
    expect(listed.find((d) => d.id === "ext.a/fast")).toMatchObject({
      owner: "ext.a",
      label: "Fast decoder",
      formats: ["heif"],
    });
    expect(listed.find((d) => d.id === "heif")).toMatchObject({ owner: "core", formats: ["heif"] });
  });

  it("refuses extensions no core format holds, keeping the rest", () => {
    registerImageDecoder("ext.a", decoder({ extensions: [".jxl", ".heic"] }));
    expect(decoderList().find((d) => d.id === "ext.a/fast")?.formats).toEqual(["heif"]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(".jxl"));
  });

  it("refuses a decoder with no format it can claim", () => {
    registerImageDecoder("ext.a", decoder({ extensions: [".jxl"] }));
    expect(decoderList().some((d) => d.id === "ext.a/fast")).toBe(false);
  });

  it("refuses a decoder without an id, a label or a decode function", () => {
    registerImageDecoder("ext.a", decoder({ id: "" }));
    registerImageDecoder("ext.a", decoder({ label: "" }));
    registerImageDecoder("ext.a", { ...decoder(), decode: undefined } as unknown as ImageDecoderContribution);
    expect(decoderList().filter((d) => d.owner === "ext.a")).toEqual([]);
  });

  it("keeps each extension's ids apart, and lets an extension replace its own", () => {
    registerImageDecoder("ext.a", decoder());
    registerImageDecoder("ext.b", decoder());
    registerImageDecoder("ext.a", decoder({ label: "Faster" }));
    expect(decoderChain("heif").map((e) => e.id)).toEqual(["heif", "ext.a/fast", "ext.b/fast"]);
    expect(decoderList().find((d) => d.id === "ext.a/fast")?.label).toBe("Faster");
  });

  it("lets only the owner unregister, and drops all of an extension's when it stops", () => {
    registerImageDecoder("ext.a", decoder());
    registerImageDecoder("ext.a", decoder({ id: "other", extensions: [".nef"] }));
    unregisterImageDecoder("ext.b", "fast");
    expect(decoderChain("heif").map((e) => e.id)).toContain("ext.a/fast");
    unregisterImageDecoder("ext.a", "fast");
    expect(decoderChain("heif").map((e) => e.id)).toEqual(["heif"]);
    dropImageDecoders("ext.a");
    expect(decoderChain("nef").map((e) => e.id)).toEqual(["libraw"]);
  });

  it("tells listeners when decoders come and go and when the order changes", () => {
    const heard = vi.fn();
    const stop = onDecodersChanged(heard);
    registerImageDecoder("ext.a", decoder());
    useSettings.setState({ decoderOrder: { heif: ["ext.a/fast", "heif"] } });
    dropImageDecoders("ext.a");
    stop();
    registerImageDecoder("ext.a", decoder());
    expect(heard).toHaveBeenCalledTimes(3);
  });
});

describe("decoders a format waits for", () => {
  it("names the extensions of saved decoders ahead of every registered one", () => {
    registerImageDecoder("ext.b", decoder({ id: "slow" }));
    useSettings.setState({ decoderOrder: { heif: ["ext.a/fast", "ext.c/x", "ext.b/slow", "ext.d/y", "heif"] } });
    expect(missingLeadOwners("heif")).toEqual(["ext.a", "ext.c"]);
  });

  it("names none when core's decoder leads, or no order is saved", () => {
    useSettings.setState({ decoderOrder: { heif: ["heif", "ext.a/fast"] } });
    expect(missingLeadOwners("heif")).toEqual([]);
    expect(missingLeadOwners("jpeg")).toEqual([]);
  });
});

describe("keepingAbsent", () => {
  it("keeps saved decoders that aren't registered where they stood", () => {
    registerImageDecoder("ext.b", decoder({ id: "slow" }));
    useSettings.setState({ decoderOrder: { heif: ["ext.a/fast", "heif", "ext.b/slow"] } });
    expect(keepingAbsent("heif", ["ext.b/slow", "heif"])).toEqual(["ext.a/fast", "ext.b/slow", "heif"]);
  });

  it("is the order given when every saved decoder is registered", () => {
    expect(keepingAbsent("heif", ["heif"])).toEqual(["heif"]);
  });
});

describe("withDecoderOrder", () => {
  it("sets a format's order, and with null takes it out", () => {
    const saved = withDecoderOrder({ nef: ["libraw"] }, "heif", ["ext.a/fast", "heif"]);
    expect(saved).toEqual({ nef: ["libraw"], heif: ["ext.a/fast", "heif"] });
    expect(withDecoderOrder(saved, "heif", null)).toEqual({ nef: ["libraw"] });
  });
});

describe("running an extension decoder", () => {
  it("hands the decoder the file and the request, and answers its image", async () => {
    const decode = vi.fn(async () => rgba8(3, 2, true));
    registerImageDecoder("ext.a", decoder({ decode }));
    const file = new Blob([new Uint8Array(8)]);
    const result = await runExtensionDecoder(extensionEntry("heif"), file, { ...request, targetEdge: 640 });
    expect(result).toMatchObject({ ok: true, image: { kind: "rgba8", width: 3, height: 2, oriented: true } });
    expect(decode).toHaveBeenCalledWith(
      file,
      expect.objectContaining({ name: "a.heic", targetEdge: 640, fullSize: false, background: false }),
    );
  });

  it("answers why when the decoder gives nothing or throws", async () => {
    registerImageDecoder("ext.a", decoder({ decode: async () => null }));
    expect(await runExtensionDecoder(extensionEntry("heif"), new Blob(), request)).toMatchObject({ ok: false });
    registerImageDecoder("ext.a", decoder({ decode: async () => { throw new Error("bad file"); } }));
    const thrown = await runExtensionDecoder(extensionEntry("heif"), new Blob(), request);
    expect(thrown).toMatchObject({ ok: false, reason: expect.stringContaining("bad file") });
  });

  it.each([
    ["a size that doesn't match the data", { ...rgba8(2, 2, true), width: 3 }],
    ["a size that isn't whole", { ...rgba8(2, 2, true), width: 1.5 }],
    ["8-bit data in a Float32Array", { ...rgba8(2, 2, true), data: new Float32Array(16) }],
    ["linear data in bytes", { ...linear(2, 2, true), data: new Uint8ClampedArray(16) }],
    ["an unknown kind", { ...rgba8(2, 2, true), kind: "jpeg" }],
    ["HEIF pixels not turned upright", rgba8(2, 2, false)],
  ])("refuses %s", async (_, image) => {
    registerImageDecoder("ext.a", decoder({ decode: async () => image as DecodedImageResult }));
    expect(await runExtensionDecoder(extensionEntry("heif"), new Blob(), request)).toMatchObject({ ok: false });
  });

  it("takes only linear images for a RAW format", async () => {
    registerImageDecoder("ext.a", decoder({ extensions: [".nef"], decode: async () => rgba8(2, 2) }));
    const raw = { ...request, name: "a.nef" };
    expect(await runExtensionDecoder(extensionEntry("nef"), new Blob(), raw)).toMatchObject({ ok: false });
    registerImageDecoder("ext.a", decoder({ extensions: [".nef"], decode: async () => linear(2, 2) }));
    expect(await runExtensionDecoder(extensionEntry("nef"), new Blob(), raw)).toMatchObject({ ok: true });
  });

  it("refuses a reduced RAW decode when core needs the full size", async () => {
    const half = { ...linear(2, 2), sourceWidth: 4, sourceHeight: 4 };
    registerImageDecoder("ext.a", decoder({ extensions: [".nef"], decode: async () => half }));
    const raw = { ...request, name: "a.nef", fullSize: true };
    expect(await runExtensionDecoder(extensionEntry("nef"), new Blob(), raw)).toMatchObject({ ok: false });
  });

  it("copies data held in part of a larger buffer, so core owns exactly the image", async () => {
    const backing = new Uint8ClampedArray(64);
    const view = new Uint8ClampedArray(backing.buffer, 16, 16);
    registerImageDecoder("ext.a", decoder({ decode: async () => ({ ...rgba8(2, 2, true), data: view }) }));
    const result = await runExtensionDecoder(extensionEntry("heif"), new Blob(), request);
    if (!result.ok) throw new Error(result.reason);
    expect(result.image.data.byteOffset).toBe(0);
    expect(result.image.data.buffer.byteLength).toBe(16);
  });

  it("runs one decode at a time per decoder, interactive requests ahead of background ones", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    registerImageDecoder(
      "ext.a",
      decoder({
        decode: async (_file, req) => {
          order.push(req.name);
          if (req.name === "first.heic") await gate;
          return rgba8(1, 1, true);
        },
      }),
    );
    const entry = extensionEntry("heif");
    const first = runExtensionDecoder(entry, new Blob(), { ...request, name: "first.heic" });
    const background = runExtensionDecoder(entry, new Blob(), { ...request, name: "bg.heic", background: true });
    const interactive = runExtensionDecoder(entry, new Blob(), { ...request, name: "now.heic" });
    await Promise.resolve();
    expect(order).toEqual(["first.heic"]);
    release();
    await Promise.all([first, background, interactive]);
    expect(order).toEqual(["first.heic", "now.heic", "bg.heic"]);
  });

  it("gives up on a decode past its time limit and aborts the decoder's signal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    registerImageDecoder(
      "ext.a",
      decoder({
        decode: (_file, req) => {
          signal = req.signal;
          return new Promise(() => {});
        },
      }),
    );
    const pending = runExtensionDecoder(extensionEntry("heif"), new Blob(), request);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await pending).toMatchObject({ ok: false, reason: expect.stringContaining("time") });
    expect(signal?.aborted).toBe(true);
  });

  it("answers aborted without running a request whose caller has given up", async () => {
    const decode = vi.fn(async () => rgba8(1, 1, true));
    registerImageDecoder("ext.a", decoder({ decode }));
    const controller = new AbortController();
    controller.abort();
    const result = await runExtensionDecoder(extensionEntry("heif"), new Blob(), { ...request, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, aborted: true });
    expect(decode).not.toHaveBeenCalled();
  });
});
