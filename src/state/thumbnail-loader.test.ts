// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The on-demand grid-preview queue: request order, dedup, the one-update-per-
// frame flush, and the generation guard that keeps a previous project's reads
// out of the newly opened catalog. The catalog store is the sink at the far end,
// so it's stubbed; reads are driven through gated loaders so an "in flight"
// moment is an actual point in the test, not a timing race.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const catalog = vi.hoisted(() => ({
  mergeThumbnails: vi.fn<(updates: { id: string; blob: Blob }[]) => void>(),
  replaceThumbnail: vi.fn<(id: string, blob: Blob) => void>(),
}));

vi.mock("./catalog-store", () => ({
  useCatalogStore: { getState: () => catalog },
}));

import {
  reloadThumbnail,
  requestThumbnail,
  setThumbnailLoader,
  thumbnailGen,
} from "./thumbnail-loader";

const blobFor = (id: string): Blob => new Blob([id]);

/** Resolve after every already-queued microtask chain has run to completion. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Gate {
  wait: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { wait, open };
}

interface TrackedLoader {
  calls: string[];
  loader: (id: string) => Promise<Blob | null>;
}

function trackingLoader(
  read: (id: string) => Promise<Blob | null> = async (id) => blobFor(id),
): TrackedLoader {
  const calls: string[] = [];
  return {
    calls,
    loader: (id) => {
      calls.push(id);
      return read(id);
    },
  };
}

let frames: FrameRequestCallback[] = [];

function flushFrames(): void {
  const due = frames;
  frames = [];
  for (const cb of due) cb(0);
}

const mergedIds = (): string[] =>
  catalog.mergeThumbnails.mock.calls.flatMap(([updates]) => updates.map((u) => u.id));

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  setThumbnailLoader(null);
  catalog.mergeThumbnails.mockClear();
  catalog.replaceThumbnail.mockClear();
});

afterEach(() => {
  // Leaving a frame pending would keep the module's flush flag set for the next
  // test, so the queue would fill but never drain.
  flushFrames();
  vi.unstubAllGlobals();
});

describe("requestThumbnail", () => {
  it("reads queued ids in request order and merges them in one update", async () => {
    const { calls, loader } = trackingLoader();
    setThumbnailLoader(loader);
    requestThumbnail("a");
    requestThumbnail("b");
    requestThumbnail("c");
    await settle();

    expect(calls).toEqual(["a", "b", "c"]);
    expect(frames).toHaveLength(1); // one batched store update, not three
    flushFrames();
    expect(catalog.mergeThumbnails).toHaveBeenCalledTimes(1);
    expect(mergedIds()).toEqual(["a", "b", "c"]);
  });

  it("dedupes an id already waiting in the queue", async () => {
    const g = gate();
    const { calls, loader } = trackingLoader(async (id) => {
      await g.wait;
      return blobFor(id);
    });
    setThumbnailLoader(loader);
    requestThumbnail("a"); // taken by the pump, now blocked on the gate
    await settle();
    requestThumbnail("b");
    requestThumbnail("b");
    requestThumbnail("c");

    g.open();
    await settle();
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("drops requests made before a project installs a loader", async () => {
    requestThumbnail("a");
    const { calls, loader } = trackingLoader();
    setThumbnailLoader(loader);
    await settle();
    expect(calls).toEqual([]);
  });

  it("keeps pumping after the queue has drained", async () => {
    const { calls, loader } = trackingLoader();
    setThumbnailLoader(loader);
    requestThumbnail("a");
    await settle();
    flushFrames();
    requestThumbnail("b");
    await settle();
    expect(calls).toEqual(["a", "b"]);
  });

  it("skips a preview the loader has nothing for", async () => {
    const { loader } = trackingLoader(async (id) => (id === "b" ? null : blobFor(id)));
    setThumbnailLoader(loader);
    requestThumbnail("a");
    requestThumbnail("b");
    await settle();
    flushFrames();
    expect(mergedIds()).toEqual(["a"]);
  });

  it("keeps draining after a failed read", async () => {
    const { calls, loader } = trackingLoader(async (id) => {
      if (id === "a") throw new Error("unreadable");
      return blobFor(id);
    });
    setThumbnailLoader(loader);
    requestThumbnail("a");
    requestThumbnail("b");
    await settle();
    flushFrames();

    expect(calls).toEqual(["a", "b"]);
    expect(mergedIds()).toEqual(["b"]);
  });
});

describe("project generation", () => {
  it("bumps the generation on every install", () => {
    const before = thumbnailGen();
    expect(setThumbnailLoader(trackingLoader().loader)).toBe(before + 1);
    expect(thumbnailGen()).toBe(before + 1);
    expect(setThumbnailLoader(null)).toBe(before + 2);
  });

  it("discards a read that lands after the project was swapped", async () => {
    const g = gate();
    const { loader } = trackingLoader(async (id) => {
      await g.wait;
      return blobFor(id);
    });
    setThumbnailLoader(loader);
    requestThumbnail("a");
    await settle();

    setThumbnailLoader(trackingLoader().loader); // a newer folder is opened
    g.open();
    await settle();
    flushFrames();
    expect(catalog.mergeThumbnails).not.toHaveBeenCalled();
  });

  it("abandons the previous project's queue", async () => {
    const g = gate();
    const stale = trackingLoader(async (id) => {
      await g.wait;
      return blobFor(id);
    });
    setThumbnailLoader(stale.loader);
    requestThumbnail("a");
    await settle();
    requestThumbnail("b");
    requestThumbnail("c");

    setThumbnailLoader(trackingLoader().loader);
    g.open();
    await settle();
    expect(stale.calls).toEqual(["a"]);
  });

  it("drains requests queued behind a stale read", async () => {
    const g = gate();
    const stale = trackingLoader(async (id) => {
      await g.wait;
      return blobFor(id);
    });
    setThumbnailLoader(stale.loader);
    requestThumbnail("a");
    await settle();

    const fresh = trackingLoader();
    setThumbnailLoader(fresh.loader);
    requestThumbnail("b"); // arrives while the stale pump still owns the lock
    g.open();
    await settle();
    flushFrames();

    expect(fresh.calls).toEqual(["b"]);
    expect(mergedIds()).toEqual(["b"]);
  });
});

describe("reloadThumbnail", () => {
  it("replaces an existing preview straight away", async () => {
    const { calls, loader } = trackingLoader();
    setThumbnailLoader(loader);
    await reloadThumbnail("a");

    expect(calls).toEqual(["a"]);
    expect(catalog.replaceThumbnail).toHaveBeenCalledTimes(1);
    expect(catalog.replaceThumbnail.mock.calls[0][0]).toBe("a");
    expect(catalog.mergeThumbnails).not.toHaveBeenCalled(); // not the batched path
  });

  it("does nothing without a project", async () => {
    await reloadThumbnail("a");
    expect(catalog.replaceThumbnail).not.toHaveBeenCalled();
  });

  it("swallows a failed read", async () => {
    setThumbnailLoader(async () => {
      throw new Error("unreadable");
    });
    await expect(reloadThumbnail("a")).resolves.toBeUndefined();
    expect(catalog.replaceThumbnail).not.toHaveBeenCalled();
  });

  it("ignores a missing file", async () => {
    setThumbnailLoader(async () => null);
    await reloadThumbnail("a");
    expect(catalog.replaceThumbnail).not.toHaveBeenCalled();
  });

  it("discards a read that lands after the project was swapped", async () => {
    const g = gate();
    setThumbnailLoader(async (id) => {
      await g.wait;
      return blobFor(id);
    });
    const done = reloadThumbnail("a");
    setThumbnailLoader(trackingLoader().loader);
    g.open();
    await done;
    expect(catalog.replaceThumbnail).not.toHaveBeenCalled();
  });
});
