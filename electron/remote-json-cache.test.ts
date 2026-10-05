// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The main-process cache behind plugins.kits: the welcome setup must get the
// last good kits.json when GitHub is slow or gone, and must not refetch on
// every open. Runs against a temp folder with a fake clock and fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRemoteJsonCache } from "./remote-json-cache.cjs";

const URL = "https://example.test/kits.json";
const TTL = 60_000;

type Fetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

let root: string;
let file: string;
let clock: number;

const ok = (body: unknown) => ({ ok: true, json: async () => body });
const make = (fetchJson: Fetch) =>
  createRemoteJsonCache({
    url: URL,
    cacheFile: () => file,
    ttlMs: TTL,
    fetchJson,
    now: () => clock,
  });
const disk = () => JSON.parse(fs.readFileSync(file, "utf8"));
const seedDisk = (at: number, data: unknown) =>
  fs.writeFileSync(file, JSON.stringify({ at, data }));

const failures: [string, Fetch][] = [
  ["the fetch throws", async () => Promise.reject(new Error("offline"))],
  ["the response is not OK", async () => ({ ok: false, json: async () => ({}) })],
  [
    "the body is not JSON",
    async () => ({ ok: true, json: async () => Promise.reject(new SyntaxError("bad")) }),
  ],
];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sl-remote-json-"));
  file = path.join(root, "cache.json");
  clock = 10_000_000;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("createRemoteJsonCache", () => {
  it("fetches on a cold start and keeps a last-good copy on disk", async () => {
    const fetchJson = vi.fn(async () => ok({ kits: [1] }));
    expect(await make(fetchJson).get()).toEqual({ kits: [1] });
    expect(fetchJson).toHaveBeenCalledWith(URL);
    expect(disk()).toEqual({ at: clock, data: { kits: [1] } });
  });

  it("serves the memory copy inside the TTL", async () => {
    const fetchJson = vi.fn(async () => ok("a"));
    const cache = make(fetchJson);
    await cache.get();
    clock += TTL - 1;
    expect(await cache.get()).toBe("a");
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it("refetches once the TTL has passed", async () => {
    const fetchJson = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(ok("a"))
      .mockResolvedValueOnce(ok("b"));
    const cache = make(fetchJson);
    await cache.get();
    clock += TTL;
    expect(await cache.get()).toBe("b");
  });

  it("refetches inside the TTL when forced", async () => {
    const fetchJson = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(ok("a"))
      .mockResolvedValueOnce(ok("b"));
    const cache = make(fetchJson);
    await cache.get();
    expect(await cache.get(true)).toBe("b");
  });

  it("seeds from a fresh disk copy without touching the network", async () => {
    seedDisk(clock - 1_000, "from disk");
    const fetchJson = vi.fn(async () => ok("network"));
    expect(await make(fetchJson).get()).toBe("from disk");
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("ignores a disk copy it can't read", async () => {
    fs.writeFileSync(file, "{not json");
    expect(await make(async () => ok("network")).get()).toBe("network");
  });

  it.each(failures)("serves the last-good copy when %s", async (_label, fetchJson) => {
    seedDisk(clock - TTL * 2, "last good");
    expect(await make(fetchJson).get()).toBe("last good");
    expect(disk()).toEqual({ at: clock - TTL * 2, data: "last good" });
  });

  it.each(failures)(
    "returns null when nothing was ever fetched and %s",
    async (_label, fetchJson) => {
      expect(await make(fetchJson).get()).toBeNull();
    },
  );

  it("joins concurrent refreshes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchJson = vi.fn(async () => {
      await gate;
      return ok("a");
    });
    const cache = make(fetchJson);
    const both = Promise.all([cache.get(), cache.get()]);
    release();
    expect(await both).toEqual(["a", "a"]);
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
});
