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
import { useExternalPluginsSettled } from "@/extensions/loader";
import { useDevelopStore } from "@/state/develop-store";
import type { DevelopPicture } from "./use-develop-picture";
import { useDevelopPhotoLoad, type PhotoLoadArgs } from "./use-develop-photo-load";

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
