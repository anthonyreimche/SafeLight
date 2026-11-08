// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// cancelThumbnail: a visible request whose cell left the screen is dropped
// from the queue (refcounted across requesters) unless its read already runs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./catalog-store", () => ({
  useCatalogStore: {
    getState: () => ({
      mergeThumbnails: (updates: { id: string }[]) => updates.map((u) => u.id),
      replaceThumbnail: () => {},
      dropThumbnails: () => [],
      activePhotoId: null,
    }),
  },
}));

import { cancelThumbnail, requestThumbnail, setThumbnailLoader } from "./thumbnail-loader";

const blobFor = (id: string): Blob => new Blob([id]);
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let frames: FrameRequestCallback[] = [];
const flushFrames = (): void => {
  const due = frames;
  frames = [];
  for (const cb of due) cb(0);
};

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  setThumbnailLoader(null);
});

afterEach(() => {
  flushFrames();
  vi.unstubAllGlobals();
});

describe("cancelThumbnail", () => {
  const heldReads = () => {
    let open = (): void => {};
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    const calls: string[] = [];
    setThumbnailLoader(async (id) => {
      calls.push(id);
      await wait;
      return blobFor(id);
    });
    return { g: { open }, calls };
  };

  it("drops visible requests that left, keeping those in flight", async () => {
    const { g, calls } = heldReads();
    const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
    for (const id of ids) requestThumbnail(id, { visible: true });
    await settle();
    expect(calls).toEqual(["p0", "p1", "p2"]);

    for (const id of ids.slice(2)) cancelThumbnail(id);
    g.open();
    await settle();

    expect(calls).toEqual(["p0", "p1", "p2"]);
  });

  it("keeps a request another requester still holds", async () => {
    const { g, calls } = heldReads();
    for (const id of ["a", "b", "c"]) requestThumbnail(id, { visible: true });
    requestThumbnail("shared", { visible: true });
    requestThumbnail("shared", { visible: true });
    cancelThumbnail("shared");
    g.open();
    await settle();
    expect(calls).toContain("shared");
  });

  it("drops the request once its last requester cancels", async () => {
    const { g, calls } = heldReads();
    for (const id of ["a", "b", "c"]) requestThumbnail(id, { visible: true });
    requestThumbnail("shared", { visible: true });
    requestThumbnail("shared", { visible: true });
    cancelThumbnail("shared");
    cancelThumbnail("shared");
    g.open();
    await settle();
    expect(calls).not.toContain("shared");
  });

  it("leaves a read already in flight alone", async () => {
    const { g, calls } = heldReads();
    requestThumbnail("a", { visible: true });
    await settle();
    cancelThumbnail("a");
    g.open();
    await settle();
    expect(calls).toEqual(["a"]);
    expect(frames).toHaveLength(1); // its blob still merges
  });

  it("does not move a cancelled id to the idle queue", async () => {
    const { g, calls } = heldReads();
    for (const id of ["a", "b", "c"]) requestThumbnail(id, { visible: true });
    requestThumbnail("d", { visible: true });
    cancelThumbnail("d");
    g.open();
    await settle();
    expect(calls).not.toContain("d");
  });
});
