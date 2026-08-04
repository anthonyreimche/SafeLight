// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  isNativeFS: vi.fn<() => boolean>(),
  nativeDirectoryHandle: vi.fn<(path: string) => FileSystemDirectoryHandle>(),
  nativePathOf: vi.fn<(handle: unknown) => string | null>(),
}));

vi.mock("./native-fs", () => ({
  isNativeFS: h.isNativeFS,
  nativeDirectoryHandle: h.nativeDirectoryHandle,
  nativePathOf: h.nativePathOf,
}));

import {
  addRecentProject,
  getLastProject,
  listRecentProjects,
  recentHandle,
  removeRecentProject,
  type RecentProject,
} from "./recent";

// ── In-memory IndexedDB ──────────────────────────────────────────────────────
// Node has no IndexedDB and the store's contract (keyPath dedup, upgrade-time
// store creation, event-callback ordering) is exactly what these tests are
// about, so the slice of the API recent.ts uses is modelled for real rather
// than asserted against a mock. Callbacks fire on a microtask, matching the
// real API's "assign handlers after the call returns" usage.

interface FakeRequest<T> {
  result: T | undefined;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

function fakeIndexedDB(
  opts: {
    stores?: Record<string, Record<string, unknown>>;
    failOpen?: boolean;
  } = {},
) {
  const stores = new Map<string, Map<string, unknown>>();
  const keyPaths = new Map<string, string>();
  for (const [name, records] of Object.entries(opts.stores ?? {}))
    stores.set(name, new Map(Object.entries(records)));
  // A seeded database is a pre-existing v1; an empty one has never been created.
  let version = stores.size > 0 ? 1 : 0;

  const storeOf = (name: string): Map<string, unknown> => {
    const s = stores.get(name);
    if (!s) throw new Error(`NotFoundError: no object store "${name}"`);
    return s;
  };

  function request<T>(compute: () => T): FakeRequest<T> {
    const req: FakeRequest<T> = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => {
      req.result = compute();
      req.onsuccess?.();
    });
    return req;
  }

  const objectStore = (name: string) => ({
    getAll: () => request(() => [...storeOf(name).values()]),
    get: (key: string) => request(() => storeOf(name).get(key)),
    put: (value: unknown) => {
      const keyPath = keyPaths.get(name);
      if (!keyPath) throw new Error(`DataError: store "${name}" has no key path`);
      const key = (value as Record<string, unknown>)[keyPath];
      storeOf(name).set(String(key), value);
    },
    delete: (key: string) => void storeOf(name).delete(key),
  });

  // Transactions are not scoped to a store here: recent.ts opens one per
  // operation and never relies on isolation between them.
  const transaction = () => {
    const tx: {
      error: Error | null;
      oncomplete: (() => void) | null;
      onerror: (() => void) | null;
      objectStore: (n: string) => ReturnType<typeof objectStore>;
    } = {
      error: null,
      oncomplete: null,
      onerror: null,
      objectStore,
    };
    queueMicrotask(() => tx.oncomplete?.());
    return tx;
  };

  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string, options: { keyPath: string }) => {
      keyPaths.set(name, options.keyPath);
      stores.set(name, new Map());
    },
    transaction,
    close: () => {},
  };

  return {
    open: (_name: string, wanted: number) => {
      const req: FakeRequest<typeof db> & { onupgradeneeded: (() => void) | null } = {
        result: opts.failOpen ? undefined : db,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        if (opts.failOpen) {
          req.error = new Error("InvalidStateError: database blocked");
          req.onerror?.();
          return;
        }
        if (wanted > version) {
          version = wanted;
          req.onupgradeneeded?.();
        }
        req.onsuccess?.();
      });
      return req;
    },
    records: (name: string) => stores.get(name),
  };
}

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}

const dirHandle = (name: string) =>
  ({ name, kind: "directory" }) as unknown as FileSystemDirectoryHandle;

const ids = (entries: RecentProject[]) => entries.map((e) => e.id);

