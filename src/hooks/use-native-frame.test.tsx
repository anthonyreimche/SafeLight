// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dynamic mode's full-size luminance of the open RAW: fetched once the photo's
// final source shows, 800 ms later in the background or at once when the view
// first zooms into a window, and handed to the renderer under the photo's source
// key: the luminance to the native-frame worker, its size to the renderer, whose
// detail requests are relayed to that worker's cuts. The decode and the worker are
// stand-ins that answer when the test says.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { CatalogPhoto } from "@/catalog/types";
import type { NativeDecode, NativeDecodeMiss } from "@/catalog/native-decode";
import { NATIVE_FRAME_MAX_PIXELS, type DetailGain } from "@/raw/native-frame";
import { cutNativeGain, dropNativeLuma, holdNativeLuma } from "@/raw/native-frame-bridge";
import type { DetailWant } from "@/rendering/render-bridge";
import { useDevelopStore } from "@/state/develop-store";
import { useSettings } from "@/state/settings-store";
import { nativeDetailCapable, useNativeFrame, type NativeFrameBridge } from "./use-native-frame";

vi.mock("libraw-wasm", () => ({ default: class {} }));

interface Pending {
  signal: AbortSignal;
  background: boolean;
  answer(result: NativeDecode | NativeDecodeMiss): Promise<void>;
}

const decodes = vi.hoisted(() => [] as {
  signal: AbortSignal;
  background: boolean;
  resolve: (r: unknown) => void;
}[]);

vi.mock("@/catalog/native-decode", () => ({
  decodeNativeFrame: (_photo: unknown, opts: { signal: AbortSignal; background: boolean }) =>
    new Promise((resolve) => decodes.push({ ...opts, resolve })),
}));

vi.mock("@/raw/native-frame-bridge", () => ({
  holdNativeLuma: vi.fn(),
  dropNativeLuma: vi.fn(),
  cutNativeGain: vi.fn(),
}));

function decode(i: number): Pending {
  const d = decodes[i];
  if (!d) throw new Error(`no decode ${i}`);
  return {
    signal: d.signal,
    background: d.background,
    answer: async (result) => {
      await act(async () => {
        d.resolve(result);
      });
    },
  };
}

const FRAME = (): NativeDecode => ({ data: new Uint16Array(6), width: 3, height: 2 });

function photo(over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
    id: "p",
    filename: "p.orf",
    relPath: "p.orf",
    folder: "",
    directoryHandle: null,
    fileHandle: null,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 1000,
    mimeType: "image/x-olympus-orf",
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

const LARGER = { width: 3072, height: 2048, fullWidth: 6000, fullHeight: 4000, native: true };

let bridge: {
  setNativeFrame: Mock<NativeFrameBridge["setNativeFrame"]>;
  clearNativeFrame: Mock<NativeFrameBridge["clearNativeFrame"]>;
  render: Mock<NativeFrameBridge["render"]>;
  onDetailWanted: Mock<NativeFrameBridge["onDetailWanted"]>;
  setDetailGain: Mock<NativeFrameBridge["setDetailGain"]>;
};

/** The renderer asking for a gain, through the handler the hook registered. */
function want(over: Partial<DetailWant> = {}): DetailWant {
  const w: DetailWant = {
    request: 7,
    key: "p:0",
    rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    outW: 800,
    outH: 600,
    baseW: 3072,
    baseH: 2048,
    ...over,
  };
  const handler = bridge.onDetailWanted.mock.lastCall?.[0];
  if (!handler) throw new Error("no detail handler registered");
  handler(w);
  return w;
}

const GAIN = (): DetailGain => ({ data: new Uint16Array(4), width: 2, height: 2, rect: { x: 0, y: 0, w: 1, h: 1 } });

interface Props {
  photo: CatalogPhoto | undefined;
  finalShown: boolean;
  restores: number;
}

// As use-develop-renderer's: its own setup's cleanup lets go of the bridge before
// this hook's cleanups run.
let bridgeRef: { current: NativeFrameBridge | null };

function mount(over: Partial<Props> = {}) {
  bridgeRef = { current: bridge };
  return renderHook((p: Props) => useNativeFrame(bridgeRef, p.photo, p.finalShown, p.restores), {
    initialProps: { photo: photo(), finalShown: true, restores: 0, ...over },
  });
}

const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const settingsBefore = useSettings.getState().developDynamicDetail;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  decodes.length = 0;
  bridge = {
    setNativeFrame: vi.fn(),
    clearNativeFrame: vi.fn(),
    render: vi.fn(),
    onDetailWanted: vi.fn(),
    setDetailGain: vi.fn(),
  };
  vi.mocked(holdNativeLuma).mockReset();
  vi.mocked(dropNativeLuma).mockReset();
  vi.mocked(cutNativeGain).mockReset();
  useSettings.setState({ developDynamicDetail: true });
  useDevelopStore.setState({ sourceSize: LARGER });
});

