// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The open photo's record, read the way Develop reads it. Catalogue writes land on
// one photo at a time (a preview arriving, a rating, a rotate), so a write to any
// other photo must leave the open one's readers alone.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { photo } from "@/catalog/stored-edit.fixtures";
import { CountRenders, renderCounts, resetRenderCounts } from "@/test/render-count.test-support";
import { useCatalogStore } from "./catalog-store";
import { useActivePhoto, useActivePhotoAspect } from "./use-active-photo";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const INITIAL = useCatalogStore.getState();

const counted = ({ children }: { children: ReactNode }) => (
  <CountRenders id="hook">{children}</CountRenders>
);

function mountHook() {
  const hook = renderHook(useActivePhoto, { wrapper: counted });
  resetRenderCounts();
  return hook;
}

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  useCatalogStore.setState(INITIAL, true);
  useCatalogStore.setState({ photos: [photo("A"), photo("B")], activePhotoId: "A" });
});

afterEach(() => vi.unstubAllGlobals());

describe("useActivePhoto", () => {
  it("returns the open photo's record", () => {
    const { result } = mountHook();
    expect(result.current?.id).toBe("A");
  });

  it("ignores a write to another photo", () => {
    const { result } = mountHook();
    const before = result.current;

    act(() => useCatalogStore.getState().updatePhoto({ ...photo("B"), rating: 4 }));

    expect(renderCounts().hook).toBeUndefined();
    expect(result.current).toBe(before);
  });

  it("hands back the new record when the open photo changes", () => {
    const { result } = mountHook();
    const rated = { ...photo("A"), rating: 5 };

    act(() => useCatalogStore.getState().updatePhoto(rated));

    expect(renderCounts().hook).toBe(1);
    expect(result.current).toBe(rated);
  });

  it("follows a switch to another photo, and to none", () => {
    const { result } = mountHook();

    act(() => useCatalogStore.getState().setActivePhoto("B"));
    expect(result.current?.id).toBe("B");

    act(() => useCatalogStore.getState().setActivePhoto(null));
    expect(result.current).toBeUndefined();
  });
});

describe("at catalogue scale", () => {
  it("finds the open photo without a pass over the catalogue on each store update", () => {
    const N = 50_000;
    const SETS = 100;
    let reads = 0;
    const photos = Array.from({ length: N }, (_, i) => {
      const p = photo(`p${i}`);
      const id = p.id;
      Object.defineProperty(p, "id", { enumerable: true, get: () => (reads++, id) });
      return p;
    });
    useCatalogStore.setState({ photos, activePhotoId: `p${N - 1}` });
    const { result } = renderHook(useActivePhoto);
    expect(result.current?.id).toBe(`p${N - 1}`);
    reads = 0;

    const start = performance.now();
    for (let i = 0; i < SETS; i++) act(() => useCatalogStore.setState({ loading: i % 2 === 0 }));
    const ms = performance.now() - start;
    console.info(
      `[bench] useActivePhoto ×${SETS} store sets on ${N}: ${(ms / SETS).toFixed(3)} ms/set, ${reads} id reads`,
    );

    expect(reads).toBeLessThan(SETS * 4);
  });
});

describe("useActivePhotoAspect", () => {
  it("reads the open photo's stored shape, and 0 when there is none to read", () => {
    useCatalogStore.setState({
      photos: [
        photo("A"),
        { ...photo("B"), width: 4000, height: 6000 },
        { ...photo("C"), height: 0 },
      ],
    });
    const { result } = renderHook(useActivePhotoAspect);
    expect(result.current).toBe(6000 / 4000);

    act(() => useCatalogStore.getState().setActivePhoto("B"));
    expect(result.current).toBe(4000 / 6000);

    act(() => useCatalogStore.getState().setActivePhoto("C"));
    expect(result.current).toBe(0);

    act(() => useCatalogStore.getState().setActivePhoto(null));
    expect(result.current).toBe(0);
  });
});
