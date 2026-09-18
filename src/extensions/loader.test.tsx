// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension update safety: a newer version must never cost the user the version
// that works. Classification is pure; the lifecycle tests drive the real loader
// through the stubbed Electron bridge (window.safelightNative), with only the
// bundle import — an app:// URL jsdom cannot fetch — substituted.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ExtensionManifest, ExtensionModule, SafelightAPI } from "./types";
import { useRegistry } from "./registry";
import { useExtStoreUI, type ExtUpdateInfo } from "./store-ui";
import { updateSettings } from "@/state/settings-store";
import { importPluginModule } from "./plugin-module";
import {
  checkAllExtensionUpdates,
  classifyUpdate,
  installFromGitHub,
  loadExternalPlugins,
  uninstallPlugin,
  updateExtension,
  useDisabledExtensions,
} from "./loader";

vi.mock("./plugin-module", () => ({ importPluginModule: vi.fn() }));

const ID = "acme.widget";
const REPO = "acme/widget";
const SHEET = "acme.widget.css";

const manifest = (version: string): ExtensionManifest => ({
  id: ID,
  name: "Widget",
  version,
  main: "index.js",
  repository: REPO,
});

/** A fake bundle. It registers one stylesheet, so that sheet's presence in the
 *  registry says whether the extension is live. */
const bundle = (): ExtensionModule & { deactivate: Mock } => ({
  activate: (api: SafelightAPI) => api.registerStylesheet({ id: SHEET, css: ".a{}" }),
  deactivate: vi.fn(),
});
const broken = (): Partial<ExtensionModule> => ({
  activate: () => {
    throw new Error("boom");
  },
});
/** A bundle that registers a stylesheet and then throws: activation half done. */
const brokenAfter = (sheetId: string): Partial<ExtensionModule> => ({
  activate: (api: SafelightAPI) => {
    api.registerStylesheet({ id: sheetId, css: ".g{}" });
    throw new Error("boom");
  },
});
const GHOST = "acme.widget.ghost";
const live = () => SHEET in useRegistry.getState().stylesheets;
const ghost = () => GHOST in useRegistry.getState().stylesheets;

const importer = vi.mocked(importPluginModule);
/** Route each version's cache-busted bundle URL to a module. */
const serve = (modules: Record<string, Partial<ExtensionModule>>) =>
  importer.mockImplementation(async (url) => {
    const version = new URL(url).searchParams.get("v") ?? "";
    const mod = modules[version];
    if (!mod) throw new Error(`no bundle for ${url}`);
    return mod;
  });

let list: ExtensionManifest[];
let install: Mock;
let settleUpdate: Mock;
let remoteManifest: Mock;

beforeEach(() => {
  localStorage.clear();
  list = [manifest("1.0.0")];
  install = vi.fn(async () => manifest("2.0.0"));
  settleUpdate = vi.fn(async (_id: string, outcome: string) =>
    outcome === "rollback" ? manifest("1.0.0") : null,
  );
  remoteManifest = vi.fn(async () => ({ version: "2.0.0" }));
  vi.stubGlobal("safelightNative", {
    plugins: {
      list: async () => list,
      install,
      uninstall: vi.fn(async () => {}),
      settleUpdate,
      remoteManifest,
    },
  });
  useRegistry.setState({ stylesheets: {} });
  useDisabledExtensions.setState({ ids: [] });
  useExtStoreUI.setState({ updates: {} });
  updateSettings({ checkExtensionUpdates: true, autoUpdateExtensions: false });
  importer.mockReset();
});

afterEach(async () => {
  await uninstallPlugin(ID); // the loader's live-module map persists across tests
  vi.unstubAllGlobals();
});

/** Boot with version 1.0.0 installed and running. */
const bootWith = async (mod: Partial<ExtensionModule>) => {
  serve({ "1.0.0": mod });
  await loadExternalPlugins();
  expect(live()).toBe(true);
};

