import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";
import type { RenderBridge } from "@/rendering/render-bridge";

const mocks = vi.hoisted(() => ({
  loadPhotoImage: vi.fn(),
  visibleList: vi.fn(),
  visibleIndex: vi.fn(),
}));

vi.mock("@/catalog/load-image", () => ({
  loadPhotoImage: mocks.loadPhotoImage,
  photoSourceKey: (photo: { id: string }) => `key:${photo.id}`,
  refreshStaleSource: vi.fn(),
}));
vi.mock("@/catalog/cache-events", () => ({ onCacheEntryFilled: vi.fn() }));
vi.mock("@/modules/library/photo-navigation", () => ({
  visibleList: mocks.visibleList,
  visibleIndex: mocks.visibleIndex,
}));
vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ developPrefetchNeighbors: true, developMaxEdge: 4096 }),
}));

import { refreshStaleSource } from "@/catalog/load-image";
import { isPreview, noteSource, prefetchNeighbors, refreshHeldSource } from "./develop-sources";

const photoOf = (id: string, filename = `${id}.jpg`) => ({ id, filename }) as CatalogPhoto;
const floatImage = () => ({ kind: "float16", data: new Uint16Array(4), width: 1, height: 1 });

describe("prefetchNeighbors idle gate", () => {
  let quiet: () => void;
  const uploadSource = vi.fn();
  const whenRenderQuiet = vi.fn(
    () => new Promise<void>((resolve) => {
      quiet = resolve;
    }),
  );
  const bridge = {
    hasSource: async () => false,
    uploadSource,
    whenRenderQuiet,
    // noteSource only needs a WeakMap key.
  } as unknown as RenderBridge;
  const flush = () => vi.advanceTimersByTimeAsync(300);

  beforeEach(() => {
    vi.useFakeTimers();
    uploadSource.mockClear();
    whenRenderQuiet.mockClear();
    mocks.loadPhotoImage.mockReset().mockImplementation(async () => floatImage());
    mocks.visibleList.mockReturnValue([photoOf("a"), photoOf("b")]);
    mocks.visibleIndex.mockReturnValue(0);
  });
  afterEach(() => vi.useRealTimers());

  it("decodes nothing while renders keep the worker busy, then decodes and uploads at once", async () => {
    const run = prefetchNeighbors(bridge, photoOf("a"), () => false, new AbortController().signal);
    await flush();
    expect(whenRenderQuiet).toHaveBeenCalledTimes(1);
    expect(mocks.loadPhotoImage).not.toHaveBeenCalled();
    expect(uploadSource).not.toHaveBeenCalled();
    quiet();
    await run;
    expect(mocks.loadPhotoImage).toHaveBeenCalledTimes(1);
    expect(whenRenderQuiet).toHaveBeenCalledTimes(1);
    expect(uploadSource).toHaveBeenCalledTimes(1);
    expect(uploadSource.mock.calls[0][1]).toBe("key:b");
  });

  // The renderer caps a converted non-RAW source to the develop edge anyway: it is
  // averaged down in the worker instead. A RAW's decode is left at full size.
  it("asks a non-RAW neighbour's load for no more than the develop edge, and a RAW's for all of it", async () => {
    mocks.visibleList.mockReturnValue([photoOf("a"), photoOf("b"), photoOf("c", "c.nef")]);
    mocks.visibleIndex.mockReturnValue(1);
    const run = prefetchNeighbors(bridge, photoOf("b"), () => false, new AbortController().signal);
    await flush();
    quiet();
    await vi.advanceTimersByTimeAsync(0);
    quiet();
    await run;

    const asked = mocks.loadPhotoImage.mock.calls.map(([p, opts]) => [p.id, opts.targetEdge]);
    expect(asked).toEqual([
      ["c", undefined],
      ["a", 4096],
    ]);
  });

  it("decodes and uploads nothing for a prefetch cancelled while it waited for quiet", async () => {
    let gone = false;
    const run = prefetchNeighbors(bridge, photoOf("a"), () => gone, new AbortController().signal);
    await flush();
    expect(whenRenderQuiet).toHaveBeenCalledTimes(1);
    gone = true;
    quiet();
    await run;
    expect(mocks.loadPhotoImage).not.toHaveBeenCalled();
    expect(uploadSource).not.toHaveBeenCalled();
  });
});

// A non-RAW photo read through its input profile comes as halves with no sample,
// like a RAW cache entry from before 3.1.0, but there is no RAW cache entry to
// complete it from.
describe("a display-referred source", () => {
  const converted = () => ({ ...floatImage(), kind: "float16" as const, displayReferred: true as const });

  it("is the photo's own pixels, not a preview", () => {
    expect(isPreview(converted())).toBe(false);
  });

  it("is never taken for a stale RAW cache entry", () => {
    const bridge = {} as RenderBridge;
    noteSource(bridge, "key:j", converted());

    refreshHeldSource(bridge, photoOf("j"), "key:j", { current: "j" });

    expect(refreshStaleSource).not.toHaveBeenCalled();
  });
});
