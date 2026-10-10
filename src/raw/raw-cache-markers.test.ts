// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A photo the decoder can't use gets a marker beside its develop-preview cache
// entry, named for the decoder that failed. A failure counts as a strike: one
// session's strike leaves the marker tentative, which nothing honours, since a
// lack of memory can last a whole session; a strike from a second session makes
// it final. The marker follows the entry's rules: it lands only in the project
// its decode began in, and whatever drops or replaces the entry drops it too.
// Each session is a fresh load of the module; the worker's store is a map.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** The worker's store: each key and the text it holds. */
  store: new Map<string, string>(),
  /** Folder changes and writes, in the order they reached the worker. */
  sent: [] as string[],
  enabled: true,
  /** Runs while the worker reads a marker. */
  whileReading: (): void => {},
}));

vi.mock("./cache-bridge", () => ({
  setCacheDirOnWorker: (dir: FileSystemDirectoryHandle | null) => {
    h.sent.push(`folder ${dir?.name ?? "none"}`);
  },
  workerWriteCachedPreview: async (key: string) => {
    h.sent.push(`write ${key}`);
    h.store.set(key, "preview");
  },
  workerWriteMarker: async (key: string, value: string) => {
    h.sent.push(`mark ${key}`);
    h.store.set(key, value);
  },
  workerReadMarker: async (key: string) => {
    h.whileReading();
    return h.store.get(key) ?? null;
  },
  workerReadCachedPreview: async () => null,
  workerDeleteCachedPreview: async (key: string) => {
    h.store.delete(key);
  },
  workerClearRawCache: async () => h.store.clear(),
  workerCachedKeys: async () => [...h.store.keys()],
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ rawCacheEnabled: h.enabled, rawCacheMaxEdge: 3072 }),
}));

/** The cache module as a new page load (a new session) sees it, loaded at `at`
 *  on the fake clock, or a second after the last thing that happened. */
async function session(at = Date.now() + 1000) {
  vi.setSystemTime(at);
  vi.resetModules();
  return import("./raw-cache");
}

const KEY = "v6:DSC00001.ARW:52428800:0";
const OTHER = "v6:DSC00002.ARW:52428800:0";
const folder = (name: string) => ({ name }) as FileSystemDirectoryHandle;

/** One definitive failure of KEY in a new session. */
async function strikeInNewSession(marker: "unsupported" | "suspicious" = "unsupported") {
  const cache = await session();
  await cache.markDecode(KEY, marker, cache.rawCacheGeneration());
  return cache;
}

