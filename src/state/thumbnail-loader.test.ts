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

/** The loader's read window (its `CONCURRENCY`). */
const CONCURRENCY = 3;

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

  it("overlaps reads in a small window instead of strictly one at a time", async () => {
    const g = gate();
    const { calls, loader } = trackingLoader(async (id) => {
      await g.wait;
      return blobFor(id);
    });
    setThumbnailLoader(loader);
    requestThumbnail("a");
    requestThumbnail("b");
    requestThumbnail("c");
    requestThumbnail("d");
    await settle();
    expect(calls).toEqual(["a", "b", "c"]); // window of 3; d waits for a slot

    g.open();
    await settle();
    expect(calls).toEqual(["a", "b", "c", "d"]);
    flushFrames();
    expect(mergedIds().sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("dedupes an id that is already in flight", async () => {
    const g = gate();
    const { calls, loader } = trackingLoader(async (id) => {
      await g.wait;
      return blobFor(id);
    });
    setThumbnailLoader(loader);
    requestThumbnail("a");
    await settle();
    requestThumbnail("a"); // still being read — must not read twice
    g.open();
    await settle();
    expect(calls).toEqual(["a"]);
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

describe("visible requests", () => {
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => String(i));

  it("serves a visible cell before the rest of the idle prefill", async () => {
    const g = gate();
    const { calls, loader } = trackingLoader(async (id) => {
      await g.wait;
      return blobFor(id);
    });
    setThumbnailLoader(loader);
    for (const id of ids(1000)) requestThumbnail(id); // the idle prefill
    requestThumbnail("999", { visible: true });

    g.open();
    await settle();
    // The read window is full with 0..2 when the cell mounts, so the first slot
    // to free up goes to it (today it would be the very last read).
    expect(calls.slice(0, CONCURRENCY + 1)).toContain("999");
  });

  it("reads a prefilled id once when the prefill later reaches it", async () => {
    const { calls, loader } = trackingLoader();
    setThumbnailLoader(loader);
    for (const id of ids(50)) requestThumbnail(id);
    requestThumbnail("40", { visible: true });
    await settle();

    expect(calls).toHaveLength(50);
    expect(new Set(calls).size).toBe(50);
    expect(calls.indexOf("40")).toBe(CONCURRENCY);
  });

  it("serves visible cells in request order, ahead of the prefill", async () => {
    const g = gate();
    const { calls, loader } = trackingLoader(async (id) => {
      await g.wait;
      return blobFor(id);
    });
    setThumbnailLoader(loader);
    for (const id of ids(10)) requestThumbnail(id);
    requestThumbnail("9", { visible: true });
    requestThumbnail("7", { visible: true });
    requestThumbnail("8", { visible: true });

    g.open();
    await settle();
    expect(calls.slice(CONCURRENCY, CONCURRENCY + 3)).toEqual(["9", "7", "8"]);
  });

  it("serves a visible request for an id that was never prefilled", async () => {
    const g = gate();
    const { calls, loader } = trackingLoader(async (id) => {
      await g.wait;
      return blobFor(id);
    });
    setThumbnailLoader(loader);
    for (const id of ids(10)) requestThumbnail(id);
    requestThumbnail("late", { visible: true });

    g.open();
    await settle();
    expect(calls[CONCURRENCY]).toBe("late");
    expect(calls).toHaveLength(11);
  });

  it("keeps an id in flight single when it is requested as visible", async () => {
    const g = gate();
    const { calls, loader } = trackingLoader(async (id) => {
      await g.wait;
      return blobFor(id);
    });
    setThumbnailLoader(loader);
    requestThumbnail("a");
    await settle();
    requestThumbnail("a", { visible: true });

    g.open();
    await settle();
    expect(calls).toEqual(["a"]);
  });

  it("dedupes repeated visible requests and a plain one behind them", async () => {
    const g = gate();
    const { calls, loader } = trackingLoader(async (id) => {
      await g.wait;
      return blobFor(id);
    });
    setThumbnailLoader(loader);
    for (const id of ["a", "b", "c"]) requestThumbnail(id); // fill the window
    requestThumbnail("d", { visible: true });
    requestThumbnail("d", { visible: true });
    requestThumbnail("d");

    g.open();
    await settle();
    expect(calls).toEqual(["a", "b", "c", "d"]);
  });

  it("merges a visible cell's preview like any other read", async () => {
    const { loader } = trackingLoader();
    setThumbnailLoader(loader);
    requestThumbnail("a", { visible: true });
    await settle();
    flushFrames();
    expect(mergedIds()).toEqual(["a"]);
  });

  it("abandons visible requests still waiting when the project swaps", async () => {
    const g = gate();
    const stale = trackingLoader(async (id) => {
      await g.wait;
      return blobFor(id);
    });
    setThumbnailLoader(stale.loader);
    for (const id of ["a", "b", "c"]) requestThumbnail(id);
    await settle();
    requestThumbnail("d", { visible: true });

    // The stale reads keep their slots, so the new loader's first read happens
    // when they settle: a surviving front entry would be read by it then.
    const fresh = trackingLoader();
    setThumbnailLoader(fresh.loader);
    g.open();
    await settle();
    flushFrames();
    expect(stale.calls).toEqual(["a", "b", "c"]);
    expect(fresh.calls).toEqual([]);
    expect(catalog.mergeThumbnails).not.toHaveBeenCalled();
  });

  it("starts the new project's prefill from its first id after a swap", async () => {
    const g = gate();
    const stale = trackingLoader(async (id) => {
      await g.wait;
      return blobFor(id);
    });
    setThumbnailLoader(stale.loader);
    // c takes the last slot with the prefill's head index just past it; d/e/f
    // then wait behind it. A swap that left the head there would skip new ids.
    for (const id of ["a", "b", "c", "d", "e", "f"]) requestThumbnail(id);
    await settle();

    const fresh = trackingLoader();
    setThumbnailLoader(fresh.loader);
    const next = ids(6).map((id) => `n${id}`);
    for (const id of next) requestThumbnail(id);
    g.open();
    await settle();

    expect(fresh.calls).toEqual(next);
  });

  it("drains a 30k-entry prefill with a visible cell in the middle", async () => {
    const { calls, loader } = trackingLoader();
    setThumbnailLoader(loader);
    const all = ids(30_000);
    for (const id of all) requestThumbnail(id);
    requestThumbnail("15000", { visible: true });
    await settle();

    expect(calls).toHaveLength(30_000);
    expect(calls.indexOf("15000")).toBe(CONCURRENCY);
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
    // a/b/c fill the read window; d is still queued when the project swaps.
    requestThumbnail("a");
    requestThumbnail("b");
    requestThumbnail("c");
    await settle();
    requestThumbnail("d");

    setThumbnailLoader(trackingLoader().loader);
    g.open();
    await settle();
    flushFrames();
    expect(stale.calls).toEqual(["a", "b", "c"]); // d never reaches the stale loader
    expect(catalog.mergeThumbnails).not.toHaveBeenCalled();
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

  /** A loader whose reads wait until the test lets them land, counting the most
   *  that ran at once. */
  function heldLoader() {
    const held: Gate[] = [];
    const state = { running: 0, most: 0, calls: [] as string[] };
    setThumbnailLoader(async (id) => {
      state.calls.push(id);
      state.most = Math.max(state.most, ++state.running);
      const g = gate();
      held.push(g);
      await g.wait;
      state.running--;
      return blobFor(id);
    });
    /** Land every read until `done` settles. */
    const landAll = async (done: Promise<unknown>) => {
      let settled = false;
      void done.finally(() => (settled = true));
      for (let rounds = 0; !settled && rounds < 1000; rounds++) {
        await settle();
        for (const g of held.splice(0)) g.open();
      }
    };
    return { state, landAll };
  }

  it("reads no more at once than the window holds, however many photos are reloaded", async () => {
    const { state, landAll } = heldLoader();
    const ids = Array.from({ length: 300 }, (_, i) => `p${i}`);

    const done = Promise.all(ids.map((id) => reloadThumbnail(id)));
    await landAll(done);

    expect(state.most).toBeLessThanOrEqual(CONCURRENCY);
    expect(catalog.replaceThumbnail.mock.calls.map(([id]) => id).sort()).toEqual([...ids].sort());
  });

  it("serves a cell scrolled into view during a burst of reloads next", async () => {
    const { state, landAll } = heldLoader();
    const reloads = Array.from({ length: 10 }, (_, i) => reloadThumbnail(`r${i}`));
    await settle();
    expect(state.calls).toEqual(["r0", "r1", "r2"]);

    requestThumbnail("v", { visible: true });
    await landAll(Promise.all(reloads));

    expect(state.calls[3]).toBe("v");
  });

  it("serves reloads before the idle prefill", async () => {
    const { state, landAll } = heldLoader();
    const busy = ["a", "b", "c"].map((id) => reloadThumbnail(id));
    await settle();
    requestThumbnail("idle");
    const reload = reloadThumbnail("r");

    await landAll(Promise.all([...busy, reload]));

    expect(state.calls.slice(3)).toEqual(["r", "idle"]);
  });

  it("reads a photo once for reloads asked before its read starts", async () => {
    const { state, landAll } = heldLoader();
    const busy = ["a", "b", "c"].map((id) => reloadThumbnail(id));

    const twice = [reloadThumbnail("d"), reloadThumbnail("d")];
    await landAll(Promise.all([...busy, ...twice]));

    expect(state.calls.filter((id) => id === "d")).toEqual(["d"]);
  });

  it("reads a photo again when it is reloaded while a read of it runs", async () => {
    const { state, landAll } = heldLoader();
    requestThumbnail("a");
    await settle();

    const done = reloadThumbnail("a"); // the read running may have the old preview
    await settle();
    expect(state.calls).toEqual(["a"]); // never two reads of one file at once
    await landAll(done);

    expect(state.calls).toEqual(["a", "a"]);
    expect(catalog.replaceThumbnail).toHaveBeenCalledTimes(1);
  });

  it("settles reloads still waiting when the project is swapped, replacing nothing", async () => {
    heldLoader();
    const waiting = ["a", "b", "c", "d"].map((id) => reloadThumbnail(id));

    setThumbnailLoader(trackingLoader().loader);

    await expect(waiting[3]).resolves.toBeUndefined();
    expect(catalog.replaceThumbnail).not.toHaveBeenCalled();
  });
});
