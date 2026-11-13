// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Browse-card thumbnails (thumbnails.cjs): a grid of repos resolves with a
// bounded number of fetches in flight, a host that did not answer is asked
// again after a few minutes rather than cached as "no icon" for hours, and an
// oversize manifest is ignored.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThumbnails } from "./thumbnails.cjs";

type Fetch = (url: string) => Promise<Response>;

describe("resolveThumbnails", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-thumbs-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const thumbsWith = (fetch: Fetch) =>
    createThumbnails({ net: { fetch }, userData: () => root, fileWriter: { write: async () => {} } });

  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ repo: `acme/ext${i}`, avatar: null }));

  it("keeps at most 8 fetches in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const thumbs = thumbsWith(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return new Response("", { status: 404 });
    });
    const out = await thumbs.resolveThumbnails(items(40));
    expect(Object.keys(out)).toHaveLength(40);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("asks a host that did not answer again after five minutes, not on every open", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let calls = 0;
      const thumbs = thumbsWith(async () => {
        calls++;
        throw new Error("offline");
      });
      await thumbs.resolveThumbnails(items(1));
      const first = calls;
      await thumbs.resolveThumbnails(items(1));
      expect(calls).toBe(first);
      vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
      await thumbs.resolveThumbnails(items(1));
      expect(calls).toBe(first * 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not keep the fallback when the body fails midway", async () => {
    let calls = 0;
    const thumbs = thumbsWith(async () => {
      calls++;
      const body = new ReadableStream({ pull: (c) => c.error(new Error("reset")) });
      return new Response(body, { status: 200 });
    });
    await thumbs.resolveThumbnails(items(1));
    const first = calls;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
      await thumbs.resolveThumbnails(items(1));
      expect(calls).toBe(first * 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches a 404 as no icon", async () => {
    let calls = 0;
    const thumbs = thumbsWith(async () => {
      calls++;
      return new Response("", { status: 404 });
    });
    await thumbs.resolveThumbnails(items(1));
    const first = calls;
    await thumbs.resolveThumbnails(items(1));
    expect(calls).toBe(first);
  });

  it("ignores an oversize manifest", async () => {
    const thumbs = thumbsWith(async (url) =>
      url.includes("jsdelivr")
        ? new Response(`{"icon":"${"a".repeat(300 * 1024)}"}`)
        : new Response("", { status: 404 }),
    );
    const out = await thumbs.resolveThumbnails(items(1));
    expect(out["acme/ext0"].custom).toBe(false);
  });
});