function useDB(opts?: Parameters<typeof fakeIndexedDB>[0]) {
  const db = fakeIndexedDB(opts);
  vi.stubGlobal("indexedDB", db);
  return db;
}

let clock = 0;

beforeEach(() => {
  clock = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => ++clock);
  h.isNativeFS.mockReset().mockReturnValue(false);
  h.nativePathOf.mockReset().mockReturnValue(null);
  h.nativeDirectoryHandle.mockReset();
  useDB();
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("addRecentProject", () => {
  it("keys a browser folder by name and keeps its handle", async () => {
    const handle = dirHandle("Trip");
    await addRecentProject(handle, null);
    const [entry] = await listRecentProjects();
    expect(entry).toMatchObject({ id: "Trip", name: "Trip", path: null });
    expect(entry.handle).toBe(handle);
  });

  it("keys an Electron folder by absolute path and drops the handle", async () => {
    // Native handles aren't structured-cloneable; they're rebuilt from the path.
    h.nativePathOf.mockReturnValue("D:\\Photos\\Trip");
    await addRecentProject(dirHandle("Trip"), null);
    const [entry] = await listRecentProjects();
    expect(entry).toMatchObject({
      id: "D:\\Photos\\Trip",
      name: "Trip",
      path: "D:\\Photos\\Trip",
      handle: null,
    });
  });

  it("stores the cover preview", async () => {
    const cover = new Blob(["thumbnail"]);
    await addRecentProject(dirHandle("Trip"), cover);
    const [entry] = await listRecentProjects();
    expect(entry.cover).toBe(cover);
  });

  it("refreshes an existing folder in place instead of duplicating it", async () => {
    const handle = dirHandle("Trip");
    await addRecentProject(handle, null);
    const first = (await listRecentProjects())[0].openedAt;
    const cover = new Blob(["thumbnail"]);
    await addRecentProject(handle, cover);

    const all = await listRecentProjects();
    expect(all).toHaveLength(1);
    expect(all[0].openedAt).toBeGreaterThan(first);
    expect(all[0].cover).toBe(cover);
  });

  it("trims the oldest folders past the 24-entry cap", async () => {
    for (let i = 0; i < 27; i++) await addRecentProject(dirHandle(`p${i}`), null);
    const all = await listRecentProjects();
    expect(all).toHaveLength(24);
    expect(all[0].id).toBe("p26"); // newest kept
    expect(ids(all)).not.toContain("p0"); // oldest three trimmed
    expect(ids(all)).not.toContain("p2");
    expect(ids(all)).toContain("p3");
  });

  it("survives an unusable database", async () => {
    useDB({ failOpen: true });
    await expect(addRecentProject(dirHandle("Trip"), null)).resolves.toBeUndefined();
  });
});

describe("listRecentProjects", () => {
  it("returns the most recently opened first", async () => {
    await addRecentProject(dirHandle("A"), null);
    await addRecentProject(dirHandle("B"), null);
    await addRecentProject(dirHandle("C"), null);
    expect(ids(await listRecentProjects())).toEqual(["C", "B", "A"]);
  });

  it("re-opening a folder floats it back to the front", async () => {
    await addRecentProject(dirHandle("A"), null);
    await addRecentProject(dirHandle("B"), null);
    await addRecentProject(dirHandle("A"), null);
    expect(ids(await listRecentProjects())).toEqual(["A", "B"]);
  });

  it("returns nothing rather than throwing when the database fails", async () => {
    useDB({ failOpen: true });
    await expect(listRecentProjects()).resolves.toEqual([]);
  });
});

describe("removeRecentProject", () => {
  it("drops just the named entry", async () => {
    await addRecentProject(dirHandle("A"), null);
    await addRecentProject(dirHandle("B"), null);
    await removeRecentProject("A");
    expect(ids(await listRecentProjects())).toEqual(["B"]);
  });

  it("ignores an id that isn't there", async () => {
    await addRecentProject(dirHandle("A"), null);
    await removeRecentProject("gone");
    expect(ids(await listRecentProjects())).toEqual(["A"]);
  });
});

describe("recentHandle", () => {
  const entry = (over: Partial<RecentProject>): RecentProject => ({
    id: "Trip",
    name: "Trip",
    path: null,
    handle: null,
    openedAt: 1,
    cover: null,
    ...over,
  });

  it("rebuilds a native handle from the stored path", () => {
    const rebuilt = dirHandle("Trip");
    h.isNativeFS.mockReturnValue(true);
    h.nativeDirectoryHandle.mockReturnValue(rebuilt);
    expect(recentHandle(entry({ path: "D:\\Photos\\Trip" }))).toBe(rebuilt);
    expect(h.nativeDirectoryHandle).toHaveBeenCalledWith("D:\\Photos\\Trip");
  });

  it("returns the stored handle in the browser build", () => {
    const handle = dirHandle("Trip");
    expect(recentHandle(entry({ handle }))).toBe(handle);
    expect(h.nativeDirectoryHandle).not.toHaveBeenCalled();
  });

  it("is null when a path-only entry is loaded without the native bridge", () => {
    // An Electron-written entry opened in the browser build: nothing to rebuild.
    expect(recentHandle(entry({ path: "D:\\Photos\\Trip" }))).toBeNull();
  });
});

describe("getLastProject", () => {
  it("hands back the newest folder's handle", async () => {
    const first = dirHandle("A");
    const second = dirHandle("B");
    await addRecentProject(first, null);
    await addRecentProject(second, null);
    expect(await getLastProject()).toBe(second);
  });

  it("is null with nothing recorded", async () => {
    expect(await getLastProject()).toBeNull();
  });
});

describe("legacy migration", () => {
  it("seeds the grid from the old Electron last-project path", async () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({ "safelight:lastProjectPath": "D:\\Photos\\Trip" }),
    );
    const [entry] = await listRecentProjects();
    expect(entry).toMatchObject({
      id: "D:\\Photos\\Trip",
      name: "Trip",
      path: "D:\\Photos\\Trip",
      handle: null,
    });
  });

  it("consumes the legacy key so removing the entry is permanent", async () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({ "safelight:lastProjectPath": "D:\\Photos\\Trip" }),
    );
    await listRecentProjects();
    expect(localStorage.getItem("safelight:lastProjectPath")).toBeNull();

    await removeRecentProject("D:\\Photos\\Trip");
    expect(await listRecentProjects()).toEqual([]);
  });

  it("only runs while the grid is empty", async () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({ "safelight:lastProjectPath": "D:\\Photos\\Trip" }),
    );
    await addRecentProject(dirHandle("A"), null);
    expect(ids(await listRecentProjects())).toEqual(["A"]);
    expect(localStorage.getItem("safelight:lastProjectPath")).toBe("D:\\Photos\\Trip");
  });

  it("adopts the legacy browser handle and clears the old record", async () => {
    const handle = dirHandle("Trip");
    const db = useDB({
      stores: { recent: { last: { name: "Trip", handle, openedAt: 42 } } },
    });

    const [entry] = await listRecentProjects();
    expect(entry).toMatchObject({ id: "Trip", name: "Trip", path: null, openedAt: 42 });
    expect(entry.handle).toBe(handle);
    expect(db.records("recent")?.size).toBe(0);
  });

  it("prefers the Electron path over the legacy browser handle", async () => {
    const db = useDB({
      stores: { recent: { last: { name: "Trip", handle: dirHandle("Trip"), openedAt: 42 } } },
    });
    vi.stubGlobal(
      "localStorage",
      memoryStorage({ "safelight:lastProjectPath": "D:\\Photos\\Trip" }),
    );

    expect(ids(await listRecentProjects())).toEqual(["D:\\Photos\\Trip"]);
    expect(db.records("recent")?.size).toBe(1); // untouched, still available later
  });
});
