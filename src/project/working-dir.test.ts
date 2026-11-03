// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted mock state so the vi.mock factories (hoisted above imports) can
// reference it without a temporal-dead-zone error.
const h = vi.hoisted(() => ({
  settings: {
    catalogLocation: "in-folder" as "in-folder" | "external",
    externalCatalogDir: "" as string,
  },
  isNativeFS: vi.fn<() => boolean>(),
  nativeFs: vi.fn(),
  nativeDirectoryHandle: vi.fn(),
  nativePathOf: vi.fn(),
}));

vi.mock("@/state/settings-store", () => ({ getSettings: () => h.settings }));
vi.mock("./native-fs", () => ({
  isNativeFS: h.isNativeFS,
  nativeFs: h.nativeFs,
  nativeDirectoryHandle: h.nativeDirectoryHandle,
  nativePathOf: h.nativePathOf,
}));

import { resolveWorkingDir, ReadOnlyProjectError } from "./working-dir";
import { ascii, buildTiff } from "@/catalog/tiff-fixture";
import {
  CatalogTooNewError,
  CatalogUnreadableError,
  FolderAccessDeniedError,
  FolderUnavailableError,
} from "./catalog-errors";

// A .safelight handle that accepts the write-probe and the catalogue-exists check.
function writeableSl() {
  return {
    getFileHandle: vi.fn(async () => ({
      createWritable: async () => ({ write: async () => {}, close: async () => {} }),
    })),
    removeEntry: vi.fn(async () => {}),
  } as unknown as FileSystemDirectoryHandle;
}

// A .safelight handle that exists but rejects writes (the "folder went read-only
// after .safelight was already created" case the probe is there to catch).
function readOnlySl(err: Error) {
  return {
    getFileHandle: vi.fn(async () => ({
      createWritable: async () => ({
        write: async () => {},
        close: async () => {
          throw err;
        },
      }),
    })),
    removeEntry: vi.fn(async () => {}),
  } as unknown as FileSystemDirectoryHandle;
}

function rootReturning(sl: FileSystemDirectoryHandle) {
  return {
    name: "card",
    getDirectoryHandle: vi.fn(async () => sl),
  } as unknown as FileSystemDirectoryHandle;
}

function rootThrowing(err: Error) {
  return {
    name: "card",
    getDirectoryHandle: vi.fn(async () => {
      throw err;
    }),
  } as unknown as FileSystemDirectoryHandle;
}

// Build a native fs bridge mock backed by an in-memory file map, so the seed/
// promote handshake (read/write/exists/remove on absolute paths) is exercised for
// real. `inFolderCatalog` pre-seeds <root>/.safelight/catalog.json; `files` adds
// arbitrary pre-existing files; `ext` backs fs.externalCatalogDir (path, base,
// create). Writes bump a logical clock so mtime ordering is deterministic.
function nativeBridge(opts: {
  inFolderCatalog?: boolean;
  files?: Record<string, string>;
  pointers?: Record<string, string>;
  /** Files another program holds: reading them fails with EBUSY. */
  busy?: string[];
  /** The project folder isn't there (its drive was unplugged): the bridge lists it
   *  as empty, as it lists any missing folder. */
  rootGone?: boolean;
  /** What listing the project folder fails with. */
  rootListError?: Error;
  /** Where the project folder is; /card unless given. */
  mount?: string;
  ext:(p: string, base: string | null, create: boolean, variant?: number) => Promise<string | null>;
}) {
  let clock = 1;
  const mount = opts.mount ?? "/card";
  const files = new Map<string, { data: Uint8Array; mtimeMs: number }>();
  const pointers = new Map<string, string>(Object.entries(opts.pointers ?? {}));
  const put = (p: string, content: string) =>
    files.set(p, { data: new TextEncoder().encode(content), mtimeMs: clock++ });
  if (opts.inFolderCatalog) put(`${mount}/.safelight/catalog.json`, '{"v":"in-folder"}');
  for (const [p, c] of Object.entries(opts.files ?? {})) put(p, c);
  const under = (prefix: string, p: string) =>
    p === prefix || p.startsWith(prefix + "/") || p.startsWith(prefix + "\\");
  const bridge = {
    exists: vi.fn(async (p: string) => (p === mount ? !opts.rootGone : files.has(p))),
    read: vi.fn(async (p: string) => {
      if (opts.busy?.includes(p)) throw new Error(`EBUSY: resource busy or locked, open '${p}'`);
      const f = files.get(p);
      if (!f) throw new Error(`ENOENT: ${p}`);
      return { data: f.data, mtimeMs: f.mtimeMs, size: f.data.length };
    }),
    write: vi.fn(async (p: string, data: Uint8Array) =>
      void files.set(p, { data, mtimeMs: clock++ }),
    ),
    remove: vi.fn(async (p: string) => {
      for (const k of [...files.keys()]) if (under(p, k)) files.delete(k);
    }),
    list: vi.fn(async (dir: string) => {
      if (dir === mount && opts.rootListError) throw opts.rootListError;
      const kids = new Map<string, "file" | "directory">();
      for (const p of files.keys()) {
        if (!p.startsWith(`${dir}/`)) continue;
        const [name, ...deeper] = p.slice(dir.length + 1).split("/");
        kids.set(name, deeper.length > 0 ? "directory" : "file");
      }
      return [...kids].map(([name, kind]) => ({ name, kind }));
    }),
    externalCatalogDir: vi.fn(opts.ext),
    setSpilloverPointer: vi.fn(async (rp: string, dir: string) => void pointers.set(rp, dir)),
    getSpilloverPointer: vi.fn(async (rp: string) => pointers.get(rp) ?? null),
    clearSpilloverPointer: vi.fn(async (rp: string) => void pointers.delete(rp)),
    _files: files,
    _pointers: pointers,
    _text: (p: string) => {
      const f = files.get(p);
      return f ? new TextDecoder().decode(f.data) : null;
    },
  };
  h.isNativeFS.mockReturnValue(true);
  h.nativeFs.mockReturnValue(bridge);
  h.nativePathOf.mockReturnValue(mount);
  h.nativeDirectoryHandle.mockImplementation(
    (p: string) => ({ __ext: p }) as unknown as FileSystemDirectoryHandle,
  );
  return bridge;
}

/** The EXIF tag of the moment a photo was taken. */
const DATE_TIME_ORIGINAL = 0x9003;

const EROFS = () => new Error("EROFS: read-only file system, mkdir '/card/.safelight'");

/** What the copies a fold kept of the in-folder catalogue it replaced hold. Named
 *  apart from catalog.bak.json, which every session's first save rewrites. */
function keptBeforeMerge(b: ReturnType<typeof nativeBridge>): (string | null)[] {
  const name = /^\/card\/\.safelight\/catalog\.before-merge-\d{4}-\d\d-\d\dT[\d-]+Z\.json$/;
  return [...b._files.keys()].filter((path) => name.test(path)).map((path) => b._text(path));
}