afterEach(() => {
  vi.useRealTimers();
  useSettings.setState({ developDynamicDetail: settingsBefore });
  useDevelopStore.setState({ sourceSize: { width: 0, height: 0, fullWidth: 0, fullHeight: 0, native: false } });
});

// The one rule the hook and the canvas's zoom scale share.
describe("nativeDetailCapable", () => {
  const JPEG = photo({ filename: "p.jpg", relPath: "p.jpg" });
  it.each([
    ["a RAW from its own decode, larger than its source", photo(), LARGER, true],
    ["a JPEG whose file is larger than its source", JPEG, LARGER, false],
    ["a RAW shown from a preview, or a cache entry without its sample", photo(), { ...LARGER, native: false }, false],
    [
      "a RAW over the pixel limit",
      photo(),
      { ...LARGER, fullWidth: 10_000, fullHeight: NATIVE_FRAME_MAX_PIXELS / 10_000 + 1 },
      false,
    ],
    ["a RAW whose source is its full size", photo(), { ...LARGER, fullWidth: 3072, fullHeight: 2048 }, false],
    ["no photo", undefined, LARGER, false],
    ["no source yet", photo(), { width: 0, height: 0, fullWidth: 0, fullHeight: 0, native: false }, false],
  ])("for %s", (_label, p, size, capable) => {
    expect(nativeDetailCapable(p, size)).toBe(capable);
  });
});

describe("when the photo can't give a frame", () => {
  it.each([
    ["Dynamic is off", () => useSettings.setState({ developDynamicDetail: false }), {}],
    ["the photo isn't a RAW", () => {}, { photo: photo({ filename: "p.jpg", relPath: "p.jpg" }) }],
    ["no photo is open", () => {}, { photo: undefined }],
    ["the final source isn't shown yet", () => {}, { finalShown: false }],
    [
      "the source is the photo's full size",
      () => useDevelopStore.setState({ sourceSize: { ...LARGER, fullWidth: 3072, fullHeight: 2048 } }),
      {},
    ],
    [
      "the source isn't the photo's own decode",
      () => useDevelopStore.setState({ sourceSize: { ...LARGER, native: false } }),
      {},
    ],
    [
      "the frame is over the pixel limit",
      () =>
        useDevelopStore.setState({
          sourceSize: { ...LARGER, fullWidth: 10_000, fullHeight: NATIVE_FRAME_MAX_PIXELS / 10_000 + 1 },
        }),
      {},
    ],
  ])("decodes nothing when %s", (_label, arrange, over: Partial<Props>) => {
    arrange();
    const { result } = mount(over);
    advance(5000);
    act(() => result.current(true));
    advance(5000);
    expect(decodes).toHaveLength(0);
  });

  it("registers nothing and calls nothing when Dynamic is off", () => {
    useSettings.setState({ developDynamicDetail: false });
    const view = mount();
    act(() => view.result.current(true));
    advance(5000);
    view.unmount();
    for (const fn of Object.values(bridge)) expect(fn).not.toHaveBeenCalled();
    expect(holdNativeLuma).not.toHaveBeenCalled();
    expect(dropNativeLuma).not.toHaveBeenCalled();
  });
});

