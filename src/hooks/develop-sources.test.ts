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

import { prefetchNeighbors } from "./develop-sources";

const photoOf = (id: string) => ({ id }) as CatalogPhoto;
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