beforeEach(() => {
  h.settings.catalogLocation = "in-folder";
  h.settings.externalCatalogDir = "";
  h.isNativeFS.mockReset();
  h.nativeFs.mockReset();
  h.nativeDirectoryHandle.mockReset();
  h.nativePathOf.mockReset();
});

describe("resolveWorkingDir", () => {
  it("uses the in-folder .safelight when it's writeable", async () => {
    const sl = writeableSl();
    const wd = await resolveWorkingDir(rootReturning(sl));
    expect(wd.location).toBe("in-folder");
    expect(wd.externalPath).toBeNull();
    expect(wd.sl).toBe(sl);
  });

  it("redirects to a separate dir when creating .safelight fails (read-only card)", async () => {
    const ext = nativeBridge({
      inFolderCatalog: false,
      ext: async (_p, _b, create) => (create ? "/data/card-abc/.safelight" : null),
    }).externalCatalogDir;

    const wd = await resolveWorkingDir(rootThrowing(EROFS()));

    expect(wd.location).toBe("external");
    expect(wd.externalPath).toBe("/data/card-abc/.safelight");
    expect(ext).toHaveBeenCalledWith("/card", null, true);
  });

  it("passes the user-configured base directory to the bridge", async () => {
    h.settings.externalCatalogDir = "/scratch/safelight";
    const ext = nativeBridge({
      inFolderCatalog: false,
      ext: async (_p, _b, create) => (create ? "/scratch/safelight/card-abc/.safelight" : null),
    }).externalCatalogDir;

    await resolveWorkingDir(rootThrowing(EROFS()));

    expect(ext).toHaveBeenCalledWith("/card", "/scratch/safelight", true);
  });

  it("STICKY: keeps using an existing separate catalogue even when the folder is now writeable", async () => {
    // The Q1 regression: a card was read-only (so a separate catalogue was built),
    // then becomes writeable. We must NOT spawn a fresh in-folder .safelight and
    // orphan the catalogue — the existing separate one wins.
    const ext = nativeBridge({
      inFolderCatalog: false,
      ext: async (_p, _b, create) => (create ? null : "/data/card-abc/.safelight"),
    }).externalCatalogDir;
    const root = rootReturning(writeableSl()); // folder IS writeable now

    const wd = await resolveWorkingDir(root);

    expect(wd.location).toBe("external");
    expect(wd.externalPath).toBe("/data/card-abc/.safelight");
    expect(ext).toHaveBeenCalledWith("/card", null, false);
    expect(ext).not.toHaveBeenCalledWith("/card", null, true); // never created in-folder
    expect(root.getDirectoryHandle).not.toHaveBeenCalled();
  });

  it("EXTERNAL mode: stores the catalogue separately even for a writeable folder", async () => {
    h.settings.catalogLocation = "external";
    const ext = nativeBridge({
      inFolderCatalog: false,
      ext: async (_p, _b, create) => (create ? "/ssd/card-abc/.safelight" : null),
    }).externalCatalogDir;
    const root = rootReturning(writeableSl());

    const wd = await resolveWorkingDir(root);

    expect(wd.location).toBe("external");
    expect(wd.externalPath).toBe("/ssd/card-abc/.safelight");
    expect(ext).toHaveBeenCalledWith("/card", null, true);
    expect(root.getDirectoryHandle).not.toHaveBeenCalled();
  });

  it("EXTERNAL mode fails loudly if the separate location can't be established", async () => {
    // The bridge resolves falsy (can't give a location) rather than throwing. We
    // must NOT silently fall through to an in-folder write — the user chose external.
    h.settings.catalogLocation = "external";
    const ext = nativeBridge({
      inFolderCatalog: false,
      ext: async () => null,
    }).externalCatalogDir;
    const root = rootReturning(writeableSl());

    const err = await resolveWorkingDir(root).catch((e) => e);

    expect(err).toBeInstanceOf(ReadOnlyProjectError);
    expect(err.redirectFailed).toBe(true);
    expect(ext).toHaveBeenCalledWith("/card", null, true);
    expect(root.getDirectoryHandle).not.toHaveBeenCalled(); // no in-folder write
  });

  it("EXTERNAL mode never orphans an existing in-folder catalogue (canonical wins)", async () => {
    // Flipping the global setting to "external" must not abandon catalogues the
    // user already built in their folders — rule 1 (in-folder canonical) beats
    // rule 2 (external mode). The separate location is never touched here.
    h.settings.catalogLocation = "external";
    const sl = writeableSl();
    const ext = nativeBridge({
      inFolderCatalog: true, // folder already owns <project>/.safelight/catalog.json
      ext: async () => "/ssd/should-not-be-used/.safelight",
    }).externalCatalogDir;

    const wd = await resolveWorkingDir(rootReturning(sl));

    expect(wd.location).toBe("in-folder");
    expect(wd.sl).toBe(sl);
    // A separate catalogue is never *created* (it may be probed read-only to look
    // for a spillover to promote, but never built/used here).
    expect(ext).not.toHaveBeenCalledWith("/card", null, true);
  });

  it("uses the in-folder catalogue when it already exists (canonical), not a redirect", async () => {
    const sl = writeableSl();
    nativeBridge({
      inFolderCatalog: true, // <project>/.safelight/catalog.json exists
      ext: async () => "/data/should-not-be-used/.safelight",
    });
    const wd = await resolveWorkingDir(rootReturning(sl));
    expect(wd.location).toBe("in-folder");
    expect(wd.sl).toBe(sl);
  });

  it("falls back to a separate dir when the in-folder catalogue exists but the folder is read-only", async () => {
    const ext = nativeBridge({
      inFolderCatalog: true,
      ext: async (_p, _b, create) => (create ? "/data/card-abc/.safelight" : null),
    }).externalCatalogDir;
    const wd = await resolveWorkingDir(rootReturning(readOnlySl(EROFS())));
    expect(wd.location).toBe("external");
    expect(ext).toHaveBeenCalledWith("/card", null, true);
  });

  it("throws ReadOnlyProjectError (no redirect) when not native", async () => {
    h.isNativeFS.mockReturnValue(false);
    h.nativeFs.mockReturnValue(null);
    h.nativePathOf.mockReturnValue(null);

    await expect(resolveWorkingDir(rootThrowing(EROFS()))).rejects.toMatchObject({
      name: "ReadOnlyProjectError",
      redirectFailed: false,
    });
  });

  it("throws ReadOnlyProjectError (redirectFailed) when the redirect itself fails", async () => {
    const cause = new Error("EROFS: read-only file system, mkdir '/scratch'");
    h.settings.externalCatalogDir = "/scratch";
    nativeBridge({
      inFolderCatalog: false,
      ext: async (_p, _b, create) => {
        if (create) throw cause;
        return null;
      },
    });

    const err = await resolveWorkingDir(rootThrowing(EROFS())).catch((e) => e);
    expect(err).toBeInstanceOf(ReadOnlyProjectError);
    expect(err.redirectFailed).toBe(true);
    expect(err.cause).toBe(cause);
  });

  it("SEED: a read-only open seeds the separate catalogue from the in-folder one", async () => {
    // The folder owns a catalogue but is mounted read-only. The separate catalogue we
    // redirect to must open onto the user's real data, not an empty catalogue.
    const b = nativeBridge({
      inFolderCatalog: true,
      ext: async (_p, _b, create) => (create ? "/data/card-abc/.safelight" : null),
    });

    const wd = await resolveWorkingDir(rootReturning(readOnlySl(EROFS())));

    expect(wd.location).toBe("external");
    // in-folder catalog.json copied into the separate location + spillover marker.
    expect(b._text("/data/card-abc/.safelight/catalog.json")).toBe('{"v":"in-folder"}');
    expect(b._files.has("/data/card-abc/.safelight/.seeded")).toBe(true);
    // pointer recorded so a later writeable open finds it regardless of the base.
    expect(b._pointers.get("/card")).toBe("/data/card-abc/.safelight");
  });

  it("fails a read-only open rather than seed over a separate catalogue it can't read", async () => {
    // Read as missing, the separate catalogue, the only copy of the read-only
    // session's edits, was replaced by the older in-folder one.
    const b = nativeBridge({
      inFolderCatalog: true,
      files: { "/data/card-abc/.safelight/catalog.json": '{"v":"read-only-edits"}' },
      busy: ["/data/card-abc/.safelight/catalog.json"],
      ext: async (_p, _b, create) => (create ? "/data/card-abc/.safelight" : null),
    });

    await expect(resolveWorkingDir(rootReturning(readOnlySl(EROFS())))).rejects.toThrow(
      CatalogUnreadableError,
    );

    expect(b._text("/data/card-abc/.safelight/catalog.json")).toBe('{"v":"read-only-edits"}');
  });

  it("fails a read-only open, not start empty, when the folder's catalogue is busy", async () => {
    // Read as missing, nothing was seeded or marked, so the session's edits would
    // never fold back.
    const b = nativeBridge({
      inFolderCatalog: true,
      busy: ["/card/.safelight/catalog.json"],
      ext: async (_p, _b, create) => (create ? "/data/card-abc/.safelight" : null),
    });

    await expect(resolveWorkingDir(rootReturning(readOnlySl(EROFS())))).rejects.toThrow(
      CatalogUnreadableError,
    );

    expect(b._files.has("/data/card-abc/.safelight/catalog.json")).toBe(false);
  });

  it("PROMOTE: a writeable open folds a seeded separate catalogue back in-folder", async () => {
    // The card is writeable again; edits made while read-only (in the seeded
    // separate) must be merged back, with the prior in-folder catalogue backed up.
    const b = nativeBridge({
      inFolderCatalog: true,
      files: {
        "/data/card-abc/.safelight/catalog.json": '{"v":"read-only-edits"}',
        "/data/card-abc/.safelight/.seeded": "/card",
      },
      ext: async () => "/data/card-abc/.safelight",
    });

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.location).toBe("in-folder");
    expect(wd.promotedFromExternal).toBe("/data/card-abc/.safelight");
    expect(b._text("/card/.safelight/catalog.json")).toBe('{"v":"read-only-edits"}');
    expect(keptBeforeMerge(b)).toEqual(['{"v":"in-folder"}']);
    expect(b._files.has("/card/.safelight/catalog.bak.json")).toBe(false); // the session backup's
    expect(b._files.has("/data/card-abc/.safelight/.seeded")).toBe(false); // consumed
    expect(b._files.has("/data/card-abc/.safelight/catalog.json")).toBe(false); // spillover retired
  });

  it("keeps only the newest copies of the catalogues earlier folds replaced", async () => {
    const stamp = (n: number) => `2026-01-0${n}T00-00-00-000Z`;
    const old = Object.fromEntries(
      [1, 2, 3].map((n) => [`/card/.safelight/catalog.before-merge-${stamp(n)}.json`, `fold ${n}`]),
    );
    const b = nativeBridge({
      inFolderCatalog: true,
      files: {
        ...old,
        "/card/.safelight/catalog.json.note": "not a copy",
        "/data/card-abc/.safelight/catalog.json": '{"v":"read-only-edits"}',
        "/data/card-abc/.safelight/.seeded": "/card",
      },
      ext: async () => "/data/card-abc/.safelight",
    });

    await resolveWorkingDir(rootReturning(writeableSl()));

    expect(b._files.has(`/card/.safelight/catalog.before-merge-${stamp(1)}.json`)).toBe(false);
    expect(keptBeforeMerge(b).sort()).toEqual(['{"v":"in-folder"}', "fold 2", "fold 3"].sort());
    expect(b._text("/card/.safelight/catalog.json.note")).toBe("not a copy");
  });

  it("still folds when the old copies can't be listed", async () => {
    const b = nativeBridge({
      inFolderCatalog: true,
      files: {
        "/data/card-abc/.safelight/catalog.json": '{"v":"read-only-edits"}',
        "/data/card-abc/.safelight/.seeded": "/card",
      },
      ext: async () => "/data/card-abc/.safelight",
    });
    b.list.mockImplementation(async (dir: string) => {
      if (dir === "/card") return [{ name: ".safelight", kind: "directory" }];
      throw new Error("EPERM");
    });

    await resolveWorkingDir(rootReturning(writeableSl()));

    expect(b._text("/card/.safelight/catalog.json")).toBe('{"v":"read-only-edits"}');
  });

  it("changes nothing, and stops the open, when a newer version saved the spillover", async () => {
    const newer = '{"version":2,"photos":[],"edits":[]}';
    const b = nativeBridge({
      inFolderCatalog: true,
      files: {
        "/data/card-abc/.safelight/catalog.json": newer,
        "/data/card-abc/.safelight/.seeded": "/card",
      },
      ext: async () => "/data/card-abc/.safelight",
    });

    await expect(resolveWorkingDir(rootReturning(writeableSl()))).rejects.toBeInstanceOf(
      CatalogTooNewError,
    );

    expect(b._text("/card/.safelight/catalog.json")).toBe('{"v":"in-folder"}');
    expect(keptBeforeMerge(b)).toEqual([]);
    expect(b._text("/data/card-abc/.safelight/catalog.json")).toBe(newer);
    expect(b._files.has("/data/card-abc/.safelight/.seeded")).toBe(true);
  });

  it("keeps the folder's catalogue, and the damaged spillover beside it, when the spillover is damaged", async () => {
    const b = nativeBridge({
      inFolderCatalog: true,
      files: {
        "/data/card-abc/.safelight/catalog.json": '{"version":1,"photos":[{"id"',
        "/data/card-abc/.safelight/.seeded": "/card",
      },
      ext: async () => "/data/card-abc/.safelight",
    });

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.promotedFromExternal ?? null).toBeNull();
    expect(b._text("/card/.safelight/catalog.json")).toBe('{"v":"in-folder"}');
    expect(b._text("/data/card-abc/.safelight/catalog.json")).toBe('{"version":1,"photos":[{"id"');
    expect(b._files.has("/data/card-abc/.safelight/.seeded")).toBe(false);
  });

  it("does NOT fold a STALE spillover over newer in-folder edits (leftover/stuck marker)", async () => {
    // A marker that survived a failed cleanup, after which the user did more
    // writeable work: the spillover is now older than the in-folder catalogue. The
    // guard must make this a no-op — never clobber the newer in-folder data.
    const b = nativeBridge({
      files: {
        "/data/card-abc/.safelight/catalog.json": '{"v":"stale"}', // oldest
        "/data/card-abc/.safelight/.seeded": "/card",
        "/card/.safelight/catalog.json": '{"v":"newer-in-folder"}', // newest
      },
      ext: async () => "/data/card-abc/.safelight",
    });

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.location).toBe("in-folder");
    expect(wd.promotedFromExternal ?? null).toBeNull(); // no fold
    expect(b._text("/card/.safelight/catalog.json")).toBe('{"v":"newer-in-folder"}'); // untouched
    expect(keptBeforeMerge(b)).toEqual([]); // no backup clobber
    expect(b._files.has("/data/card-abc/.safelight/.seeded")).toBe(false); // spent marker consumed
  });

  it("does NOT fold (or notify) when the spillover is identical (read-only browse, no edits)", async () => {
    // Seeded marker present but the separate matches the in-folder catalogue byte for
    // byte (a read-only spell with no edits). Folding would write a redundant backup
    // and show a false "edits merged" notice — the content guard prevents both.
    const b = nativeBridge({
      files: {
        "/card/.safelight/catalog.json": '{"v":"same"}',
        "/data/card-abc/.safelight/catalog.json": '{"v":"same"}', // newer but identical
        "/data/card-abc/.safelight/.seeded": "/card",
      },
      ext: async () => "/data/card-abc/.safelight",
    });

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.location).toBe("in-folder");
    expect(wd.promotedFromExternal ?? null).toBeNull(); // identical → no fold, no notice
    expect(keptBeforeMerge(b)).toEqual([]); // no redundant backup
    expect(b._files.has("/data/card-abc/.safelight/.seeded")).toBe(false); // marker consumed
  });

  it("PROMOTE finds a spillover under the default base even after the base setting changed", async () => {
    // User redirected with the default base, then changed "Separate catalogue
    // location"; the writeable re-open must still find and fold the old spillover.
    h.settings.externalCatalogDir = "/ssd/cats";
    const b = nativeBridge({
      files: {
        "/card/.safelight/catalog.json": '{"v":"in-folder"}',
        "/data/card-abc/.safelight/catalog.json": '{"v":"ro-edits"}', // under the DEFAULT base
        "/data/card-abc/.safelight/.seeded": "/card",
      },
      ext: async (_p, b2) =>
        b2 === null ? "/data/card-abc/.safelight" : "/ssd/cats/card-abc/.safelight",
    });

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.location).toBe("in-folder");
    expect(wd.promotedFromExternal).toBe("/data/card-abc/.safelight");
    expect(b._text("/card/.safelight/catalog.json")).toBe('{"v":"ro-edits"}');
  });

  it("REGISTRY: a custom→custom base change still merges via the recorded spillover pointer", async () => {
    // Spillover seeded under custom base X (pointer recorded under app-data); the
    // setting later points at a different custom base Y. The base probe alone can't
    // find X, but the pointer locates it, so the read-only edits still fold back.
    h.settings.externalCatalogDir = "/baseY";
    const b = nativeBridge({
      files: {
        "/card/.safelight/catalog.json": '{"v":"in-folder"}',
        "/baseX/card-abc/.safelight/catalog.json": '{"v":"ro-edits"}',
        "/baseX/card-abc/.safelight/.seeded": "/card",
      },
      pointers: { "/card": "/baseX/card-abc/.safelight" }, // recorded at seed time
      // Neither the current base Y nor the default holds the spillover.
      ext: async (_p, b2) =>
        b2 === "/baseY" ? "/baseY/card-abc/.safelight" : "/data/default/.safelight",
    });

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.location).toBe("in-folder");
    expect(wd.promotedFromExternal).toBe("/baseX/card-abc/.safelight"); // found via pointer
    expect(b._text("/card/.safelight/catalog.json")).toBe('{"v":"ro-edits"}'); // merged back
    expect(keptBeforeMerge(b)).toEqual(['{"v":"in-folder"}']);
    expect(b._files.has("/card/.safelight/catalog.bak.json")).toBe(false); // the session backup's
    expect(b._files.has("/baseX/card-abc/.safelight/.seeded")).toBe(false); // spillover retired
    expect(b._pointers.has("/card")).toBe(false); // pointer cleared after fold
  });

  it("clears a stale spillover pointer that no longer has a marker (no fold, no clobber)", async () => {
    // Pointer survives but the spillover's marker is gone (already consumed): the
    // pointer probe misses (no marker), the base probe finds nothing, so it's a
    // clean no-op and the dangling pointer is left for the next seed to overwrite.
    const b = nativeBridge({
      inFolderCatalog: true,
      pointers: { "/card": "/gone/card-abc/.safelight" }, // points at a marker-less dir
      ext: async () => null,
    });

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.location).toBe("in-folder");
    expect(wd.promotedFromExternal ?? null).toBeNull();
    expect(b._text("/card/.safelight/catalog.json")).toBe('{"v":"in-folder"}'); // untouched
  });

  it("does NOT promote a separate catalogue that isn't a seeded spillover", async () => {
    // A standalone external-mode catalogue (no .seeded marker) must never be folded
    // onto an in-folder one — that would clobber the in-folder catalogue.
    const b = nativeBridge({
      inFolderCatalog: true,
      files: { "/data/ext/.safelight/catalog.json": '{"v":"external-mode"}' },
      ext: async () => "/data/ext/.safelight",
    });

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.location).toBe("in-folder");
    expect(wd.promotedFromExternal ?? null).toBeNull();
    expect(b._text("/card/.safelight/catalog.json")).toBe('{"v":"in-folder"}'); // untouched
    expect(keptBeforeMerge(b)).toEqual([]); // no backup written
  });

  it("fails the open rather than fold over an in-folder catalogue it can't read", async () => {
    // Read as missing, the in-folder catalogue was replaced by the spillover with no backup.
    const b = nativeBridge({
      inFolderCatalog: true,
      files: {
        "/data/card-abc/.safelight/catalog.json": '{"v":"read-only-edits"}',
        "/data/card-abc/.safelight/.seeded": "/card",
      },
      busy: ["/card/.safelight/catalog.json"],
      ext: async () => "/data/card-abc/.safelight",
    });

    await expect(resolveWorkingDir(rootReturning(writeableSl()))).rejects.toThrow(
      CatalogUnreadableError,
    );

    expect(b._text("/card/.safelight/catalog.json")).toBe('{"v":"in-folder"}');
    expect(keptBeforeMerge(b)).toEqual([]);
    expect(b._files.has("/data/card-abc/.safelight/.seeded")).toBe(true); // still to fold
  });

  it("fails the open rather than retire a spillover it can't read", async () => {
    // Read as missing, the spillover's marker was consumed and its edits never folded back.
    const b = nativeBridge({
      inFolderCatalog: true,
      files: {
        "/data/card-abc/.safelight/catalog.json": '{"v":"read-only-edits"}',
        "/data/card-abc/.safelight/.seeded": "/card",
      },
      busy: ["/data/card-abc/.safelight/catalog.json"],
      ext: async () => "/data/card-abc/.safelight",
    });

    await expect(resolveWorkingDir(rootReturning(writeableSl()))).rejects.toThrow(
      CatalogUnreadableError,
    );

    expect(b._text("/card/.safelight/catalog.json")).toBe('{"v":"in-folder"}');
    expect(b._files.has("/data/card-abc/.safelight/.seeded")).toBe(true); // still to fold
  });

  it("rethrows a non-read-only failure unchanged (not classified as read-only)", async () => {
    const enospc = new Error("ENOSPC: no space left on device");
    await expect(resolveWorkingDir(rootThrowing(enospc))).rejects.toBe(enospc);
  });

  it("rethrows a non-read-only failure from the in-folder-catalogue path (step 1), no redirect", async () => {
    // In-folder catalogue exists (so we enter step 1) but the write probe fails
    // with ENOSPC — a real problem, not read-only. It must surface as-is, never
    // be reclassified into a redirect.
    const enospc = new Error("ENOSPC: no space left on device");
    const ext = nativeBridge({
      inFolderCatalog: true,
      ext: async () => "/data/should-not-be-used/.safelight",
    }).externalCatalogDir;

    await expect(
      resolveWorkingDir(rootReturning(readOnlySl(enospc))),
    ).rejects.toBe(enospc);
    // No redirect attempted: the separate location is never *created* (a read-only
    // promote-probe is harmless and doesn't count).
    expect(ext).not.toHaveBeenCalledWith("/card", null, true);
  });
});