describe("the triggers", () => {
  it("starts a background decode 800 ms after the final source shows, not before", () => {
    const view = mount({ finalShown: false });
    view.rerender({ photo: photo(), finalShown: true, restores: 0 });
    advance(799);
    expect(decodes).toHaveLength(0);
    advance(1);
    expect(decodes).toHaveLength(1);
    expect(decode(0).background).toBe(true);
  });

  it("starts at once, interactive, when the view first zooms into a window, and the dwell starts no second", () => {
    const { result } = mount();
    act(() => result.current(true));
    expect(decodes).toHaveLength(1);
    expect(decode(0).background).toBe(false);
    advance(2000);
    expect(decodes).toHaveLength(1);
  });

  it("leaves a dwell's decode running when the view zooms in", () => {
    const { result } = mount();
    advance(800);
    act(() => result.current(true));
    expect(decodes).toHaveLength(1);
    expect(decode(0).signal.aborted).toBe(false);
  });

  it("starts at once when the photo becomes eligible already zoomed in", () => {
    const view = mount({ finalShown: false });
    act(() => view.result.current(true));
    expect(decodes).toHaveLength(0);
    view.rerender({ photo: photo(), finalShown: true, restores: 0 });
    expect(decodes).toHaveLength(1);
    expect(decode(0).background).toBe(false);
  });
});

describe("the result", () => {
  it("holds the luminance under the photo's source key, tells the renderer its size and asks for a render", async () => {
    const { result } = mount({ photo: photo({ rotation: 90 }) });
    advance(800);
    const frame = FRAME();
    const buffer = frame.data.buffer;
    await decode(0).answer(frame);
    expect(holdNativeLuma).toHaveBeenCalledWith("p:90", frame);
    expect(vi.mocked(holdNativeLuma).mock.lastCall?.[1].data.buffer).toBe(buffer);
    expect(bridge.setNativeFrame).toHaveBeenCalledWith("p:90", { width: 3, height: 2 });
    expect(bridge.render).toHaveBeenCalledWith(false);

    act(() => result.current(true));
    advance(5000);
    expect(decodes).toHaveLength(1);
  });

  it("stops for the photo on never", async () => {
    const { result } = mount();
    advance(800);
    await decode(0).answer({ miss: "never" });
    act(() => result.current(true));
    advance(5000);
    expect(decodes).toHaveLength(1);
    expect(bridge.setNativeFrame).not.toHaveBeenCalled();
  });

  it("tries again 2 s after retry, three times at most", async () => {
    mount();
    advance(800);
    await decode(0).answer({ miss: "retry" });
    advance(1999);
    expect(decodes).toHaveLength(1);
    advance(1);
    expect(decodes).toHaveLength(2);
    expect(decode(1).background).toBe(true);
    await decode(1).answer({ miss: "retry" });
    advance(2000);
    expect(decodes).toHaveLength(3);
    await decode(2).answer({ miss: "retry" });
    advance(10_000);
    expect(decodes).toHaveLength(3);
  });

  it("waits 2 s after retry while the view is windowed too, then asks interactive", async () => {
    const { result } = mount();
    act(() => result.current(true));
    await decode(0).answer({ miss: "retry" });
    act(() => result.current(false));
    act(() => result.current(true));
    advance(1999);
    expect(decodes).toHaveLength(1);
    advance(1);
    expect(decodes).toHaveLength(2);
    expect(decode(1).background).toBe(false);
  });

  it("holds a frame that comes after the final source went, under the same key, and tells the renderer once it is back", async () => {
    const view = mount();
    advance(800);
    view.rerender({ photo: photo(), finalShown: false, restores: 0 });
    expect(decode(0).signal.aborted).toBe(false);
    await decode(0).answer(FRAME());
    expect(holdNativeLuma).toHaveBeenCalledTimes(1);
    expect(bridge.setNativeFrame).not.toHaveBeenCalled();

    view.rerender({ photo: photo(), finalShown: true, restores: 0 });
    expect(bridge.setNativeFrame).toHaveBeenCalledWith("p:0", { width: 3, height: 2 });
    advance(5000);
    expect(decodes).toHaveLength(1);
  });
});

