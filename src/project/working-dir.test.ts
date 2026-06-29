// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect, vi, beforeEach } from "vitest";

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

// A .safelight handle that accepts the write-probe and the catalog-exists check.
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
  ext: (p: string, base: string | null, create: boolean) => Promise<string | null>;
}) {
  let clock = 1;
  const files = new Map<string, { data: Uint8Array; mtimeMs: number }>();
  const pointers = new Map<string, string>(Object.entries(opts.pointers ?? {}));
  const put = (p: string, content: string) =>
    files.set(p, { data: new TextEncoder().encode(content), mtimeMs: clock++ });
  if (opts.inFolderCatalog) put("/card/.safelight/catalog.json", '{"v":"in-folder"}');
  for (const [p, c] of Object.entries(opts.files ?? {})) put(p, c);
  const under = (prefix: string, p: string) =>
    p === prefix || p.startsWith(prefix + "/") || p.startsWith(prefix + "\\");
  const bridge = {
    exists: vi.fn(async (p: string) => files.has(p)),
    read: vi.fn(async (p: string) => {
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
  h.nativePathOf.mockReturnValue("/card");
  h.nativeDirectoryHandle.mockImplementation(
    (p: string) => ({ __ext: p }) as unknown as FileSystemDirectoryHandle,
  );
  return bridge;
}

const EROFS = () => new Error("EROFS: read-only file system, mkdir '/card/.safelight'");

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

  it("STICKY: keeps using an existing separate catalog even when the folder is now writeable", async () => {
    // The Q1 regression: a card was read-only (so a separate catalog was built),
    // then becomes writeable. We must NOT spawn a fresh in-folder .safelight and
    // orphan the catalog — the existing separate one wins.
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

  it("EXTERNAL mode: stores the catalog separately even for a writeable folder", async () => {
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

  it("EXTERNAL mode never orphans an existing in-folder catalog (canonical wins)", async () => {
    // Flipping the global setting to "external" must not abandon catalogs the
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
    // A separate catalog is never *created* (it may be probed read-only to look
    // for a spillover to promote, but never built/used here).
    expect(ext).not.toHaveBeenCalledWith("/card", null, true);
  });

  it("uses the in-folder catalog when it already exists (canonical), not a redirect", async () => {
    const sl = writeableSl();
    nativeBridge({
      inFolderCatalog: true, // <project>/.safelight/catalog.json exists
      ext: async () => "/data/should-not-be-used/.safelight",
    });
    const wd = await resolveWorkingDir(rootReturning(sl));
    expect(wd.location).toBe("in-folder");
    expect(wd.sl).toBe(sl);
  });

  it("falls back to a separate dir when the in-folder catalog exists but the folder is read-only", async () => {
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

  it("SEED: a read-only open seeds the separate catalog from the in-folder one", async () => {
    // The folder owns a catalog but is mounted read-only. The separate catalog we
    // redirect to must open onto the user's real data, not an empty catalog.
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

  it("PROMOTE: a writeable open folds a seeded separate catalog back in-folder", async () => {
    // The card is writeable again; edits made while read-only (in the seeded
    // separate) must be merged back, with the prior in-folder catalog backed up.
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
    expect(b._text("/card/.safelight/catalog.bak.json")).toBe('{"v":"in-folder"}');
    expect(b._files.has("/data/card-abc/.safelight/.seeded")).toBe(false); // consumed
    expect(b._files.has("/data/card-abc/.safelight/catalog.json")).toBe(false); // spillover retired
  });

  it("does NOT fold a STALE spillover over newer in-folder edits (leftover/stuck marker)", async () => {
    // A marker that survived a failed cleanup, after which the user did more
    // writeable work: the spillover is now older than the in-folder catalog. The
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
    expect(b._files.has("/card/.safelight/catalog.bak.json")).toBe(false); // no backup clobber
    expect(b._files.has("/data/card-abc/.safelight/.seeded")).toBe(false); // spent marker consumed
  });

  it("does NOT fold (or notify) when the spillover is identical (read-only browse, no edits)", async () => {
    // Seeded marker present but the separate matches the in-folder catalog byte for
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
    expect(b._files.has("/card/.safelight/catalog.bak.json")).toBe(false); // no redundant backup
    expect(b._files.has("/data/card-abc/.safelight/.seeded")).toBe(false); // marker consumed
  });

  it("PROMOTE finds a spillover under the default base even after the base setting changed", async () => {
    // User redirected with the default base, then changed "Separate catalog
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
    expect(b._text("/card/.safelight/catalog.bak.json")).toBe('{"v":"in-folder"}');
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

  it("does NOT promote a separate catalog that isn't a seeded spillover", async () => {
    // A standalone external-mode catalog (no .seeded marker) must never be folded
    // onto an in-folder one — that would clobber the in-folder catalog.
    const b = nativeBridge({
      inFolderCatalog: true,
      files: { "/data/ext/.safelight/catalog.json": '{"v":"external-mode"}' },
      ext: async () => "/data/ext/.safelight",
    });

    const wd = await resolveWorkingDir(rootReturning(writeableSl()));

    expect(wd.location).toBe("in-folder");
    expect(wd.promotedFromExternal ?? null).toBeNull();
    expect(b._text("/card/.safelight/catalog.json")).toBe('{"v":"in-folder"}'); // untouched
    expect(b._files.has("/card/.safelight/catalog.bak.json")).toBe(false); // no backup written
  });

  it("rethrows a non-read-only failure unchanged (not classified as read-only)", async () => {
    const enospc = new Error("ENOSPC: no space left on device");
    await expect(resolveWorkingDir(rootThrowing(enospc))).rejects.toBe(enospc);
  });

  it("rethrows a non-read-only failure from the in-folder-catalog path (step 1), no redirect", async () => {
    // In-folder catalog exists (so we enter step 1) but the write probe fails
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