describe("resolveWorkingDir with a project folder that isn't there", () => {
  const SAVED = '{"v":"spillover"}';

  it("stops before a seeded spillover is touched, leaving it and its marker as they are", async () => {
    const b = nativeBridge({
      rootGone: true,
      files: { [`${SPILL}/catalog.json`]: SAVED, ...SEEDED },
      ext: async () => SPILL,
    });
    const before = new Map(b._files);

    await expect(resolveWorkingDir(rootReturning(writeableSl()))).rejects.toBeInstanceOf(
      FolderUnavailableError,
    );

    expect(b.externalCatalogDir).not.toHaveBeenCalled();
    expect(b._files).toEqual(before);
    expect(b._text(`${SPILL}/catalog.json`)).toBe(SAVED);
    expect(b._text(`${SPILL}/.seeded`)).toBe("/card");
  });

  it("stops before an external-mode catalogue is opened", async () => {
    h.settings.catalogLocation = "external";
    const b = nativeBridge({
      rootGone: true,
      files: { [`${SPILL}/catalog.json`]: SAVED },
      ext: async () => SPILL,
    });

    await expect(resolveWorkingDir(rootReturning(writeableSl()))).rejects.toBeInstanceOf(
      FolderUnavailableError,
    );

    expect(b.externalCatalogDir).not.toHaveBeenCalled();
    expect(b._text(`${SPILL}/catalog.json`)).toBe(SAVED);
  });

  it("stops as a folder that can't be reached, and creates no catalogue anywhere", async () => {
    const b = nativeBridge({ rootGone: true, ext: async () => SPILL });
    const root = rootReturning(writeableSl());

    const error = await resolveWorkingDir(root).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FolderUnavailableError);
    expect((error as FolderUnavailableError).reason).toBe("ENOENT");
    expect(root.getDirectoryHandle).not.toHaveBeenCalled();
    expect(b.externalCatalogDir).not.toHaveBeenCalled();
    expect(b.write).not.toHaveBeenCalled();
  });

  it.each(["ENODEV", "EIO", "ENOTCONN", "ESTALE"])(
    "stops the same way when listing the folder fails with %s",
    async (errno) => {
      const b = nativeBridge({
        rootListError: new Error(`${errno}: gone, scandir '/card'`),
        ext: async () => SPILL,
      });

      await expect(resolveWorkingDir(rootReturning(writeableSl()))).rejects.toBeInstanceOf(
        FolderUnavailableError,
      );
      expect(b.externalCatalogDir).not.toHaveBeenCalled();
    },
  );
});