// Every detail request is answered, or the view can't ask again until it moves.
describe("the renderer's detail requests", () => {
  async function held() {
    const view = mount();
    advance(800);
    await decode(0).answer(FRAME());
    return view;
  }

  it("cuts a gain for the open key and relays it under the request", async () => {
    await held();
    const gain = GAIN();
    vi.mocked(cutNativeGain).mockResolvedValue(gain);
    let w: DetailWant | null = null;
    await act(async () => {
      w = want({ request: 12 });
    });
    expect(cutNativeGain).toHaveBeenCalledWith(w);
    expect(bridge.setDetailGain).toHaveBeenCalledWith(12, gain);
  });

  it("relays a cut that finds nothing as null", async () => {
    await held();
    vi.mocked(cutNativeGain).mockResolvedValue(null);
    await act(async () => void want({ request: 3 }));
    expect(bridge.setDetailGain).toHaveBeenCalledWith(3, null);
  });

  it("answers null at once, cutting nothing, for another key", async () => {
    await held();
    want({ request: 4, key: "q:0" });
    expect(bridge.setDetailGain).toHaveBeenCalledWith(4, null);
    expect(cutNativeGain).not.toHaveBeenCalled();
  });

  it("answers null at once, cutting nothing, with no frame held", () => {
    mount();
    want({ request: 5 });
    expect(bridge.setDetailGain).toHaveBeenCalledWith(5, null);
    expect(cutNativeGain).not.toHaveBeenCalled();
  });

  it("answers null when the cut fails", async () => {
    await held();
    vi.mocked(cutNativeGain).mockRejectedValue(new Error("worker gone"));
    await act(async () => void want({ request: 6 }));
    expect(bridge.setDetailGain).toHaveBeenCalledWith(6, null);
  });

  it("answers on the bridge the request came from", async () => {
    await held();
    let settle: (g: DetailGain | null) => void = () => {};
    vi.mocked(cutNativeGain).mockReturnValue(new Promise((r) => (settle = r)));
    want({ request: 8 });
    bridgeRef.current = null;
    const gain = GAIN();
    await act(async () => settle(gain));
    expect(bridge.setDetailGain).toHaveBeenCalledWith(8, gain);
  });

  it("lets go of the handler on unmount", () => {
    const view = mount();
    expect(bridge.onDetailWanted).toHaveBeenLastCalledWith(expect.any(Function));
    bridgeRef.current = null;
    view.unmount();
    expect(bridge.onDetailWanted).toHaveBeenLastCalledWith(null);
  });

  it("lets go of the handler when Dynamic is turned off", () => {
    mount();
    act(() => useSettings.setState({ developDynamicDetail: false }));
    expect(bridge.onDetailWanted).toHaveBeenLastCalledWith(null);
  });
});

