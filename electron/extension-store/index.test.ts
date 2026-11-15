// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Installs, updates and uninstalls run under <userData>/plugins.lock.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLock, releaseLock } from "../file-lock.cjs";
import { createExtensionStore, pluginsLockFile, underPluginsLock } from "./index.cjs";

let userData: string;
let lock: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-store-"));
  lock = pluginsLockFile(userData);
});

afterEach(() => fs.rmSync(userData, { recursive: true, force: true }));

function installer() {
  const seen: boolean[] = [];
  const held = async () => {
    seen.push(fs.existsSync(lock));
    return null;
  };
  return { seen, installPlugin: vi.fn(held), settleUpdate: vi.fn(held), uninstallPlugin: vi.fn(held) };
}

describe("underPluginsLock", () => {
  it("holds plugins.lock during install, settle and uninstall, and releases it after", async () => {
    const inner = installer();
    const locked = underPluginsLock(inner, { lockFile: () => lock, owner: "slu" });
    await locked.installPlugin("a/b");
    await locked.settleUpdate("x", "keep");
    await locked.uninstallPlugin("x");
    expect(inner.seen).toEqual([true, true, true]);
    expect(fs.existsSync(lock)).toBe(false);
    expect(inner.installPlugin).toHaveBeenCalledWith("a/b");
  });

  it("waits while another process holds the lock, then installs", async () => {
    const inner = installer();
    const held = await acquireLock(lock, "slu");
    setTimeout(() => void releaseLock(lock, (held as { token: string }).token), 60);
    const locked = underPluginsLock(inner, { lockFile: () => lock, waitMs: 2000, pollMs: 10 });
    await locked.installPlugin("a/b");
    expect(inner.installPlugin).toHaveBeenCalledOnce();
  });

  it("fails without touching the plugins when the lock stays held", async () => {
    const inner = installer();
    await acquireLock(lock, "slu");
    const locked = underPluginsLock(inner, { lockFile: () => lock, waitMs: 40, pollMs: 10 });
    await expect(locked.uninstallPlugin("x")).rejects.toMatchObject({ code: "ELOCKED" });
    expect(inner.uninstallPlugin).not.toHaveBeenCalled();
  });

  it("releases the lock when the install throws", async () => {
    const inner = installer();
    inner.installPlugin.mockRejectedValueOnce(new Error("bad zip"));
    const locked = underPluginsLock(inner, { lockFile: () => lock });
    await expect(locked.installPlugin("a/b")).rejects.toThrow("bad zip");
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