beforeEach(() => {
  h.store = new Map();
  h.sent = [];
  h.enabled = true;
  h.whileReading = () => {};
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("decodeMarkerKey", () => {
  it("names the photo's cache entry, the kind of failure and the decoder", async () => {
    const { DECODER_ID, decodeMarkerKey } = await session();
    const unsupported = decodeMarkerKey(KEY, "unsupported");
    const suspicious = decodeMarkerKey(KEY, "suspicious");

    expect(unsupported).toContain(KEY);
    expect(unsupported).toContain(DECODER_ID);
    expect(suspicious).toContain(DECODER_ID);
    expect(new Set([KEY, unsupported, suspicious]).size).toBe(3);
  });
});

describe("markDecode, one strike per session", () => {
  it("leaves the first failure tentative: no lookup or listing honours it", async () => {
    const cache = await strikeInNewSession();

    expect(await cache.hasDecodeMarker(KEY, "unsupported")).toBe(false);
    expect((await cache.cachedKeys()).has(KEY)).toBe(false);
    expect(h.store.size).toBe(1);
  });

  it("keeps it tentative when the same session fails the photo again", async () => {
    const cache = await strikeInNewSession();
    await cache.markDecode(KEY, "unsupported", cache.rawCacheGeneration());

    expect(await cache.hasDecodeMarker(KEY, "unsupported")).toBe(false);
    expect((await cache.cachedKeys()).has(KEY)).toBe(false);
  });

  it("makes it final when a second session fails the photo too", async () => {
    await strikeInNewSession();
    await strikeInNewSession();
    const later = await session();

    expect(await later.hasDecodeMarker(KEY, "unsupported")).toBe(true);
    expect((await later.cachedKeys()).has(KEY)).toBe(true);
    expect([...h.store.keys()]).toEqual([later.decodeMarkerKey(KEY, "unsupported")]);
  });

  it("counts a suspicious decode's strikes the same way", async () => {
    await strikeInNewSession("suspicious");
    const second = await strikeInNewSession("suspicious");

    expect(await second.hasDecodeMarker(KEY, "suspicious")).toBe(true);
    expect(await second.hasDecodeMarker(KEY, "unsupported")).toBe(false);
  });

  it("writes nothing more once the marker is final", async () => {
    await strikeInNewSession();
    await strikeInNewSession();
    h.sent = [];

    await strikeInNewSession();

    expect(h.sent).toEqual([]);
  });

  it("drops a strike whose decode began before the cache folder changed", async () => {
    const cache = await session();
    cache.setRawCacheDir(folder("A"));
    const begun = cache.rawCacheGeneration();
    cache.setRawCacheDir(folder("B"));

    await cache.markDecode(KEY, "unsupported", begun);

    expect(h.sent).toEqual(["folder A", "folder B"]);
    expect(h.store.size).toBe(0);
  });

  it("drops a strike when the cache folder changes while it reads the marker", async () => {
    const cache = await session();
    cache.setRawCacheDir(folder("A"));
    const begun = cache.rawCacheGeneration();
    h.whileReading = () => cache.setRawCacheDir(folder("B"));

    await cache.markDecode(KEY, "unsupported", begun);

    expect(h.store.size).toBe(0);
  });

  it("stores nothing while the develop-preview cache is off", async () => {
    h.enabled = false;

    await strikeInNewSession();

    expect(h.store.size).toBe(0);
  });
});

// Two windows open at once are two sessions, but not two separate launches: a
// strike counts towards the final marker only if it came before the striking
// session loaded.
describe("markDecode across windows open at the same time", () => {
  it("makes the marker final for a session that loaded after the first strike", async () => {
    const first = await session(1_000);
    vi.setSystemTime(2_000);
    await first.markDecode(KEY, "unsupported", first.rawCacheGeneration());
    const second = await session(3_000);
    vi.setSystemTime(4_000);
    await second.markDecode(KEY, "unsupported", second.rawCacheGeneration());

    expect(await second.hasDecodeMarker(KEY, "unsupported")).toBe(true);
  });

  it("keeps it tentative for a session that was already open at the first strike", async () => {
    const first = await session(1_000);
    const second = await session(1_500);
    vi.setSystemTime(2_000);
    await first.markDecode(KEY, "unsupported", first.rawCacheGeneration());
    vi.setSystemTime(2_500);
    await second.markDecode(KEY, "unsupported", second.rawCacheGeneration());

    expect(await second.hasDecodeMarker(KEY, "unsupported")).toBe(false);
    const relaunched = await strikeInNewSession();
    expect(await relaunched.hasDecodeMarker(KEY, "unsupported")).toBe(true);
  });

  it("keeps one session's strikes tentative even when the clock is set back", async () => {
    const cache = await session(5_000);
    vi.setSystemTime(1_000);
    await cache.markDecode(KEY, "unsupported", cache.rawCacheGeneration());
    await cache.markDecode(KEY, "unsupported", cache.rawCacheGeneration());

    expect(await cache.hasDecodeMarker(KEY, "unsupported")).toBe(false);
  });

  // Round 1 stored only the session: such a strike predates every load since.
  it("finalises a tentative marker written before strikes carried a time", async () => {
    const cache = await session();
    const tentative = cache.decodeMarkerKey(KEY, "unsupported").replace("#2:", "#1:");
    h.store.set(tentative, "an-earlier-session");

    await cache.markDecode(KEY, "unsupported", cache.rawCacheGeneration());

    expect(await cache.hasDecodeMarker(KEY, "unsupported")).toBe(true);
  });
});

describe("markers and the photo's preview", () => {
  it("drops a tentative marker once a decode is accepted and cached", async () => {
    const cache = await strikeInNewSession();

    await cache.writeCachedPreview(KEY, new Float32Array(4), 1, 1, cache.rawCacheGeneration());
    await strikeInNewSession();

    expect([...h.store.keys()]).toHaveLength(2);
    expect(await cache.hasDecodeMarker(KEY, "unsupported")).toBe(false);
  });

  it("drops the preview and every marker together", async () => {
    await strikeInNewSession();
    const cache = await strikeInNewSession();
    await cache.markDecode(KEY, "suspicious", cache.rawCacheGeneration());

    await cache.deleteCachedPreview(KEY);

    expect(h.store.size).toBe(0);
  });
});

describe("hasDecodeMarker and cachedKeys", () => {
  it("find nothing while the develop-preview cache is off", async () => {
    await strikeInNewSession();
    const cache = await strikeInNewSession();
    h.enabled = false;

    expect(await cache.hasDecodeMarker(KEY, "unsupported")).toBe(false);
    expect((await cache.cachedKeys()).size).toBe(0);
  });

  it("ignore a final marker another decoder left", async () => {
    const cache = await session();
    const final = cache.decodeMarkerKey(KEY, "unsupported");
    h.store.set(final.replace(cache.DECODER_ID, "libraw-0.21.3+1"), "an older session");

    expect(await cache.hasDecodeMarker(KEY, "unsupported")).toBe(false);
    expect((await cache.cachedKeys()).has(KEY)).toBe(false);
  });

  it("still list the previews themselves", async () => {
    h.store.set(OTHER, "preview");
    const cache = await session();

    expect([...(await cache.cachedKeys())]).toEqual([OTHER]);
  });
});
