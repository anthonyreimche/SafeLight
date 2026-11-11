// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A load that fails outside the decode's own handling (a bridge disposed under it, a
// draw that throws) still ends: Develop says it can't show the photo instead of
// spinning on with no word.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { CatalogPhoto } from "@/catalog/types";
import type { RenderBridge } from "@/rendering/render-bridge";
import { useDisabledExtensions, useExternalPluginsSettled, useInstalledPlugins } from "@/extensions/loader";
import { useDevelopStore } from "@/state/develop-store";
import type { DevelopPicture } from "./use-develop-picture";
import { useDevelopPhotoLoad, type PhotoLoadArgs } from "./use-develop-photo-load";
import { dropInputProfiles, registerInputProfiles } from "@/catalog/input-profiles";

// The essentials an edit needs: none, unless a test says so, so the extensions'
// settling is all a photo can wait on.
vi.mock("@/extensions/essential-params", () => ({ missingAdjustments: () => [] }));

type LoadBridge = Pick<
  RenderBridge,
  "ready" | "availability" | "sourceGen" | "clearSource" | "setViewport" | "bindSource" | "uploadSource" | "setImage"
>;

const PHOTO: CatalogPhoto = {
  id: "p",
  filename: "p.jpg",
  relPath: "p.jpg",
  folder: "",
  directoryHandle: null,
  fileHandle: null,
  thumbnailBlob: null,
  thumbnailUrl: null,
  width: 6000,
  height: 4000,
  fileSize: 1000,
  mimeType: "image/jpeg",
  rating: 0,
  colorLabel: "none",
  flag: "none",
  rotation: 0,
  keywords: [],
  dateCreated: 0,
  dateImported: 0,
  exif: {},
};

function picture(): DevelopPicture {
  return {
    size: { width: 0, height: 0, window: null, whole: null, crop: null },
    tier: null,
    ctxRef: { current: null },
    present: vi.fn(),
    dropPending: vi.fn(),
    clearPicture: vi.fn(),
    pictureCanvas: () => null,
    isShowing: () => false,
    beginPhoto: vi.fn(),
  };
}

let bindSource: ReturnType<typeof vi.fn<RenderBridge["bindSource"]>>;
let args: PhotoLoadArgs;
let setLoading: ReturnType<typeof vi.fn<PhotoLoadArgs["setLoading"]>>;
let setCantShow: ReturnType<typeof vi.fn<PhotoLoadArgs["setCantShow"]>>;

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  bindSource = vi.fn<RenderBridge["bindSource"]>();
  const bridge: LoadBridge = {
    ready: Promise.resolve(),
    availability: "ready",
    sourceGen: 0,
    clearSource: vi.fn(),
    setViewport: vi.fn(),
    bindSource,
    uploadSource: vi.fn(),
    setImage: vi.fn(),
  };
  setLoading = vi.fn<PhotoLoadArgs["setLoading"]>();
  setCantShow = vi.fn<PhotoLoadArgs["setCantShow"]>();
  args = {
    photo: PHOTO,
    fileAccessNonce: 0,
    bridgeRef: { current: bridge as RenderBridge },
    picture: picture(),
    openPhotoIdRef: { current: PHOTO.id },
    awaitingSourceRef: { current: false },
    finalGenRef: { current: null },
    sentGenRef: { current: null },
    setLoading,
    setCantShow,
    setSettledReason: vi.fn(),
    setOverflowedStages: vi.fn(),
    drawSourceRef: { current: vi.fn() },
  };
  useExternalPluginsSettled.setState({ settled: true });
  useDevelopStore.setState({ photoId: PHOTO.id });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useDevelopPhotoLoad when the load fails outside the decode", () => {
  it("stops loading and says it can't show the photo", async () => {
    bindSource.mockRejectedValue(new Error("bridge disposed"));
    renderHook(() => useDevelopPhotoLoad(args));
    await settle();

    expect(setLoading).toHaveBeenLastCalledWith(false);
    expect(setCantShow).toHaveBeenLastCalledWith("Can't show this photo.");
  });

  it("sets nothing once the photo it loaded is left", async () => {
    let fail: (e: Error) => void = () => {};
    bindSource.mockReturnValue(new Promise<boolean>((_resolve, reject) => (fail = reject)));
    const view = renderHook(() => useDevelopPhotoLoad(args));
    await settle();
    setLoading.mockClear();
    setCantShow.mockClear();

    view.unmount();
    fail(new Error("bridge disposed"));
    await settle();

    expect(setLoading).not.toHaveBeenCalled();
    expect(setCantShow).not.toHaveBeenCalled();
  });
});

