// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The photo open in Develop keeps its kept original (a library source's): the
// kept originals' limit and Clear never remove it while it is open, and it is
// theirs again once Develop moves off it.

import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { CatalogPhoto } from "@/catalog/types";
import type { RenderBridge } from "@/rendering/render-bridge";
import { useExternalPluginsSettled } from "@/extensions/loader";
import { useDevelopStore } from "@/state/develop-store";
import {
  bindSourceCache,
  clearKeptOriginals,
  dropLibrarySources,
  registerLibrarySource,
  settleKeptOriginals,
  sourceRefOf,
  sourceRoot,
} from "@/project/library-sources";
import { MemoryFs, fsaDirectoryHandle } from "@/project/memory-fs.test-support";
import type { DevelopPicture } from "./use-develop-picture";
import { useDevelopPhotoLoad, type PhotoLoadArgs } from "./use-develop-photo-load";

vi.mock("@/extensions/essential-params", () => ({ missingAdjustments: () => [] }));

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

function args(photo: CatalogPhoto): PhotoLoadArgs {
  const bridge = {
    ready: new Promise<void>(() => {}),
    availability: "ready",
    sourceGen: 0,
    clearSource: vi.fn(),
    setViewport: vi.fn(),
    bindSource: vi.fn(),
    uploadSource: vi.fn(),
    setImage: vi.fn(),
  };
  return {
    photo,
    fileAccessNonce: 0,
    bridgeRef: { current: bridge as unknown as RenderBridge },
    picture: picture(),
    openPhotoIdRef: { current: photo.id },
    awaitingSourceRef: { current: false },
    finalGenRef: { current: null },
    sentGenRef: { current: null },
    setLoading: vi.fn(),
    setCantShow: vi.fn(),
    setSettledReason: vi.fn(),
    setOverflowedStages: vi.fn(),
    drawSourceRef: { current: vi.fn() },
  };
}

beforeEach(() => {
  // jsdom has no crypto.subtle; kept originals are named by a SHA-256.
  vi.stubGlobal("crypto", webcrypto);
  registerLibrarySource("ext.a", {
    id: "test.server",
    name: "Server",
    library: "lib",
    list: async () => ({ items: ["a", "b"].map((key) => ({ key, name: `${key}.jpg`, size: 4 })) }),
    readPreview: async () => new Blob(),
    readOriginal: async () => new Blob(["1234"]),
    keptOriginalsLimit: null,
  });
  useExternalPluginsSettled.setState({ settled: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  dropLibrarySources("ext.a");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the photo open in Develop", () => {
  it("keeps its kept original until Develop moves off it", async () => {
    const sl = fsaDirectoryHandle(new MemoryFs("/sl"), "/sl");
    const root = sourceRoot("test.server")!;
    bindSourceCache(root, sl);
    const handleA = await root.getFileHandle("a.jpg");
    await handleA.getFile();
    await (await root.getFileHandle("b.jpg")).getFile();
    await settleKeptOriginals();

    const photo = {
      id: "pa",
      filename: "a.jpg",
      relPath: "a.jpg",
      folder: "",
      directoryHandle: null,
      fileHandle: handleA,
      thumbnailBlob: null,
      thumbnailUrl: null,
      width: 6000,
      height: 4000,
      fileSize: 4,
      mimeType: "image/jpeg",
      rating: 0,
      colorLabel: "none",
      flag: "none",
      rotation: 0,
      keywords: [],
      dateCreated: 0,
      dateImported: 0,
      exif: {},
      sourceKey: "a",
    } satisfies CatalogPhoto;
    useDevelopStore.setState({ photoId: photo.id });
    const view = renderHook(() => useDevelopPhotoLoad(args(photo)));

    const ref = sourceRefOf(root)!;
    expect(await clearKeptOriginals(ref, sl)).toEqual({ removed: 1, kept: 1 });
    view.unmount();
    expect(await clearKeptOriginals(ref, sl)).toEqual({ removed: 1, kept: 0 });
  });
});
