// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension update safety: a newer version must never cost the user the version
// that works. Classification is pure; the lifecycle tests drive the real loader
// through the stubbed Electron bridge (window.safelightNative), with only the
// bundle import — an app:// URL jsdom cannot fetch — substituted.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ExtensionManifest, ExtensionModule, SafelightAPI } from "./types";
import { registerModule, registerStylesheet, useRegistry } from "./registry";
import { CORE_EXTENSION_ID } from "./core-extension";
import { useExtStoreUI, type ExtUpdateInfo } from "./store-ui";
import { updateSettings } from "@/state/settings-store";
import { useUIStore } from "@/state/ui-store";
import { useProjectStore } from "@/project/project-store";
import { App } from "@/App";
import { importPluginModule } from "./plugin-module";
import {
  checkAllExtensionUpdates,
  checkExtensionUpdate,
  classifyUpdate,
  installFromGitHub,
  loadExternalPlugins,
  setExtensionEnabled,
  uninstallPlugin,
  updateExtension,
  useDisabledExtensions,
  useExternalPluginsSettled,
} from "./loader";
import { keptVersion, setKept, usePins } from "./pins";

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
const serve = (
  modules: Record<string, Partial<ExtensionModule> | Promise<Partial<ExtensionModule>>>,
) =>
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
  useRegistry.setState({ stylesheets: {}, modules: {} });
  useDisabledExtensions.setState({ ids: [] });
  useExternalPluginsSettled.setState({ settled: false });
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

