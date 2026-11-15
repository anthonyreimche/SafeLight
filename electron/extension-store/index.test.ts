// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The plugin folder changes (swap, settle, uninstall) run under <userData>/plugins.lock.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLock, releaseLock } from "../file-lock.cjs";
import { createExtensionStore, pluginsLockFile, pluginsLocker } from "./index.cjs";

let userData: string;
let lock: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-store-"));
  lock = pluginsLockFile(userData);
});

afterEach(() => fs.rmSync(userData, { recursive: true, force: true }));

function work(seen: boolean[]) {
  return vi.fn(async () => {
    seen.push(fs.existsSync(lock));
    return "done";
  });
}

describe("pluginsLocker", () => {
  it("holds plugins.lock while the work runs, and releases it after", async () => {
    const seen: boolean[] = [];
    const underLock = pluginsLocker({ lockFile: () => lock, owner: "slu" });
    const fn = work(seen);
    await expect(underLock(fn)).resolves.toBe("done");
    expect(seen).toEqual([true]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("waits while another process holds the lock, then runs", async () => {
    const held = await acquireLock(lock, "slu");
    setTimeout(() => void releaseLock(lock, (held as { token: string }).token), 60);
    const underLock = pluginsLocker({ lockFile: () => lock, waitMs: 2000, pollMs: 10 });
    const fn = work([]);
    await underLock(fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("fails without running the work when the lock stays held", async () => {
    await acquireLock(lock, "slu");
    const underLock = pluginsLocker({ lockFile: () => lock, waitMs: 40, pollMs: 10 });
    const fn = work([]);
    await expect(underLock(fn)).rejects.toMatchObject({ code: "ELOCKED" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("releases the lock when the work throws", async () => {
    const underLock = pluginsLocker({ lockFile: () => lock });
    await expect(underLock(async () => Promise.reject(new Error("bad zip")))).rejects.toThrow("bad zip");
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe("createExtensionStore", () => {
  it("builds the store surface the IPC table reads", () => {
    const store = createExtensionStore({
      net: { fetch: vi.fn() },
      userData: () => userData,
      fileWriter: { write: async () => undefined },
      appVersion: () => "3.0.0",
      pluginsDir: () => path.join(userData, "plugins"),
      pluginWorkDir: () => path.join(userData, "plugins-update"),
    } as never);
    expect(Object.keys(store).sort()).toEqual(
      [
        "fetchReadme",
        "fetchReleaseManifest",
        "fetchReleases",
        "fetchReleasesForStore",
        "fetchRemoteManifest",
        "fetchRepoMeta",
        "fetchTrustList",
        "installPlugin",
        "kits",
        "resolveThumbnails",
        "searchExtensions",
        "settleUpdate",
        "storeVocabulary",
        "uninstallPlugin",
      ].sort(),
    );
  });
});