describe("classifyUpdate", () => {
  const now = 1_000;

  it("flags a newer version", () => {
    expect(classifyUpdate("1.0.0", { version: "1.1.0" }, "2.5.0", undefined, now)).toEqual({
      latestTag: "1.1.0",
      hasUpdate: true,
      requiresApp: null,
      failed: null,
      checkedAt: now,
    });
  });

  it("is quiet for the same or an older version", () => {
    expect(classifyUpdate("1.1.0", { version: "1.1.0" }, "2.5.0", undefined, now).hasUpdate).toBe(false);
    expect(classifyUpdate("1.1.0", { version: "1.0.0" }, "2.5.0", undefined, now).hasUpdate).toBe(false);
  });

  it("records the Safelight version a newer release needs when this build is older", () => {
    const blocked = classifyUpdate(
      "1.0.0",
      { version: "1.1.0", minAppVersion: "2.6.0" },
      "2.5.0",
      undefined,
      now,
    );
    expect(blocked).toMatchObject({ hasUpdate: true, requiresApp: "2.6.0" });
    const fine = classifyUpdate(
      "1.0.0",
      { version: "1.1.0", minAppVersion: "2.5.0" },
      "2.5.0",
      undefined,
      now,
    );
    expect(fine.requiresApp).toBeNull();
  });

  it("has no update info without a remote manifest", () => {
    expect(classifyUpdate("1.0.0", null, "2.5.0", undefined, now)).toEqual({
      latestTag: null,
      hasUpdate: false,
      requiresApp: null,
      failed: null,
      checkedAt: now,
    });
  });

  it("carries a failure over only while the same version is still the latest", () => {
    const prior: ExtUpdateInfo = {
      latestTag: "1.1.0",
      hasUpdate: true,
      requiresApp: null,
      failed: { version: "1.1.0", error: "boom" },
      checkedAt: 0,
    };
    expect(classifyUpdate("1.0.0", { version: "1.1.0" }, "2.5.0", prior, now).failed).toEqual(
      prior.failed,
    );
    expect(classifyUpdate("1.0.0", { version: "1.2.0" }, "2.5.0", prior, now).failed).toBeNull();
  });
});

describe("updateExtension", () => {
  it("leaves the running extension untouched when the download fails", async () => {
    await bootWith(bundle());
    install.mockRejectedValueOnce(new Error("GitHub download failed (503)"));
    await expect(updateExtension(REPO)).rejects.toThrow("GitHub download failed");
    expect(live()).toBe(true);
    expect(settleUpdate).not.toHaveBeenCalled();
  });

  it("keeps a disabled extension disabled and does not start it", async () => {
    useDisabledExtensions.setState({ ids: [ID] });
    await expect(updateExtension(REPO)).resolves.toMatchObject({ version: "2.0.0" });
    expect(useDisabledExtensions.getState().ids).toContain(ID);
    expect(importer).not.toHaveBeenCalled();
    expect(settleUpdate).toHaveBeenCalledWith(ID, "keep");
    expect(useExtStoreUI.getState().updates[ID]).toMatchObject({
      latestTag: "2.0.0",
      hasUpdate: false,
    });
  });

  it("swaps in a working new version and settles keep", async () => {
    const v1 = bundle();
    await bootWith(v1);
    serve({ "1.0.0": v1, "2.0.0": bundle() });
    await expect(updateExtension(REPO)).resolves.toMatchObject({ version: "2.0.0" });
    expect(v1.deactivate).toHaveBeenCalledOnce();
    expect(live()).toBe(true);
    expect(settleUpdate).toHaveBeenCalledWith(ID, "keep");
    expect(useExtStoreUI.getState().updates[ID]).toMatchObject({
      latestTag: "2.0.0",
      hasUpdate: false,
      failed: null,
    });
  });

  it("rolls back and restarts the previous version when the new bundle fails to start", async () => {
    const v1 = bundle();
    await bootWith(v1);
    serve({ "1.0.0": v1, "2.0.0": broken() });
    await expect(updateExtension(REPO)).rejects.toThrow(
      "Widget 2.0.0 failed to start (boom); 1.0.0 was restored",
    );
    expect(settleUpdate).toHaveBeenCalledWith(ID, "rollback");
    expect(live()).toBe(true);
    expect(useExtStoreUI.getState().updates[ID]).toMatchObject({
      latestTag: "2.0.0",
      hasUpdate: true,
      failed: { version: "2.0.0", error: "boom" },
    });
  });

  it("sweeps what a broken bundle registered before it threw", async () => {
    const v1 = bundle();
    await bootWith(v1);
    serve({ "1.0.0": v1, "2.0.0": brokenAfter(GHOST) });
    await expect(updateExtension(REPO)).rejects.toThrow("failed to start");
    expect(live()).toBe(true);
    expect(ghost()).toBe(false);
  });

  it("reports when the restored version also fails to start, leaving nothing active", async () => {
    await bootWith(bundle());
    serve({ "1.0.0": brokenAfter(GHOST), "2.0.0": broken() });
    await expect(updateExtension(REPO)).rejects.toThrow(
      "Widget 2.0.0 failed to start (boom); restoring 1.0.0 also failed (boom)",
    );
    expect(live()).toBe(false);
    expect(ghost()).toBe(false);
    expect(useExtStoreUI.getState().updates[ID]?.failed).toEqual({ version: "2.0.0", error: "boom" });
  });

  it("keeps the activation error when the rollback itself cannot be settled", async () => {
    await bootWith(bundle());
    serve({ "2.0.0": broken() });
    settleUpdate.mockRejectedValueOnce(new Error("EBUSY"));
    await expect(updateExtension(REPO)).rejects.toThrow(
      "Widget 2.0.0 failed to start (boom); rollback failed (EBUSY)",
    );
    expect(live()).toBe(false);
    expect(useExtStoreUI.getState().updates[ID]?.failed).toEqual({ version: "2.0.0", error: "boom" });
  });

  it("does not turn a working update into a failure when the keep settle fails", async () => {
    const v1 = bundle();
    await bootWith(v1);
    serve({ "1.0.0": v1, "2.0.0": bundle() });
    settleUpdate.mockRejectedValueOnce(new Error("EBUSY"));
    await expect(updateExtension(REPO)).resolves.toMatchObject({ version: "2.0.0" });
    expect(live()).toBe(true);
    expect(useExtStoreUI.getState().updates[ID]).toMatchObject({ latestTag: "2.0.0", hasUpdate: false });
  });

  it("runs one install per repo at a time", async () => {
    const v1 = bundle();
    await bootWith(v1);
    serve({ "1.0.0": v1, "2.0.0": bundle() });
    const [a, b] = await Promise.all([updateExtension(REPO), updateExtension(REPO)]);
    expect(install).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(live()).toBe(true);
  });
});