describe("resolveWorkingDir on macOS with the folder's volume not allowed", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stops as a folder macOS keeps Safelight out of, and creates no separate catalogue", async () => {
    vi.stubGlobal("window", { safelightNative: { platform: "darwin" } });
    const denied = () => new Error("EPERM: operation not permitted, scandir '/card'");
    const b = nativeBridge({ rootListError: denied(), ext: async () => SPILL });
    const root = rootThrowing(new Error("EPERM: operation not permitted, mkdir '/card/.safelight'"));

    const error = await resolveWorkingDir(root).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FolderAccessDeniedError);
    expect((error as FolderAccessDeniedError).reason).toBe("EPERM");
    expect(b.externalCatalogDir).not.toHaveBeenCalledWith("/card", null, true);
    expect(root.getDirectoryHandle).not.toHaveBeenCalled();
  });
});

const SPILL = "/data/card-abc/.safelight";
const SEEDED = { [`${SPILL}/.seeded`]: "/card" };
const editFile = (photoId: string, stamp?: [number, string], label = "edit") =>
  JSON.stringify({
    format: 1,
    photoId,
    ...(stamp ? { stamp } : {}),
    stack: [{ timestamp: 1, label, params: {} }],
    currentIndex: 0,
  });
const keptEdits = (b: ReturnType<typeof nativeBridge>): string[] =>
  [...b._files.keys()].filter((path) =>
    /^\/card\/\.safelight\/before-merge-[^/]+\/edits\//.test(path),
  );