// A non-RAW photo's source depends on how its input profile is read: the open photo
// loads again when that changes, as it does for any change of its source key.
describe("useDevelopPhotoLoad and the photo's source key", () => {
  beforeEach(() => bindSource.mockResolvedValue(true));
  afterEach(() => dropInputProfiles("ext.profiles"));

  const keys = () => bindSource.mock.calls.map(([key]) => key);

  it("loads again when the photo's input profile token changes", async () => {
    registerInputProfiles("ext.profiles", { resolve: async () => null });
    const view = renderHook((a: PhotoLoadArgs) => useDevelopPhotoLoad(a), { initialProps: args });
    await settle();

    view.rerender({ ...args, photo: { ...PHOTO, inputProfile: "assign:p3" } });
    await settle();

    expect(keys()).toHaveLength(2);
    expect(keys()[1]).not.toBe(keys()[0]);
  });

  it("loads again when the resolver's revision moves", async () => {
    renderHook(() => useDevelopPhotoLoad(args));
    await settle();

    act(() => registerInputProfiles("ext.profiles", { resolve: async () => null }));
    await settle();

    expect(keys()).toHaveLength(2);
    expect(keys()[1]).not.toBe(keys()[0]);
  });

  it("loads once for a turn, which changes the key too", async () => {
    const view = renderHook((a: PhotoLoadArgs) => useDevelopPhotoLoad(a), { initialProps: args });
    await settle();

    view.rerender({ ...args, photo: { ...PHOTO, rotation: 90 } });
    await settle();

    expect(keys()).toHaveLength(2);
  });

  it("loads nothing again for a change that leaves the key as it was", async () => {
    const view = renderHook((a: PhotoLoadArgs) => useDevelopPhotoLoad(a), { initialProps: args });
    await settle();

    view.rerender({ ...args, photo: { ...PHOTO, rating: 4 } });
    await settle();

    expect(keys()).toHaveLength(1);
  });
});

// The resolver is an external extension's, registered as the app boots: a non-RAW
// photo opened before then would be read as sRGB and kept under the old key.
describe("useDevelopPhotoLoad before the extensions have settled", () => {
  beforeEach(() => {
    bindSource.mockResolvedValue(true);
    useExternalPluginsSettled.setState({ settled: false });
    localStorage.clear();
    // Registered last session, so it is expected again.
    registerInputProfiles("ext.profiles", { resolve: async () => null });
    dropInputProfiles("ext.profiles");
  });

  afterEach(() => {
    useInstalledPlugins.setState({ ids: null });
    useDisabledExtensions.setState({ ids: [] });
  });

  it("doesn't hold a non-RAW photo when no extension has ever supplied input profiles", async () => {
    localStorage.clear();
    renderHook(() => useDevelopPhotoLoad(args));
    await settle();

    expect(bindSource).toHaveBeenCalledOnce();
  });

  it("doesn't hold it for the expected extension once it's uninstalled", async () => {
    useInstalledPlugins.setState({ ids: ["something.else"] });
    renderHook(() => useDevelopPhotoLoad(args));
    await settle();

    expect(bindSource).toHaveBeenCalledOnce();
  });

  it("doesn't hold it for the expected extension when it's turned off", async () => {
    useDisabledExtensions.setState({ ids: ["ext.profiles"] });
    renderHook(() => useDevelopPhotoLoad(args));
    await settle();

    expect(bindSource).toHaveBeenCalledOnce();
  });

  it("holds a non-RAW photo until they settle", async () => {
    renderHook(() => useDevelopPhotoLoad(args));
    await settle();
    expect(bindSource).not.toHaveBeenCalled();

    act(() => useExternalPluginsSettled.setState({ settled: true }));
    await settle();
    expect(bindSource).toHaveBeenCalledOnce();
  });

  it("lets it go once the input profile resolver registers", async () => {
    renderHook(() => useDevelopPhotoLoad(args));
    await settle();

    act(() => registerInputProfiles("ext.profiles", { resolve: async () => null }));
    await settle();

    expect(bindSource).toHaveBeenCalledOnce();
    dropInputProfiles("ext.profiles");
  });

  it("holds it no longer than the essentials wait", async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useDevelopPhotoLoad(args));
      await act(() => vi.advanceTimersByTimeAsync(2900));
      expect(bindSource).not.toHaveBeenCalled();

      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(bindSource).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't hold a RAW whose edit needs nothing that is still to come", async () => {
    renderHook(() => useDevelopPhotoLoad({ ...args, photo: { ...PHOTO, filename: "p.nef" } }));
    await settle();

    expect(bindSource).toHaveBeenCalledOnce();
  });
});