describe("installFromGitHub", () => {
  it("sweeps a first install's contributions when its bundle fails to start", async () => {
    install.mockResolvedValueOnce(manifest("1.0.0"));
    settleUpdate.mockResolvedValueOnce(null);
    serve({ "1.0.0": brokenAfter(SHEET) });
    await expect(installFromGitHub(REPO)).rejects.toThrow("failed to start");
    expect(live()).toBe(false);
  });

  it("starts a fresh install enabled even if that id was disabled before", async () => {
    useDisabledExtensions.setState({ ids: [ID] });
    install.mockResolvedValueOnce(manifest("1.0.0"));
    serve({ "1.0.0": bundle() });
    await installFromGitHub(REPO);
    expect(useDisabledExtensions.getState().ids).not.toContain(ID);
    expect(live()).toBe(true);
    expect(settleUpdate).toHaveBeenCalledWith(ID, "keep");
  });

  it("removes a first install whose bundle fails to start", async () => {
    install.mockResolvedValueOnce(manifest("1.0.0"));
    settleUpdate.mockResolvedValueOnce(null); // nothing to restore
    serve({ "1.0.0": broken() });
    await expect(installFromGitHub(REPO)).rejects.toThrow("Widget 1.0.0 failed to start (boom)");
    expect(settleUpdate).toHaveBeenCalledWith(ID, "rollback");
    expect(live()).toBe(false);
    expect(useExtStoreUI.getState().updates[ID]).toBeUndefined();
  });
});

describe("checkAllExtensionUpdates with auto-update on", () => {
  const other = (id: string, repo: string): ExtensionManifest => ({
    id,
    name: id,
    version: "1.0.0",
    main: "index.js",
    repository: repo,
  });

  beforeEach(() => updateSettings({ autoUpdateExtensions: true }));

  it("installs only updates this build can run, for extensions that are on", async () => {
    list = [
      manifest("1.0.0"),
      other("acme.blocked", "acme/blocked"),
      other("acme.off", "acme/off"),
      other("acme.failed", "acme/failed"),
    ];
    useDisabledExtensions.setState({ ids: ["acme.off"] });
    useExtStoreUI.getState().setUpdate("acme.failed", {
      latestTag: "2.0.0",
      hasUpdate: true,
      requiresApp: null,
      failed: { version: "2.0.0", error: "boom" },
      checkedAt: Date.now(),
    });
    remoteManifest.mockImplementation(async (repo: string) =>
      repo === "acme/blocked"
        ? { version: "2.0.0", minAppVersion: "99.0.0" }
        : { version: "2.0.0" },
    );
    serve({ "2.0.0": bundle() });

    await checkAllExtensionUpdates(true);

    expect(install.mock.calls.map(([spec]) => spec)).toEqual([REPO]);
    expect(remoteManifest).toHaveBeenCalledTimes(4); // every extension is still checked
  });

  it("keeps the last record and installs nothing while the check cannot reach GitHub", async () => {
    const failed: ExtUpdateInfo = {
      latestTag: "2.0.0",
      hasUpdate: true,
      requiresApp: null,
      failed: { version: "2.0.0", error: "boom" },
      checkedAt: 0,
    };
    useExtStoreUI.getState().setUpdate(ID, failed);
    remoteManifest.mockRejectedValue(new Error("offline"));

    await checkAllExtensionUpdates(true);

    expect(install).not.toHaveBeenCalled();
    expect(useExtStoreUI.getState().updates[ID]).toEqual(failed);
  });
});
