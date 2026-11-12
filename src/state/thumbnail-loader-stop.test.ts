// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A read a cell on screen asked for stops once no cell wants it any more (they
// scrolled away, or the person left the album), and every read stops when the
// project changes: a library source's previews come over the network, and
// reads for photos nobody is looking at would hold up the ones they are. Its
// place in the read window goes to the next cell at once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const catalog = vi.hoisted(() => ({
  mergeThumbnails: vi.fn<(updates: { id: string; blob: Blob }[]) => string[]>((updates) => updates.map((u) => u.id)),
  replaceThumbnail: vi.fn<(id: string, blob: Blob) => void>(),
  dropThumbnails: vi.fn<(entries: { id: string; blob: Blob }[]) => string[]>((entries) => entries.map((e) => e.id)),
  activePhotoId: null as string | null,
}));

vi.mock("./catalog-store", () => ({ useCatalogStore: { getState: () => catalog } }));

import { cancelThumbnail, reloadThumbnail, requestThumbnail, setThumbnailLoader } from "./thumbnail-loader";

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A loader whose reads wait until the test ends them, or until they are
 *  stopped, as a network read does. */
function slowLoader() {
  const started: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const finish = new Map<string, () => void>();
  const loader = (id: string, signal: AbortSignal) => {
    started.push(id);
    signals.set(id, signal);
    return new Promise<Blob | null>((resolve, reject) => {
      finish.set(id, () => resolve(new Blob([id])));
      signal.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")));
    });
  };
  const stopped = () => [...signals].filter(([, s]) => s.aborted).map(([id]) => id);
  return { loader, started, stopped, finish };
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  setThumbnailLoader(null);
  catalog.mergeThumbnails.mockClear();
});

afterEach(() => {
  setThumbnailLoader(null);
  vi.unstubAllGlobals();
});

describe("a visible read in flight", () => {
  it("stops once its cell leaves, and its place goes to the next cell", async () => {
    const l = slowLoader();
    setThumbnailLoader(l.loader);
    for (const id of ["a", "b", "c", "d"]) requestThumbnail(id, { visible: true });
    expect(l.started).toEqual(["a", "b", "c"]);
    cancelThumbnail("a");
    await settle();
    expect(l.stopped()).toEqual(["a"]);
    expect(l.started).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps going while another cell still wants it", async () => {
    const l = slowLoader();
    setThumbnailLoader(l.loader);
    requestThumbnail("a", { visible: true });
    expect(requestThumbnail("a", { visible: true })).toBe(true);
    cancelThumbnail("a");
    expect(l.stopped()).toEqual([]);
    cancelThumbnail("a");
    expect(l.stopped()).toEqual(["a"]);
  });

  it("merges nothing once stopped, and is read again when a cell asks again", async () => {
    const l = slowLoader();
    setThumbnailLoader(l.loader);
    requestThumbnail("a", { visible: true });
    cancelThumbnail("a");
    await settle();
    requestThumbnail("a", { visible: true });
    expect(l.started).toEqual(["a", "a"]);
    l.finish.get("a")!();
    await settle();
    await settle();
    expect(catalog.mergeThumbnails).toHaveBeenCalledTimes(1);
  });

  it("isn't stopped when a reload waits on it", async () => {
    const l = slowLoader();
    setThumbnailLoader(l.loader);
    for (const id of ["x", "y", "z"]) requestThumbnail(id);
    void reloadThumbnail("a");
    requestThumbnail("a", { visible: true });
    l.finish.get("x")!();
    await settle();
    expect(l.started).toContain("a");
    cancelThumbnail("a");
    expect(l.stopped()).toEqual([]);
  });
});

describe("a read the idle prefill began", () => {
  it("is never stopped by a cell", async () => {
    const l = slowLoader();
    setThumbnailLoader(l.loader);
    requestThumbnail("a");
    expect(requestThumbnail("a", { visible: true })).toBe(false);
    cancelThumbnail("a");
    expect(l.stopped()).toEqual([]);
  });
});

describe("a project change", () => {
  it("stops every read of the project left", async () => {
    const l = slowLoader();
    setThumbnailLoader(l.loader);
    requestThumbnail("a", { visible: true });
    requestThumbnail("b");
    setThumbnailLoader(slowLoader().loader);
    expect(l.stopped().sort()).toEqual(["a", "b"]);
  });
});

/** A loader like buildPreviewBlob's: it doesn't stop mid-way, and gives nothing
 *  once it was stopped. */
function settlingLoader() {
  const started: string[] = [];
  const finish: (() => void)[] = [];
  const loader = (id: string, signal: AbortSignal) => {
    started.push(id);
    return new Promise<Blob | null>((resolve) => finish.push(() => resolve(signal.aborted ? null : new Blob([id]))));
  };
  return { loader, started, finish };
}

describe("a cell that comes back while its stopped read settles", () => {
  it("has its preview read again", async () => {
    const l = settlingLoader();
    setThumbnailLoader(l.loader);
    expect(requestThumbnail("a", { visible: true })).toBe(true);
    cancelThumbnail("a"); // scrolled away: the read is stopped, still running
    expect(requestThumbnail("a", { visible: true })).toBe(true); // scrolled back
    l.finish[0]();
    await settle();
    expect(l.started).toEqual(["a", "a"]);
    l.finish[1]();
    await settle();
    await settle();
    expect(catalog.mergeThumbnails).toHaveBeenCalledTimes(1);
  });

  it("isn't read again when it left once more before the stopped read settled", async () => {
    const l = settlingLoader();
    setThumbnailLoader(l.loader);
    requestThumbnail("a", { visible: true });
    cancelThumbnail("a");
    requestThumbnail("a", { visible: true });
    cancelThumbnail("a");
    l.finish[0]();
    await settle();
    expect(l.started).toEqual(["a"]);
  });
});

describe("a stopped read the idle prefill held", () => {
  it("goes back to the prefill", async () => {
    const l = settlingLoader();
    setThumbnailLoader(l.loader);
    for (const id of ["x", "y", "z"]) requestThumbnail(id); // fill the window
    requestThumbnail("p"); // the prefill holds it
    requestThumbnail("p", { visible: true }); // a cell takes it out of the prefill
    l.finish[0](); // x ends: p's visible read starts
    await settle();
    expect(l.started).toEqual(["x", "y", "z", "p"]);
    cancelThumbnail("p"); // its cell leaves: the read is stopped
    l.finish[3]();
    await settle();
    l.finish[1]();
    await settle();
    expect(l.started).toEqual(["x", "y", "z", "p", "p"]);
  });
});
