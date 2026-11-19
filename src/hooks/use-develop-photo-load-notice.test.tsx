// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An HDR HEIF shown with its codes read as SDR says so in Develop's corner, on
// its first open and when it is bound again from the GPU cache.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { CatalogPhoto } from "@/catalog/types";
import type { RenderBridge } from "@/rendering/render-bridge";
import type { DecodedImage } from "@/catalog/load-image";
import { useExternalPluginsSettled } from "@/extensions/loader";
import { useDevelopStore } from "@/state/develop-store";
import type { DevelopPicture } from "./use-develop-picture";

const h = vi.hoisted(() => ({ image: null as DecodedImage | null }));

vi.mock("@/catalog/load-image", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/catalog/load-image")>()),
  loadPhotoImage: async () => h.image,
}));

vi.mock("@/extensions/essential-params", () => ({ missingAdjustments: () => [] }));

import { useDevelopPhotoLoad, type PhotoLoadArgs } from "./use-develop-photo-load";
import { noteSource } from "./develop-sources";
import { photoSourceKey } from "@/catalog/load-image";

type LoadBridge = Pick<
  RenderBridge,
  "ready" | "availability" | "sourceGen" | "clearSource" | "setViewport" | "bindSource" | "uploadSource" | "setImage"
>;

const PHOTO: CatalogPhoto = {
  id: "h",
  filename: "C0001.HIF",
  relPath: "C0001.HIF",
  folder: "",
  directoryHandle: null,
  fileHandle: null,
  thumbnailBlob: null,
  thumbnailUrl: null,
  width: 40,
  height: 30,
  fileSize: 10,
  mimeType: "image/heif",
  rating: 0,
  colorLabel: "none",
  flag: "none",
  rotation: 0,
  keywords: [],
  dateCreated: 0,
  dateImported: 0,
  exif: {},
};

const hdrFrame = (hdr: boolean): DecodedImage => ({
  kind: "float16",
  data: new Uint16Array(16),
  width: 2,
  height: 2,
  displayReferred: true,
  ...(hdr ? { hdrShownAsSdr: true as const } : {}),
});

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

let bound: boolean;
let setSourceNotice: ReturnType<typeof vi.fn<PhotoLoadArgs["setSourceNotice"]>>;
let args: PhotoLoadArgs;

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  bound = false;
  const bridge: LoadBridge = {
    ready: Promise.resolve(),
    availability: "ready",
    sourceGen: 0,
    clearSource: vi.fn(),
    setViewport: vi.fn(),
    bindSource: vi.fn(async () => bound),
    uploadSource: vi.fn(async () => true),
    setImage: vi.fn(),
  };
  setSourceNotice = vi.fn<PhotoLoadArgs["setSourceNotice"]>();
  args = {
    photo: PHOTO,
    fileAccessNonce: 0,
    bridgeRef: { current: bridge as RenderBridge },
    picture: picture(),
    openPhotoIdRef: { current: PHOTO.id },
    awaitingSourceRef: { current: false },
    finalGenRef: { current: null },
    sentGenRef: { current: null },
    setLoading: vi.fn(),
    setCantShow: vi.fn(),
    setSettledReason: vi.fn(),
    setSourceNotice,
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

describe("Develop's word on an HDR HEIF", () => {
  it("says it is shown without its HDR", async () => {
    h.image = hdrFrame(true);
    renderHook(() => useDevelopPhotoLoad(args));
    await settle();
    expect(setSourceNotice).toHaveBeenLastCalledWith("HDR shown as SDR");
  });

  it("says nothing of an SDR photo", async () => {
    h.image = hdrFrame(false);
    renderHook(() => useDevelopPhotoLoad(args));
    await settle();
    expect(setSourceNotice).toHaveBeenLastCalledWith(null);
  });

  it("says it of a neighbour put in the GPU cache before it was opened", async () => {
    noteSource({} as RenderBridge, photoSourceKey(PHOTO), hdrFrame(true));
    bound = true;
    renderHook(() => useDevelopPhotoLoad(args));
    await settle();
    expect(setSourceNotice).toHaveBeenLastCalledWith("HDR shown as SDR");
  });

  it("says it again when the photo is bound from the GPU cache", async () => {
    h.image = hdrFrame(true);
    const first = renderHook(() => useDevelopPhotoLoad(args));
    await settle();
    first.unmount();

    bound = true;
    setSourceNotice.mockClear();
    renderHook(() => useDevelopPhotoLoad(args));
    await settle();
    expect(setSourceNotice).toHaveBeenLastCalledWith("HDR shown as SDR");
  });
});