describe("updating an extension whose module the main window shows", () => {
  /** A bundle whose module view names the version running. */
  const withModule = (version: string): ExtensionModule & { deactivate: Mock } => ({
    activate: (api: SafelightAPI) => {
      api.registerStylesheet({ id: SHEET, css: ".a{}" });
      api.registerModule({
        id: "widget",
        label: "Widget",
        component: () => <p>widget {version}</p>,
      });
    },
    deactivate: vi.fn(),
  });

  /** Holds a bundle's import until `open()`: the stretch of a real update in
   *  which the old version is down and the new one is still loading. */
  const held = (mod: Partial<ExtensionModule>) => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { mod: opened.then(() => mod), open };
  };

  /** The main window has no other windows to sync with here. */
  class SilentChannel {
    postMessage(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  }

  beforeEach(() => {
    vi.stubGlobal("BroadcastChannel", SilentChannel);
    useProjectStore.setState({
      root: { name: "shoot" } as unknown as FileSystemDirectoryHandle,
    });
    useUIStore.setState({ activeModule: "widget", detached: new Set() });
  });

  // Unmount before the file's afterEach uninstalls the extension underneath.
  afterEach(() => {
    cleanup();
    useProjectStore.setState({ root: null });
  });

  /** Start an update with the module on screen and stop once the old version
   *  is down; the main window has then fallen back to Library. The update is
   *  handed back wrapped: an async function returning it would wait for it. */
  async function startUpdate(): Promise<{ update: Promise<ExtensionManifest> }> {
    render(<App />);
    expect(screen.getByText("widget 1.0.0")).toBeTruthy();
    let update!: Promise<ExtensionManifest>;
    await act(async () => {
      update = updateExtension(REPO);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(useUIStore.getState().activeModule).toBe("library");
    return { update };
  }

  it("shows the module again once the new version has registered it", async () => {
    await bootWith(withModule("1.0.0"));
    const next = held(withModule("2.0.0"));
    serve({ "2.0.0": next.mod });
    const { update } = await startUpdate();

    await act(async () => {
      next.open();
      await update;
    });
    expect(useUIStore.getState().activeModule).toBe("widget");
    expect(screen.getByText("widget 2.0.0")).toBeTruthy();
  });

  it("shows the module again when a failed update restores the previous version", async () => {
    const v1 = withModule("1.0.0");
    await bootWith(v1);
    const next = held(broken());
    serve({ "1.0.0": v1, "2.0.0": next.mod });
    const { update } = await startUpdate();

    await act(async () => {
      next.open();
      await expect(update).rejects.toThrow("1.0.0 was restored");
    });
    expect(useUIStore.getState().activeModule).toBe("widget");
    expect(screen.getByText("widget 1.0.0")).toBeTruthy();
  });

  it("leaves the main window where the user went while the update loaded", async () => {
    await bootWith(withModule("1.0.0"));
    registerModule("other", { id: "notes", label: "Notes", component: () => <p>notes</p> });
    const next = held(withModule("2.0.0"));
    serve({ "2.0.0": next.mod });
    const { update } = await startUpdate();

    act(() => useUIStore.getState().setActiveModule("notes"));
    await act(async () => {
      next.open();
      await update;
    });
    expect(useUIStore.getState().activeModule).toBe("notes");
  });

  it("stays on Library when a failed update leaves no version of the module", async () => {
    await bootWith(withModule("1.0.0"));
    const next = held(broken());
    serve({ "2.0.0": next.mod });
    settleUpdate.mockResolvedValueOnce(null);
    const { update } = await startUpdate();

    await act(async () => {
      next.open();
      await expect(update).rejects.toThrow("Widget 2.0.0 failed to start (boom)");
    });
    expect(useUIStore.getState().activeModule).toBe("library");
    expect(screen.getByText("0 photos in catalog")).toBeTruthy();
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

describe("useExternalPluginsSettled", () => {
  it("flips once the installed plugins have been loaded", async () => {
    serve({ "1.0.0": bundle() });
    expect(useExternalPluginsSettled.getState().settled).toBe(false);
    await loadExternalPlugins();
    expect(useExternalPluginsSettled.getState().settled).toBe(true);
  });

  it("flips when there is no native bridge to load from", async () => {
    vi.stubGlobal("safelightNative", undefined);
    await loadExternalPlugins();
    expect(useExternalPluginsSettled.getState().settled).toBe(true);
  });

  it("flips even when a bundle fails to load", async () => {
    serve({ "1.0.0": broken() });
    await loadExternalPlugins();
    expect(useExternalPluginsSettled.getState().settled).toBe(true);
  });
});

// Ids under "core" are Safelight's own: an extension holding one would share the
// registry id of a built-in, and stopping it would sweep that built-in's
// contributions. Keep this last: if the refusal ever regresses, these runs sweep
// the registry the other tests share, and a test after them would fail for the
// wrong reason.
describe("an installed extension whose id is under core", () => {
  const RESERVED = ["core", "core.hsl", "CORE", "Core.Tools"];
  const reason = (id: string) => `${id}: extension ids under 'core' are reserved for Safelight`;
  const claiming = (id: string): ExtensionManifest => ({ ...manifest("1.0.0"), id });
  const ownSheet = (id: string) => `${id}.sheet`;
  const ownerOfSheet = (id: string) =>
    useRegistry.getState().stylesheets[ownSheet(id)]?.extensionId;
  /** What Safelight's own extension under `id` has registered. */
  const registerOwn = (id: string) => registerStylesheet(id, { id: ownSheet(id), css: ".own{}" });
  /** A bundle that registers something and then fails, so activating it would sweep its id. */
  const failing = () =>
    vi.fn((api: SafelightAPI) => {
      api.registerStylesheet({ id: GHOST, css: ".g{}" });
      throw new Error("boom");
    });

  afterEach(() => vi.restoreAllMocks());

  it.each(RESERVED)(
    "is not imported or activated at launch, and the log says why (%s)",
    async (id) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const activate = failing();
      registerOwn(id);
      list = [claiming(id)];
      serve({ "1.0.0": { activate } });

      await loadExternalPlugins();

      expect(importer).not.toHaveBeenCalled();
      expect(activate).not.toHaveBeenCalled();
      expect(ownerOfSheet(id)).toBe(id);
      expect(error).toHaveBeenCalledWith(expect.any(String), new Error(reason(id)));
    },
  );

  it("does not stop the extensions listed after it from loading", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    list = [claiming("core"), manifest("1.0.0")];
    serve({ "1.0.0": bundle() });

    await loadExternalPlugins();

    expect(importer).toHaveBeenCalledTimes(1);
    expect(importer).toHaveBeenCalledWith(expect.stringContaining(`/__plugins__/${ID}/`));
    expect(live()).toBe(true);
  });

  it("is not started by turning it on either, and the error says why", async () => {
    const activate = failing();
    list = [claiming("core.tools")];
    serve({ "1.0.0": { activate } });

    await expect(setExtensionEnabled("core.tools", true)).rejects.toThrow(reason("core.tools"));

    expect(importer).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it("is refused on install and rolled back, keeping Safelight's own contributions", async () => {
    const activate = failing();
    registerOwn(CORE_EXTENSION_ID);
    install.mockResolvedValueOnce(claiming(CORE_EXTENSION_ID));
    settleUpdate.mockResolvedValueOnce(null); // nothing to restore
    serve({ "1.0.0": { activate } });

    await expect(installFromGitHub(REPO)).rejects.toThrow(
      `Widget 1.0.0 failed to start (${reason(CORE_EXTENSION_ID)})`,
    );

    expect(settleUpdate).toHaveBeenCalledWith(CORE_EXTENSION_ID, "rollback");
    expect(importer).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(ownerOfSheet(CORE_EXTENSION_ID)).toBe(CORE_EXTENSION_ID);
  });
});

describe("release versions", () => {
  it("installs the latest release when no version is given", async () => {
    await bootWith(bundle());
    serve({ "1.0.0": bundle(), "2.0.0": bundle() });
    await installFromGitHub(REPO);
    expect(install).toHaveBeenCalledWith(REPO);
  });

  it("installs the chosen version", async () => {
    await bootWith(bundle());
    serve({ "1.0.0": bundle(), "2.0.0": bundle() });
    await installFromGitHub(REPO, "2.0.0");
    expect(install).toHaveBeenCalledWith(REPO, "2.0.0");
  });

  it("updates to the version the check offered", async () => {
    await bootWith(bundle());
    serve({ "1.0.0": bundle(), "2.0.0": bundle() });
    await updateExtension(REPO, "2.0.0");
    expect(install).toHaveBeenCalledWith(REPO, "2.0.0");
  });

  it("asks for pre-releases when the installed version is one", async () => {
    await checkExtensionUpdate(manifest("2.0.0-beta.1"), true);
    expect(remoteManifest).toHaveBeenCalledWith(REPO, { prerelease: true });
  });

  it("asks for full releases otherwise", async () => {
    await checkExtensionUpdate(manifest("1.0.0"), true);
    expect(remoteManifest).toHaveBeenCalledWith(REPO);
  });

  it("auto-update installs the version the check found", async () => {
    updateSettings({ autoUpdateExtensions: true });
    await bootWith(bundle());
    serve({ "1.0.0": bundle(), "2.0.0": bundle() });
    await checkAllExtensionUpdates(true);
    expect(install).toHaveBeenCalledWith(REPO, "2.0.0");
  });
});

describe("install queueing", () => {
  /** An install the test settles by hand, so overlap between installs is visible. */
  const held = () => {
    let resolve!: (m: ExtensionManifest) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<ExtensionManifest>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("joins a running install of the same version", async () => {
    await bootWith(bundle());
    serve({ "1.0.0": bundle(), "2.0.0": bundle() });
    const gate = held();
    install.mockImplementationOnce(() => gate.promise);

    const first = installFromGitHub(REPO, "2.0.0");
    const second = installFromGitHub(REPO, "2.0.0");
    gate.resolve(manifest("2.0.0"));

    const [a, b] = await Promise.all([first, second]);
    expect(install).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
  });

  it("queues a different version behind the running install", async () => {
    await bootWith(bundle());
    serve({ "1.0.0": bundle(), "3.0.0": bundle() });
    install.mockImplementation(async (_spec: string, version?: string) =>
      manifest(version ?? "2.0.0"),
    );
    const gate = held();
    install.mockImplementationOnce(() => gate.promise);

    const first = installFromGitHub(REPO, "3.0.0");
    const second = installFromGitHub(REPO, "1.0.0");
    await tick();
    expect(install).toHaveBeenCalledTimes(1);

    gate.resolve(manifest("3.0.0"));
    expect((await first).version).toBe("3.0.0");
    expect((await second).version).toBe("1.0.0");
    expect(install).toHaveBeenLastCalledWith(REPO, "1.0.0");
  });

  it("runs a queued install after the running one fails", async () => {
    await bootWith(bundle());
    serve({ "1.0.0": bundle(), "3.0.0": bundle() });
    install.mockImplementation(async (_spec: string, version?: string) =>
      manifest(version ?? "2.0.0"),
    );
    const gate = held();
    install.mockImplementationOnce(() => gate.promise);

    const first = installFromGitHub(REPO, "3.0.0");
    const second = installFromGitHub(REPO, "1.0.0").catch((e: Error) => e);
    gate.reject(new Error("offline"));

    await expect(first).rejects.toThrow("offline");
    expect(await second).toMatchObject({ version: "1.0.0" });
    expect(install).toHaveBeenLastCalledWith(REPO, "1.0.0");
  });

  it("joins a queued install of the same version instead of queuing a second", async () => {
    await bootWith(bundle());
    serve({ "1.0.0": bundle(), "3.0.0": bundle() });
    install.mockImplementation(async (_spec: string, version?: string) =>
      manifest(version ?? "2.0.0"),
    );
    const gate = held();
    install.mockImplementationOnce(() => gate.promise);

    const running = installFromGitHub(REPO, "3.0.0");
    const queued = installFromGitHub(REPO, "1.0.0");
    const joiner = installFromGitHub(REPO, "1.0.0");
    gate.resolve(manifest("3.0.0"));

    expect(await joiner).toBe(await queued);
    await running;
    expect(install.mock.calls.filter(([, v]) => v === "1.0.0")).toHaveLength(1);
  });
});

describe("kept versions", () => {
  beforeEach(() => usePins.setState({ pins: {} }));

  it("auto-update leaves a kept extension alone", async () => {
    updateSettings({ autoUpdateExtensions: true });
    setKept(ID, "1.0.0");
    await bootWith(bundle());
    await checkAllExtensionUpdates(true);
    expect(install).not.toHaveBeenCalled();
    expect(useExtStoreUI.getState().updates[ID]?.hasUpdate).toBe(true);
  });

  it("updating stops keeping the old version", async () => {
    setKept(ID, "1.0.0");
    await bootWith(bundle());
    serve({ "1.0.0": bundle(), "2.0.0": bundle() });
    await updateExtension(REPO, "2.0.0");
    expect(keptVersion(ID)).toBeNull();
  });

  it("uninstalling forgets the kept version", async () => {
    setKept(ID, "1.0.0");
    await uninstallPlugin(ID);
    expect(keptVersion(ID)).toBeNull();
  });
});