describe("leaving", () => {
  it("aborts a decode when another photo opens, hands nothing and clears", async () => {
    const view = mount();
    advance(800);
    const first = decode(0);
    view.rerender({ photo: photo({ id: "q" }), finalShown: false, restores: 0 });
    expect(first.signal.aborted).toBe(true);
    expect(bridge.clearNativeFrame).toHaveBeenCalledTimes(1);
    await first.answer(FRAME());
    expect(bridge.setNativeFrame).not.toHaveBeenCalled();
    expect(holdNativeLuma).not.toHaveBeenCalled();
  });

  it("clears when the rotation changes the key", async () => {
    const view = mount();
    advance(800);
    await decode(0).answer(FRAME());
    view.rerender({ photo: photo({ rotation: 90 }), finalShown: true, restores: 0 });
    expect(dropNativeLuma).toHaveBeenCalledWith("p:0");
    expect(bridge.clearNativeFrame).toHaveBeenCalledTimes(1);
    advance(800);
    expect(decodes).toHaveLength(2);
  });

  it("clears when Dynamic is turned off", async () => {
    mount();
    advance(800);
    await decode(0).answer(FRAME());
    act(() => useSettings.setState({ developDynamicDetail: false }));
    expect(dropNativeLuma).toHaveBeenCalledWith("p:0");
    expect(bridge.clearNativeFrame).toHaveBeenCalledTimes(1);
  });

  it("clears on unmount, on the bridge it fetched for", () => {
    const view = mount();
    act(() => view.result.current(true));
    bridgeRef.current = null;
    view.unmount();
    expect(decode(0).signal.aborted).toBe(true);
    expect(dropNativeLuma).toHaveBeenCalledWith("p:0");
    expect(bridge.clearNativeFrame).toHaveBeenCalledTimes(1);
  });

  it("doesn't clear for a photo it started nothing for, nor on a render", () => {
    const view = mount();
    view.rerender({ photo: photo(), finalShown: true, restores: 0 });
    view.rerender({ photo: photo({ id: "q" }), finalShown: true, restores: 0 });
    view.unmount();
    expect(bridge.clearNativeFrame).not.toHaveBeenCalled();
    expect(dropNativeLuma).not.toHaveBeenCalled();
  });
});

// Every load of the photo (a re-granted permission, a restore) clears the render
// worker's source, and its record of the frame; the luminance stays held.
describe("a reload of the photo's source under the same key", () => {
  it("tells the renderer the held frame's size again, decoding nothing", async () => {
    const view = mount();
    advance(800);
    await decode(0).answer(FRAME());
    view.rerender({ photo: photo(), finalShown: false, restores: 0 });
    view.rerender({ photo: photo(), finalShown: true, restores: 0 });
    advance(5000);
    expect(decodes).toHaveLength(1);
    expect(bridge.setNativeFrame).toHaveBeenCalledTimes(2);
    expect(bridge.setNativeFrame).toHaveBeenLastCalledWith("p:0", { width: 3, height: 2 });
    expect(bridge.render).toHaveBeenCalledTimes(2);
  });

  it("decodes again when nothing was held", async () => {
    const view = mount();
    advance(800);
    await decode(0).answer({ miss: "retry" });
    view.rerender({ photo: photo(), finalShown: false, restores: 0 });
    view.rerender({ photo: photo(), finalShown: true, restores: 0 });
    advance(800);
    expect(decodes).toHaveLength(2);
  });

  it("fetches nothing more while the source stays", async () => {
    const view = mount();
    advance(800);
    await decode(0).answer(FRAME());
    view.rerender({ photo: photo(), finalShown: true, restores: 0 });
    act(() => useDevelopStore.setState({ sourceSize: { ...LARGER } }));
    act(() => view.result.current(true));
    advance(10_000);
    expect(decodes).toHaveLength(1);
  });
});

describe("a renderer restored after a GPU reset", () => {
  it.each([
    ["with the final source shown again", true],
    ["the final source staying", false],
  ])("tells it the held frame's size again, decoding nothing, %s", async (_label, reload) => {
    const view = mount();
    advance(800);
    await decode(0).answer(FRAME());
    if (reload) view.rerender({ photo: photo(), finalShown: false, restores: 1 });
    view.rerender({ photo: photo(), finalShown: true, restores: 1 });
    advance(5000);
    expect(decodes).toHaveLength(1);
    expect(bridge.setNativeFrame).toHaveBeenCalledTimes(2);
  });
});
