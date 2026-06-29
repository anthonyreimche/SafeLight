// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mock state so the vi.mock factories (hoisted above imports) can
// reference it without a temporal-dead-zone error.
const h = vi.hoisted(() => ({
  settings: { externalCatalogDir: "" as string },
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

// A .safelight handle that accepts the write-probe (getFileHandle → writable →
// close → removeEntry all resolve).
function writeableSl() {
  return {
    getFileHandle: vi.fn(async () => ({
      createWritable: async () => ({
        write: async () => {},
        close: async () => {},
      }),
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

const EROFS = () => new Error("EROFS: read-only file system, mkdir '/card/.safelight'");

beforeEach(() => {
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

  it("redirects to the app data dir when creating .safelight fails (read-only card)", async () => {
    const ext = {} as FileSystemDirectoryHandle;
    const externalCatalogDir = vi.fn(async () => "/data/external-catalogs/card-abc123/.safelight");
    h.isNativeFS.mockReturnValue(true);
    h.nativeFs.mockReturnValue({ externalCatalogDir });
    h.nativePathOf.mockReturnValue("/card");
    h.nativeDirectoryHandle.mockReturnValue(ext);

    const wd = await resolveWorkingDir(rootThrowing(EROFS()));

    expect(wd.location).toBe("external");
    expect(wd.externalPath).toBe("/data/external-catalogs/card-abc123/.safelight");
    expect(wd.sl).toBe(ext);
    // Default base → null is passed so main uses userData.
    expect(externalCatalogDir).toHaveBeenCalledWith("/card", null);
  });

  it("passes the user-configured base directory to the bridge", async () => {
    h.settings.externalCatalogDir = "/scratch/safelight";
    const externalCatalogDir = vi.fn(async () => "/scratch/safelight/card-abc123/.safelight");
    h.isNativeFS.mockReturnValue(true);
    h.nativeFs.mockReturnValue({ externalCatalogDir });
    h.nativePathOf.mockReturnValue("/card");
    h.nativeDirectoryHandle.mockReturnValue({} as FileSystemDirectoryHandle);

    await resolveWorkingDir(rootThrowing(EROFS()));

    expect(externalCatalogDir).toHaveBeenCalledWith("/card", "/scratch/safelight");
  });

  it("catches a read-only folder whose .safelight already exists (write probe)", async () => {
    const externalCatalogDir = vi.fn(async () => "/data/ext/.safelight");
    h.isNativeFS.mockReturnValue(true);
    h.nativeFs.mockReturnValue({ externalCatalogDir });
    h.nativePathOf.mockReturnValue("/card");
    h.nativeDirectoryHandle.mockReturnValue({} as FileSystemDirectoryHandle);

    const wd = await resolveWorkingDir(rootReturning(readOnlySl(EROFS())));
    expect(wd.location).toBe("external");
    expect(externalCatalogDir).toHaveBeenCalled();
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
    h.isNativeFS.mockReturnValue(true);
    h.nativeFs.mockReturnValue({
      externalCatalogDir: vi.fn(async () => {
        throw cause;
      }),
    });
    h.nativePathOf.mockReturnValue("/card");

    const err = await resolveWorkingDir(rootThrowing(EROFS())).catch((e) => e);
    expect(err).toBeInstanceOf(ReadOnlyProjectError);
    expect(err.redirectFailed).toBe(true);
    expect(err.cause).toBe(cause);
  });

  it("rethrows a non-read-only failure unchanged (not classified as read-only)", async () => {
    const enospc = new Error("ENOSPC: no space left on device");
    await expect(resolveWorkingDir(rootThrowing(enospc))).rejects.toBe(enospc);
  });
});