const spilloverEdits = (b: ReturnType<typeof nativeBridge>): string[] =>
  [...b._files.keys()].filter((path) => path.startsWith(`${SPILL}/edits/`));

describe("resolveWorkingDir with per-photo edit files", () => {
  it("hands a read-only session the in-folder .safelight to read edits from", async () => {
    nativeBridge({
      inFolderCatalog: true,
      ext: async (_p, _b, create) => (create ? SPILL : null),
    });

    const wd = await resolveWorkingDir(rootReturning(readOnlySl(EROFS())));

    expect(wd.location).toBe("external");
    expect(wd.editsFallback?.path).toBe("/card/.safelight");
    expect(wd.editsFallback?.sl).toEqual({ __ext: "/card/.safelight" });
  });

  it("has no edits fallback when the working dir is the in-folder one", async () => {
    nativeBridge({ inFolderCatalog: true, ext: async () => null });
    const wd = await resolveWorkingDir(rootReturning(writeableSl()));
    expect(wd.editsFallback).toBeUndefined();
  });

  it("has no edits fallback for a separate catalogue with no in-folder one", async () => {
    nativeBridge({ inFolderCatalog: false, ext: async (_p, _b, create) => (create ? null : SPILL) });
    const wd = await resolveWorkingDir(rootReturning(writeableSl()));
    expect(wd.location).toBe("external");
    expect(wd.editsFallback).toBeUndefined();
  });

  it("folds a spillover that holds only edit files, its catalog.json identical", async () => {
    const b = nativeBridge({
      files: {
        "/card/.safelight/catalog.json": '{"v":"same"}',
        [`${SPILL}/catalog.json`]: '{"v":"same"}',
        [`${SPILL}/edits/ab/p1.json`]: editFile("p1", [5, "w"], "read-only"),
        ...SEEDED,
      },
      ext: async () => SPILL,
    });

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.promotedFromExternal).toBe(SPILL);
    expect(b._text("/card/.safelight/edits/ab/p1.json")).toBe(editFile("p1", [5, "w"], "read-only"));
    expect(b._text("/card/.safelight/catalog.json")).toBe('{"v":"same"}');
    expect(keptBeforeMerge(b)).toEqual([]);
    expect(keptEdits(b)).toEqual([]); // nothing was replaced
    expect(spilloverEdits(b)).toEqual([]);
    expect(b._files.has(`${SPILL}/.seeded`)).toBe(false);
    expect(b._pointers.has("/card")).toBe(false);
  });

  it("keeps an in-folder edit whose stamp is newer than the spillover's", async () => {
    const mine = editFile("p1", [9, "a"], "in-folder");
    const b = nativeBridge({
      files: {
        "/card/.safelight/catalog.json": '{"v":"same"}',
        "/card/.safelight/edits/ab/p1.json": mine,
        [`${SPILL}/catalog.json`]: '{"v":"same"}',
        [`${SPILL}/edits/ab/p1.json`]: editFile("p1", [5, "z"], "older"),
        ...SEEDED,
      },
      ext: async () => SPILL,
    });

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(b._text("/card/.safelight/edits/ab/p1.json")).toBe(mine);
    expect(keptEdits(b)).toEqual([]);
    expect(wd.promotedFromExternal ?? null).toBeNull(); // nothing taken, nothing to tell
    expect(spilloverEdits(b)).toEqual([]);
  });

  it("takes the spillover edit when its stamp is newer, keeping the file it replaced", async () => {
    const replaced = editFile("p1", [3, "a"], "in-folder");
    const taken = editFile("p1", [4, "a"], "spillover");
    const b = nativeBridge({
      files: {
        "/card/.safelight/catalog.json": '{"v":"same"}',
        "/card/.safelight/edits/ab/p1.json": replaced,
        "/card/.safelight/edits/ab/p2.json": editFile("p2", [1, "a"]),
        [`${SPILL}/catalog.json`]: '{"v":"same"}',
        [`${SPILL}/edits/ab/p1.json`]: taken,
        ...SEEDED,
      },
      ext: async () => SPILL,
    });

    await resolveWorkingDir(rootReturning(writeableSl()));

    expect(b._text("/card/.safelight/edits/ab/p1.json")).toBe(taken);
    const kept = keptEdits(b);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/\/before-merge-\d{4}-\d\d-\d\dT[\d-]+Z\/edits\/ab\/p1\.json$/);
    expect(b._text(kept[0])).toBe(replaced);
  });

  it("breaks a tie on the origin in the stamp, as the change stamps do", async () => {
    const b = nativeBridge({
      files: {
        "/card/.safelight/catalog.json": '{"v":"same"}',
        "/card/.safelight/edits/ab/p1.json": editFile("p1", [4, "a"], "in-folder"),
        [`${SPILL}/catalog.json`]: '{"v":"same"}',
        [`${SPILL}/edits/ab/p1.json`]: editFile("p1", [4, "b"], "spillover"),
        ...SEEDED,
      },
      ext: async () => SPILL,
    });

    await resolveWorkingDir(rootReturning(writeableSl()));

    expect(b._text("/card/.safelight/edits/ab/p1.json")).toBe(editFile("p1", [4, "b"], "spillover"));
  });

  it("counts an unstamped edit as older than a stamped one but newer than none", async () => {
    const stamped = editFile("p1", [1, "a"], "stamped");
    const unstamped = editFile("p2", undefined, "unstamped");
    const b = nativeBridge({
      files: {
        "/card/.safelight/catalog.json": '{"v":"same"}',
        "/card/.safelight/edits/ab/p1.json": stamped,
        [`${SPILL}/catalog.json`]: '{"v":"same"}',
        [`${SPILL}/edits/ab/p1.json`]: editFile("p1", undefined, "unstamped"),
        [`${SPILL}/edits/cd/p2.json`]: unstamped,
        ...SEEDED,
      },
      ext: async () => SPILL,
    });

    await resolveWorkingDir(rootReturning(writeableSl()));

    expect(b._text("/card/.safelight/edits/ab/p1.json")).toBe(stamped);
    expect(b._text("/card/.safelight/edits/cd/p2.json")).toBe(unstamped);
    expect(keptEdits(b)).toEqual([]);
  });

  it("never replaces a readable edit with a spillover file that isn't one", async () => {
    const mine = editFile("p1", [1, "a"]);
    const b = nativeBridge({
      files: {
        "/card/.safelight/catalog.json": '{"v":"same"}',
        "/card/.safelight/edits/ab/p1.json": mine,
        [`${SPILL}/catalog.json`]: '{"v":"same"}',
        [`${SPILL}/edits/ab/p1.json`]: '{"format":1,"photoId"',
        ...SEEDED,
      },
      ext: async () => SPILL,
    });

    await resolveWorkingDir(rootReturning(writeableSl()));

    expect(b._text("/card/.safelight/edits/ab/p1.json")).toBe(mine);
  });

  it("folds only the edit files, not the backups and kept-aside copies beside them", async () => {
    const mineBak = editFile("p1", [1, "a"], "in-folder backup");
    const b = nativeBridge({
      files: {
        "/card/.safelight/catalog.json": '{"v":"same"}',
        "/card/.safelight/edits/ab/p1.bak.json": mineBak,
        [`${SPILL}/catalog.json`]: '{"v":"same"}',
        [`${SPILL}/edits/ab/p1.json`]: editFile("p1", [5, "w"]),
        [`${SPILL}/edits/ab/p1.bak.json`]: editFile("p1", [9, "w"], "spillover backup"),
        [`${SPILL}/edits/ab/p1.corrupt-2026-01-01T00-00-00-000Z.json`]: "{",
        [`${SPILL}/edits/ab/p1.conflict-2026-01-01T00-00-00-000Z.json`]: editFile("p1", [2, "w"]),
        [`${SPILL}/edits/notes.json`]: "{}",
        ...SEEDED,
      },
      ext: async () => SPILL,
    });

    await resolveWorkingDir(rootReturning(writeableSl()));

    expect(b._files.has("/card/.safelight/edits/ab/p1.json")).toBe(true);
    expect(b._text("/card/.safelight/edits/ab/p1.bak.json")).toBe(mineBak);
    const inFolder = [...b._files.keys()].filter((p) => p.startsWith("/card/.safelight/edits/"));
    expect(inFolder.sort()).toEqual([
      "/card/.safelight/edits/ab/p1.bak.json",
      "/card/.safelight/edits/ab/p1.json",
    ]);
    expect(keptEdits(b)).toEqual([]);
  });

  it("writes the edits first and catalog.json last, then retires the spillover edits", async () => {
    const b = nativeBridge({
      inFolderCatalog: true,
      files: {
        [`${SPILL}/catalog.json`]: '{"v":"read-only-edits"}',
        [`${SPILL}/edits/ab/p1.json`]: editFile("p1", [5, "w"]),
        ...SEEDED,
      },
      ext: async () => SPILL,
    });

    await resolveWorkingDir(rootReturning(writeableSl()));

    const written = b.write.mock.calls.map(([path]) => path);
    expect(written).toContain("/card/.safelight/edits/ab/p1.json");
    expect(written.at(-1)).toBe("/card/.safelight/catalog.json");
    expect(b._text("/card/.safelight/catalog.json")).toBe('{"v":"read-only-edits"}');
    expect(keptBeforeMerge(b)).toEqual(['{"v":"in-folder"}']);
    expect(spilloverEdits(b)).toEqual([]);
  });

  it("writes nothing in-folder when a newer version saved the spillover catalogue", async () => {
    const b = nativeBridge({
      inFolderCatalog: true,
      files: {
        [`${SPILL}/catalog.json`]: '{"version":99,"photos":[]}',
        [`${SPILL}/edits/ab/p1.json`]: editFile("p1", [5, "w"]),
        ...SEEDED,
      },
      ext: async () => SPILL,
    });

    await expect(resolveWorkingDir(rootReturning(writeableSl()))).rejects.toBeInstanceOf(
      CatalogTooNewError,
    );

    expect(b._files.has("/card/.safelight/edits/ab/p1.json")).toBe(false);
    expect(spilloverEdits(b)).toHaveLength(1);
  });

  it("keeps the spillover edits when one can't be written in-folder", async () => {
    const b = nativeBridge({
      files: {
        "/card/.safelight/catalog.json": '{"v":"same"}',
        [`${SPILL}/catalog.json`]: '{"v":"same"}',
        [`${SPILL}/edits/ab/p1.json`]: editFile("p1", [5, "w"]),
        ...SEEDED,
      },
      ext: async () => SPILL,
    });
    b.write.mockRejectedValue(new Error("EROFS: read-only file system"));

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.promotedFromExternal ?? null).toBeNull();
    expect(spilloverEdits(b)).toHaveLength(1);
    expect(b._files.has(`${SPILL}/.seeded`)).toBe(true); // still to fold
  });

  it("keeps only the newest three before-merge directories of replaced edits", async () => {
    const stamp = (n: number) => `2026-01-0${n}T00-00-00-000Z`;
    const old = Object.fromEntries(
      [1, 2, 3].map((n) => [
        `/card/.safelight/before-merge-${stamp(n)}/edits/ab/p${n}.json`,
        `old ${n}`,
      ]),
    );
    const b = nativeBridge({
      files: {
        ...old,
        "/card/.safelight/catalog.json": '{"v":"same"}',
        "/card/.safelight/edits/ab/p1.json": editFile("p1", [1, "a"]),
        [`${SPILL}/catalog.json`]: '{"v":"same"}',
        [`${SPILL}/edits/ab/p1.json`]: editFile("p1", [2, "a"]),
        ...SEEDED,
      },
      ext: async () => SPILL,
    });

    await resolveWorkingDir(rootReturning(writeableSl()));

    expect([...b._files.keys()].some((p) => p.includes(`before-merge-${stamp(1)}`))).toBe(false);
    expect(b._files.has(`/card/.safelight/before-merge-${stamp(2)}/edits/ab/p2.json`)).toBe(true);
    expect(b._files.has(`/card/.safelight/before-merge-${stamp(3)}/edits/ab/p3.json`)).toBe(true);
    expect(keptEdits(b)).toHaveLength(3); // the two old directories left, and this fold's
  });

  it("changes nothing more than today for a spillover with no edits directory", async () => {
    const b = nativeBridge({
      inFolderCatalog: true,
      files: { [`${SPILL}/catalog.json`]: '{"v":"read-only-edits"}', ...SEEDED },
      ext: async () => SPILL,
    });

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.promotedFromExternal).toBe(SPILL);
    expect(keptBeforeMerge(b)).toEqual(['{"v":"in-folder"}']);
    expect(keptEdits(b)).toEqual([]);
    expect(b.write).toHaveBeenCalledTimes(2); // the catalogue copy, then the catalogue
    expect(b.remove).not.toHaveBeenCalledWith(`${SPILL}/edits`);
  });
});

describe("resolveWorkingDir with another card at the same mount point", () => {
  // Every card a camera formats mounts at one path (E:\, /Volumes/EOS_DIGITAL), and
  // names its photos alike; their separate catalogues must stay apart.
  const MOUNT = "/Volumes/EOS_DIGITAL";
  const CARD_A = { "DCIM/IMG_0001.CR3": "a1", "DCIM/IMG_0002.CR3": "a22", "DCIM/IMG_0003.CR3": "a333" };
  const CARD_B = { "DCIM/IMG_0001.CR3": "b-one", "DCIM/IMG_0002.CR3": "b-two!", "DCIM/IMG_0003.CR3": "b-3!!!!" };
  type Card = Record<string, string>;

  const dirOf = (variant: number) =>
    variant > 1 ? `/data/card-0123abcd-${variant}/.safelight` : "/data/card-0123abcd/.safelight";
  const catalogOf = (card: Card) =>
    JSON.stringify({
      version: 1,
      photos: Object.entries(card).map(([relPath, body]) => ({
        id: body,
        relPath,
        fileSize: body.length,
        exif: { dateTimeOriginal: shotOf(body) },
      })),
      edits: [],
    });
  const printOf = (card: Card) =>
    JSON.stringify({
      source: MOUNT,
      createdAt: 1,
      volume: Object.entries(card).map(([relPath, body]) => ({ relPath, size: body.length, shot: shotOf(body) })),
    });
  const mounted = (card: Card) =>
    Object.fromEntries(Object.entries(card).map(([rel, body]) => [`${MOUNT}/${rel}`, body]));
  /** The separate catalogue `card` keeps as `variant`, its print recorded or not. */
  const keptFor = (card: Card, variant: number, printed = true) => ({
    [`${dirOf(variant)}/catalog.json`]: catalogOf(card),
    ...(printed ? { [`${dirOf(variant).replace(/\/\.safelight$/, "")}/source.json`]: printOf(card) } : {}),
  });

  function cardBridge(
    card: Card,
    files: Record<string, string>,
    inFolderCatalog = false,
    busy: string[] = [],
  ) {
    const held: { files?: Map<string, unknown> } = {};
    const saved = (variant: number) => held.files!.has(`${dirOf(variant)}/catalog.json`);
    const b = nativeBridge({
      inFolderCatalog,
      busy,
      mount: MOUNT,
      files: { ...mounted(card), ...files },
      ext: async (_p, _base, create, variant = 1) => (create || saved(variant) ? dirOf(variant) : null),
    });
    held.files = b._files;
    return Object.assign(b, {
      externalCatalogVariants: vi.fn(async () => [1, 2, 3, 4, 5].filter(saved)),
    });
  }

  /** Card `card`'s photos, each a RAW whose EXIF says it was taken at `shot`
   *  and padded by `pad` bytes, as a geotagging tool leaves them. */
  function rewrite(b: ReturnType<typeof cardBridge>, card: Card, pad: number): void {
    for (const [rel, body] of Object.entries(card)) {
      const raw = buildTiff({ le: true, exif: [[DATE_TIME_ORIGINAL, ascii(shotOf(body))]] });
      b._files.set(`${MOUNT}/${rel}`, { data: new Uint8Array([...raw, ...new Uint8Array(pad)]), mtimeMs: 1 });
    }
  }
  const cardRoot = (card: Card, files: Record<string, string>) => {
    cardBridge(card, files);
    return rootReturning(writeableSl());
  };
  const shotOf = (body: string) => `2024:05:01 10:00:${String(body.length).padStart(2, "0")}`;

  it.each([
    ["external mode", "external", () => rootReturning(writeableSl())],
    ["a read-only card", "in-folder", () => rootThrowing(EROFS())],
  ] as const)("opens a fresh catalogue for card B in %s, leaving card A's as it was", async (_, mode, root) => {
    h.settings.catalogLocation = mode;
    const b = cardBridge(CARD_B, keptFor(CARD_A, 1));

    const wd = await resolveWorkingDir(root());

    expect(wd).toMatchObject({ location: "external", externalPath: dirOf(2) });
    expect(b._text(`${dirOf(1)}/catalog.json`)).toBe(catalogOf(CARD_A));
  });

  it.each([
    ["card A", CARD_A, 1],
    ["card B", CARD_B, 2],
  ] as const)("goes back to %s's own catalogue when it is mounted again", async (_, card, variant) => {
    h.settings.catalogLocation = "external";
    cardBridge(card, { ...keptFor(CARD_A, 1), ...keptFor(CARD_B, 2) });

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.externalPath).toBe(dirOf(variant));
  });

  it("tells the cards apart by a catalogue's photos when it has no print yet", async () => {
    h.settings.catalogLocation = "external";
    cardBridge(CARD_B, keptFor(CARD_A, 1, false));

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.externalPath).toBe(dirOf(2));
  });

  it("keeps a card's catalogue when most of its photos are still on it", async () => {
    h.settings.catalogLocation = "external";
    const { "DCIM/IMG_0003.CR3": _gone, ...twoLeft } = CARD_A;
    cardBridge({ ...twoLeft, "DCIM/IMG_0004.CR3": "new" }, keptFor(CARD_A, 1));

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.externalPath).toBe(dirOf(1));
  });

  it("spills card B's read-only session into a catalogue of its own, seeded from card B", async () => {
    const b = cardBridge(CARD_B, { ...keptFor(CARD_A, 1), [`${dirOf(1)}/.seeded`]: MOUNT }, true);

    const wd = await resolveWorkingDir(rootReturning(readOnlySl(EROFS())));

    expect(wd.externalPath).toBe(dirOf(2));
    expect(b._text(`${dirOf(2)}/catalog.json`)).toBe('{"v":"in-folder"}');
    expect(b._text(`${dirOf(1)}/catalog.json`)).toBe(catalogOf(CARD_A));
  });

  it("never folds card B's spillover into card A, though the pointer names it", async () => {
    const b = cardBridge(
      CARD_A,
      {
        ...keptFor(CARD_A, 1),
        [`${dirOf(1)}/.seeded`]: MOUNT,
        ...keptFor(CARD_B, 2),
        [`${dirOf(2)}/.seeded`]: MOUNT,
      },
      true,
    );
    b._pointers.set(MOUNT, dirOf(2));

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.promotedFromExternal).toBe(dirOf(1));
    expect(b._text(`${MOUNT}/.safelight/catalog.json`)).toBe(catalogOf(CARD_A));
    expect(b._text(`${dirOf(2)}/catalog.json`)).toBe(catalogOf(CARD_B));
    expect(b._files.has(`${dirOf(2)}/.seeded`)).toBe(true);
  });
  it.each([
    ["in place, by a geotagging tool", true],
    ["in place, a catalogue from before prints were kept", false],
  ] as const)("keeps card A's catalogue when all its photos were rewritten %s", async (_, printed) => {
    h.settings.catalogLocation = "external";
    const b = cardBridge(CARD_A, keptFor(CARD_A, 1, printed));
    rewrite(b, CARD_A, 100);

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.externalPath).toBe(dirOf(1));
  });

  it("keeps card A's catalogue when most of its photos were erased in camera", async () => {
    h.settings.catalogLocation = "external";
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`DCIM/IMG_${String(i + 1).padStart(4, "0")}.CR3`, "a".repeat(i + 1)]),
    );
    const left = { "DCIM/IMG_0040.CR3": many["DCIM/IMG_0040.CR3"], "DCIM/IMG_0100.CR3": "new shot" };
    cardBridge(left, keptFor(many, 1));

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.externalPath).toBe(dirOf(1));
  });

  it("opens a fresh catalogue for a card none of whose photos card A's names", async () => {
    h.settings.catalogLocation = "external";
    cardBridge({ "DCIM/100MSDCF/DSC00001.ARW": "sony" }, keptFor(CARD_A, 1));

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.externalPath).toBe(dirOf(2));
  });

  it("counts a photo it can't read right now as no sign of another card", async () => {
    h.settings.catalogLocation = "external";
    cardBridge(CARD_B, keptFor(CARD_A, 1), false, Object.keys(mounted(CARD_B)));

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.externalPath).toBe(dirOf(1));
  });

  it("finds the card's catalogue past one deleted before it, and makes a new one after the last", async () => {
    h.settings.catalogLocation = "external";
    const files = { ...keptFor(CARD_A, 2), ...keptFor(CARD_B, 3) };
    expect((await resolveWorkingDir(cardRoot(CARD_A, files))).externalPath).toBe(dirOf(2));
    expect((await resolveWorkingDir(cardRoot({ "DCIM/C.CR3": "card C" }, files))).externalPath).toBe(dirOf(4));
  });

  it("takes the card's own catalogue over one that holds no photos", async () => {
    h.settings.catalogLocation = "external";
    const empty = { [`${dirOf(1)}/catalog.json`]: JSON.stringify({ version: 1, photos: [], edits: [] }) };
    cardBridge(CARD_A, { ...empty, ...keptFor(CARD_A, 2) });

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.externalPath).toBe(dirOf(2));
  });

  it("keeps an ordinary folder's catalogue when its photos were sorted into subfolders", async () => {
    h.settings.catalogLocation = "external";
    const sorted = { "/card/Day1/IMG_0001.CR3": "a1", "/card/Day2/IMG_0002.CR3": "a22" };
    const b = nativeBridge({
      files: { ...sorted, ...keptFor(CARD_A, 1) },
      ext: async (_p, _base, create, variant = 1) => (create || variant === 1 ? dirOf(variant) : null),
    });

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.externalPath).toBe(dirOf(1));
    expect(b.externalCatalogDir).not.toHaveBeenCalledWith("/card", null, true, 2);
  });
});
