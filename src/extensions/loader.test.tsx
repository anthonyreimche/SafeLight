// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension update safety: a newer version must never cost the user the version
// that works. Classification is pure; the lifecycle tests drive the real loader
// through the stubbed Electron bridge (window.safelightNative), with only the
// bundle import — an app:// URL jsdom cannot fetch — substituted.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import "./host";
import type {
  ExtensionManifest,
  ExtensionModule,
  NativePluginsBridge,
  SafelightAPI,
} from "./types";
import { registerModule, registerStylesheet, unregisterExtension, useRegistry } from "./registry";
import { CORE_EXTENSION_ID } from "./core-extension";
import { BUILTIN_EXTENSIONS, type BuiltinExtension } from "./builtin";
import { EXTENSION_TIMEOUT_MS } from "./guard";
import { rememberSource } from "./sources";
import { useExtStoreUI, type ExtUpdateInfo } from "./store-ui";
import { updateSettings } from "@/state/settings-store";
import { useUIStore } from "@/state/ui-store";
import { useProjectStore } from "@/project/project-store";
import { App } from "@/App";
import {
  registerEssentialModules,
  unregisterEssentialModules,
} from "@/test/essential-modules.test-support";
import { importPluginModule } from "./plugin-module";
import {
  checkAllExtensionUpdates,
  checkExtensionUpdate,
  classifyUpdate,
  installFromGitHub,
  isPluginRunning,
  keepsAcrossLayouts,
  layoutExtensionChoices,
  loadBuiltins,
  loadExternalPlugins,
  setExtensionEnabled,
  restoreDisplacedPlugins,
  uninstallPlugin,
  updateExtension,
  InstallSupersededError,
  useDisabledExtensions,
  usePluginRunning,
  useExternalPluginsSettled,
} from "./loader";
import { keptVersion, setKept, usePins } from "./pins";
import { getExtSetting, setExtSetting } from "./ext-settings";
import { isInstanceLive, startInstance, stopInstances } from "./instance";

vi.mock("./plugin-module", () => ({ importPluginModule: vi.fn() }));

// The install bridge is the privileged one core claims at boot, not part of
// window.safelightNative.
let privilegedBridge: NativePluginsBridge | null = null;
vi.mock("@/native/privileged", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/native/privileged")>()),
  privilegedPlugins: () => privilegedBridge,
}));

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
  privilegedBridge = { install, uninstall: vi.fn(async () => {}), settleUpdate };
  vi.stubGlobal("safelightNative", {
    plugins: { list: async () => list, remoteManifest },
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
    registerEssentialModules();
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

  it("returns from the first other tab when Library and Develop aren't installed", async () => {
    unregisterEssentialModules();
    await bootWith(withModule("1.0.0"));
    registerModule("other", { id: "zoom", label: "Zoom", component: () => <p>zoom</p> });
    const next = held(withModule("2.0.0"));
    serve({ "2.0.0": next.mod });
    render(<App />);
    let update!: Promise<ExtensionManifest>;
    await act(async () => {
      update = updateExtension(REPO);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(useUIStore.getState().activeModule).toBe("zoom");

    await act(async () => {
      next.open();
      await update;
    });
    expect(useUIStore.getState().activeModule).toBe("widget");
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

  it("leaves a disabled id disabled and not running when asked not to enable it", async () => {
    useDisabledExtensions.setState({ ids: [ID] });
    install.mockResolvedValueOnce(manifest("1.0.0"));
    serve({ "1.0.0": bundle() });
    await installFromGitHub(REPO, undefined, { enable: false });
    expect(useDisabledExtensions.getState().ids).toContain(ID);
    expect(live()).toBe(false);
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

// The bundles of every installed extension are imported up front, a few at a
// time, but the extensions themselves start one after another in list order, so
// panels and registry entries land in the same order on every launch.
describe("loading several installed extensions", () => {
  const COUNT = 10;
  // Long enough for the slowest way of loading them; the clock is not real.
  const SETTLE_MS = 120_000;
  const ids = Array.from({ length: COUNT }, (_, i) => `acme.ext${i}`);
  const entry = (id: string): ExtensionManifest => ({
    id,
    name: id,
    version: "1.0.0",
    main: "index.js",
    repository: `acme/${id}`,
  });
  const idOf = (url: string) => url.split("/__plugins__/")[1].split("/")[0];

  let activated: string[];
  /** A bundle that notes when it starts, and registers one stylesheet. */
  const noting = (id: string): ExtensionModule => ({
    activate: (api: SafelightAPI) => {
      activated.push(id);
      api.registerStylesheet({ id: `${id}.css`, css: ".x{}" });
    },
  });

  beforeEach(() => {
    activated = [];
    list = ids.map(entry);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const id of ids) await uninstallPlugin(id);
  });

  it("activates them in list order whichever bundle arrives first", async () => {
    vi.useFakeTimers();
    importer.mockImplementation(
      (url) =>
        new Promise((resolve) => {
          const id = idOf(url);
          setTimeout(() => resolve(noting(id)), 100 * (COUNT - ids.indexOf(id)));
        }),
    );

    const loading = loadExternalPlugins();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await loading;

    expect(activated).toEqual(ids);
  });

  it("imports no more than six bundles at a time", async () => {
    vi.useFakeTimers();
    let importing = 0;
    let most = 0;
    importer.mockImplementation(
      (url) =>
        new Promise((resolve) => {
          most = Math.max(most, ++importing);
          setTimeout(() => {
            importing--;
            resolve(noting(idOf(url)));
          }, 100);
        }),
    );

    const loading = loadExternalPlugins();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await loading;

    expect(most).toBe(6);
    expect(activated).toEqual(ids);
  });

  it("takes ten bundles that each import in 100 ms in two rounds, not ten", async () => {
    vi.useFakeTimers();
    importer.mockImplementation(
      (url) => new Promise((resolve) => setTimeout(() => resolve(noting(idOf(url))), 100)),
    );
    const started = Date.now();
    let elapsed = -1;

    void loadExternalPlugins().then(() => {
      elapsed = Date.now() - started;
    });
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    console.info(`[extension-loading] ${COUNT} bundles, 100 ms import each: ${elapsed} ms`);
    // Taken one after the other: 10 × 100 ms = 1000 ms.
    expect(elapsed).toBe(200);
  });

  it("does not start one the user turned off while its bundle was importing", async () => {
    let arrive!: (mod: Partial<ExtensionModule>) => void;
    importer.mockImplementation((url) => {
      const id = idOf(url);
      return id === ids[1] ? new Promise((resolve) => (arrive = resolve)) : Promise.resolve(noting(id));
    });

    const loading = loadExternalPlugins();
    await vi.waitFor(() => expect(activated).toEqual([ids[0]]));
    const turnedOff = setExtensionEnabled(ids[1], false);
    arrive(noting(ids[1]));
    await loading;
    await turnedOff;

    expect(activated).not.toContain(ids[1]);
    expect(isInstanceLive(ids[1])).toBe(false);
    expect(activated).toEqual(ids.filter((id) => id !== ids[1]));
  });

  it("reports a failed import at that extension's turn and starts the rest", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("no such bundle");
    importer.mockImplementation((url) => {
      const id = idOf(url);
      return id === ids[2] ? Promise.reject(failure) : Promise.resolve(noting(id));
    });

    await loadExternalPlugins();

    expect(activated).toEqual(ids.filter((id) => id !== ids[2]));
    expect(error).toHaveBeenCalledWith(expect.stringContaining(ids[2]), failure);
    expect(isInstanceLive(ids[2])).toBe(false);
  });

  it("imports a bundle at its own turn when hung imports hold every slot", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    importer.mockImplementation((url) => {
      const id = idOf(url);
      return ids.indexOf(id) < 6 ? new Promise(() => {}) : Promise.resolve(noting(id));
    });

    const loading = loadExternalPlugins();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await loading;

    expect(activated).toEqual(ids.slice(6));
  });
});

// Ids under "safelight" belong to the official extensions: one starts only when
// electron/official-extensions.json lists it and its manifest names that row's
// repository, so nobody else can publish under an official id.
describe("an installed extension whose id is under safelight", () => {
  const OFFICIAL = "safelight.basic";
  const reason = (id: string) =>
    `${id}: extension ids under 'safelight' are reserved for Safelight's official extensions`;
  const claiming = (id: string, repository?: string): ExtensionManifest => ({
    id,
    name: "Basic",
    version: "1.0.0",
    main: "index.js",
    repository,
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await uninstallPlugin(OFFICIAL);
  });

  it.each([
    ["no", undefined],
    ["another", "acme/basic-adjustments"],
    ["another official", "anthonyreimche/hsl"],
  ])("is not imported or activated with %s repository", async (_label, repository) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const activate = vi.fn();
    list = [claiming(OFFICIAL, repository)];
    serve({ "1.0.0": { activate } });

    await loadExternalPlugins();

    expect(importer).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.any(String), new Error(reason(OFFICIAL)));
  });

  it("is not started when the list doesn't have its id", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    list = [claiming("safelight.unlisted", "anthonyreimche/unlisted")];
    serve({ "1.0.0": bundle() });

    await loadExternalPlugins();

    expect(importer).not.toHaveBeenCalled();
  });

  it("starts from the repository its list row names", async () => {
    list = [claiming(OFFICIAL, "AnthonyReimche/Basic-Adjustments")];
    serve({ "1.0.0": bundle() });

    await loadExternalPlugins();

    expect(importer).toHaveBeenCalledWith(expect.stringContaining(`/__plugins__/${OFFICIAL}/`));
    expect(live()).toBe(true);
  });
});

// Saved layouts leave alone the built-ins that say so, and an installed official
// extension whose list row says so. A manifest can't claim it for itself.
describe("keepsAcrossLayouts", () => {
  it.each([
    ["core.basic", false],
    ["safelight.accessibility", true],
    ["safelight.devtools", true],
    ["safelight.basic", false],
    [ID, false],
  ])("is %s → %s", (id, kept) => {
    expect(keepsAcrossLayouts(id)).toBe(kept);
  });

  it("holds an installed official extension a layout must keep", () => {
    const official: ExtensionManifest = {
      id: "safelight.accessibility",
      name: "Accessibility (installed)",
      version: "1.0.0",
      main: "index.js",
      repository: "anthonyreimche/accessibility",
    };
    const claims = { ...manifest("1.0.0"), keepAcrossLayouts: true } as ExtensionManifest;
    const choices = layoutExtensionChoices([official, claims]);
    const hold = (id: string) => choices.find((c) => c.id === id)?.hold;
    expect(hold("safelight.accessibility")).toBe("kept");
    expect(hold(ID)).not.toBe("kept");
  });
});

// One extension that fails to start, or never finishes starting, must not stop
// the rest from starting: it is swept, logged and left off.
describe("an extension that fails to start", () => {
  const OTHER = "acme.other";
  const OTHER_SHEET = "acme.other.css";
  const otherManifest: ExtensionManifest = {
    id: OTHER,
    name: "Other",
    version: "1.0.0",
    main: "index.js",
    repository: "acme/other",
  };
  const otherLive = () => OTHER_SHEET in useRegistry.getState().stylesheets;
  const otherBundle = (): ExtensionModule => ({
    activate: (api: SafelightAPI) => api.registerStylesheet({ id: OTHER_SHEET, css: ".o{}" }),
  });
  /** Serve Other's bundle, and `widget` for the Widget. */
  const serveBoth = (widget: () => Promise<Partial<ExtensionModule>>) =>
    importer.mockImplementation((url) =>
      url.includes(`/__plugins__/${OTHER}/`) ? Promise.resolve(otherBundle()) : widget(),
    );
  /** A start that rejects after registering a stylesheet. */
  const rejecting = (api: SafelightAPI): Promise<void> => {
    api.registerStylesheet({ id: GHOST, css: ".g{}" });
    return Promise.reject(new Error("late boom"));
  };
  const timedOut = new Error(`${ID} did not finish within ${EXTENSION_TIMEOUT_MS / 1000} s`);

  let error: MockInstance<typeof console.error>;
  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await uninstallPlugin(OTHER);
  });

  describe("as a built-in", () => {
    const added: BuiltinExtension[] = [];
    const addBuiltin = (
      id: string,
      activate: BuiltinExtension["activate"],
      deactivate?: () => void,
    ) => {
      const builtin: BuiltinExtension = { id, name: id, version: "1.0.0", activate, deactivate };
      BUILTIN_EXTENSIONS.push(builtin);
      added.push(builtin);
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));

    afterEach(() => {
      for (const builtin of added.splice(0)) {
        BUILTIN_EXTENSIONS.splice(BUILTIN_EXTENSIONS.indexOf(builtin), 1);
        unregisterExtension(builtin.id);
      }
    });

    it("that throws is swept and logged, and the built-ins after it still start", async () => {
      addBuiltin("core.broken", (api) => {
        api.registerStylesheet({ id: GHOST, css: ".g{}" });
        throw new Error("boom");
      });
      addBuiltin("core.fine", (api) => api.registerStylesheet({ id: SHEET, css: ".a{}" }));

      expect(() => loadBuiltins()).not.toThrow();
      await flush();

      expect(live()).toBe(true);
      expect(ghost()).toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("core.broken"), new Error("boom"));
    });

    it("whose deactivate throws is still turned off and swept", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      addBuiltin(
        "core.sticky",
        (api) => api.registerStylesheet({ id: SHEET, css: ".a{}" }),
        () => {
          throw new Error("stuck");
        },
      );
      loadBuiltins();

      await expect(setExtensionEnabled("core.sticky", false)).resolves.toBeUndefined();
      expect(live()).toBe(false);
    });
  });

  it("is swept and not running when its activate rejects", async () => {
    serve({ "1.0.0": { activate: rejecting } });

    await loadExternalPlugins();

    expect(isPluginRunning(ID)).toBe(false);
    expect(ghost()).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.any(String), new Error("late boom"));
  });

  it("is given up on when its bundle never finishes importing, and the next one starts", async () => {
    vi.useFakeTimers();
    list = [manifest("1.0.0"), otherManifest];
    let arrive!: (mod: Partial<ExtensionModule>) => void;
    serveBoth(() => new Promise((resolve) => (arrive = resolve)));

    const loading = loadExternalPlugins();
    await vi.advanceTimersByTimeAsync(EXTENSION_TIMEOUT_MS);
    await loading;

    expect(otherLive()).toBe(true);
    expect(isPluginRunning(ID)).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.any(String), timedOut);
    arrive(bundle()); // lets the next test start the Widget from this bundle again
    await vi.advanceTimersByTimeAsync(0);
  });

  it("is not started when its bundle arrives after the time is up", async () => {
    vi.useFakeTimers();
    const activate = vi.fn();
    let arrive!: (mod: Partial<ExtensionModule>) => void;
    importer.mockImplementation(() => new Promise((resolve) => (arrive = resolve)));

    const loading = loadExternalPlugins();
    await vi.advanceTimersByTimeAsync(EXTENSION_TIMEOUT_MS);
    await loading;
    arrive({ activate });
    await vi.advanceTimersByTimeAsync(0);

    expect(activate).not.toHaveBeenCalled();
    expect(isPluginRunning(ID)).toBe(false);
  });

  it("is swept when its activate never finishes, and what it registers late is swept too", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    list = [manifest("1.0.0"), otherManifest];
    serveBoth(async () => ({
      activate: async (api: SafelightAPI) => {
        api.registerStylesheet({ id: SHEET, css: ".a{}" });
        await gate;
        api.registerStylesheet({ id: GHOST, css: ".g{}" });
      },
    }));

    const loading = loadExternalPlugins();
    await vi.advanceTimersByTimeAsync(EXTENSION_TIMEOUT_MS);
    await loading;
    expect(live()).toBe(false);
    expect(otherLive()).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.any(String), timedOut);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(ghost()).toBe(false);
    expect(isPluginRunning(ID)).toBe(false);
  });

  it("can't touch the copy restored after it while it finishes late", async () => {
    vi.useFakeTimers();
    let finishNew!: () => void;
    let finishRestored!: () => void;
    const newGate = new Promise<void>((resolve) => (finishNew = resolve));
    const restoredGate = new Promise<void>((resolve) => (finishRestored = resolve));
    const restored = {
      activate: async (api: SafelightAPI) => {
        api.registerStylesheet({ id: SHEET, css: ".a{}" });
        await restoredGate;
      },
      deactivate: vi.fn(),
    };
    const overtaken = {
      activate: async (api: SafelightAPI) => {
        await newGate;
        api.registerStylesheet({ id: GHOST, css: ".g{}" });
      },
      deactivate: vi.fn(),
    };
    await bootWith(bundle());
    serve({ "1.0.0": restored, "2.0.0": overtaken });

    const update = updateExtension(REPO).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(EXTENSION_TIMEOUT_MS);
    expect(live()).toBe(true); // the restored 1.0.0, still starting

    finishNew();
    await vi.advanceTimersByTimeAsync(0);
    expect(live()).toBe(true);
    expect(ghost()).toBe(false);
    expect(restored.deactivate).not.toHaveBeenCalled();
    expect(overtaken.deactivate).toHaveBeenCalledOnce(); // its timers and listeners stop too

    finishRestored();
    expect(await update).toMatchObject({ message: expect.stringContaining("1.0.0 was restored") });
    expect(isPluginRunning(ID)).toBe(true);
  });

  it("is not started again from the same bundle while its timed-out start is still running", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const activate = vi.fn(async () => {
      await gate;
    });
    serve({ "1.0.0": { activate } });

    const loading = loadExternalPlugins();
    await vi.advanceTimersByTimeAsync(EXTENSION_TIMEOUT_MS);
    await loading;
    await setExtensionEnabled(ID, false);
    await expect(setExtensionEnabled(ID, true)).rejects.toThrow(
      `${ID} is still finishing a start that timed out`,
    );
    expect(activate).toHaveBeenCalledOnce();

    finish();
    await vi.advanceTimersByTimeAsync(0);
    serve({ "1.0.0": bundle() });
    await setExtensionEnabled(ID, false);
    await setExtensionEnabled(ID, true);
    expect(isPluginRunning(ID)).toBe(true);
  });
});

describe("an extension whose deactivate throws", () => {
  const sticky = (): ExtensionModule => ({
    activate: bundle().activate,
    deactivate: () => {
      throw new Error("stuck");
    },
  });

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("is still updated", async () => {
    const v1 = sticky();
    await bootWith(v1);
    serve({ "1.0.0": v1, "2.0.0": bundle() });
    await expect(updateExtension(REPO)).resolves.toMatchObject({ version: "2.0.0" });
    expect(settleUpdate).toHaveBeenCalledWith(ID, "keep");
    expect(live()).toBe(true);
  });

  it("is still rolled back when the new version fails to start", async () => {
    const v1 = sticky();
    await bootWith(v1);
    serve({ "1.0.0": v1, "2.0.0": broken() });
    await expect(updateExtension(REPO)).rejects.toThrow("1.0.0 was restored");
    expect(settleUpdate).toHaveBeenCalledWith(ID, "rollback");
    expect(live()).toBe(true);
  });

  it("is still turned off and swept", async () => {
    await bootWith(sticky());
    await expect(setExtensionEnabled(ID, false)).resolves.toBeUndefined();
    expect(live()).toBe(false);
    expect(isPluginRunning(ID)).toBe(false);
  });
});

// What an extension was installed from is remembered in localStorage, which any
// extension can write, so auto-update goes by the repository the installed
// safelight.json names when it names one, and installs nothing that turns out
// to be another id.
describe("auto-update's repository", () => {
  beforeEach(() => updateSettings({ autoUpdateExtensions: true }));
  afterEach(() => vi.restoreAllMocks());

  it("is the one the update check asks about too, and a stale offer from another goes", async () => {
    rememberSource(ID, "evil/widget");
    useExtStoreUI.getState().setUpdate(ID, {
      latestTag: "9.0.0",
      hasUpdate: true,
      requiresApp: null,
      failed: null,
      checkedAt: Date.now(),
    });
    await expect(checkExtensionUpdate(manifest("1.0.0"), true)).resolves.toBeNull();
    expect(remoteManifest).not.toHaveBeenCalled();
    expect(useExtStoreUI.getState().updates[ID]).toBeUndefined();
  });

  it("is not a remembered source the manifest doesn't name", async () => {
    await bootWith(bundle());
    rememberSource(ID, "evil/widget");
    await checkAllExtensionUpdates(true);
    expect(install).not.toHaveBeenCalled();
  });

  it("follows a remembered source that names the manifest's repository", async () => {
    await bootWith(bundle());
    serve({ "1.0.0": bundle(), "2.0.0": bundle() });
    rememberSource(ID, "Acme/Widget");
    await checkAllExtensionUpdates(true);
    expect(install).toHaveBeenCalledWith(REPO, "2.0.0");
  });

  it("is the remembered source for a manifest that names none", async () => {
    list = [{ ...manifest("1.0.0"), repository: undefined }];
    await bootWith(bundle());
    serve({ "1.0.0": bundle(), "2.0.0": bundle() });
    rememberSource(ID, REPO);
    await checkAllExtensionUpdates(true);
    expect(install).toHaveBeenCalledWith(REPO, "2.0.0");
  });
});

describe("an update whose download is another extension", () => {
  const IMPOSTOR = "acme.impostor";
  const impostor = (): ExtensionManifest => ({ ...manifest("2.0.0"), id: IMPOSTOR });

  afterEach(() => vi.restoreAllMocks());

  it("is rolled back and never started", async () => {
    await bootWith(bundle());
    install.mockResolvedValueOnce(impostor());
    settleUpdate.mockResolvedValueOnce(null);

    await expect(updateExtension(REPO, "2.0.0", ID)).rejects.toThrow(
      `${REPO} holds ${IMPOSTOR}, not ${ID}`,
    );

    expect(settleUpdate).toHaveBeenCalledWith(IMPOSTOR, "rollback");
    expect(settleUpdate).not.toHaveBeenCalledWith(ID, expect.anything());
    expect(importer).toHaveBeenCalledTimes(1); // the boot's import of 1.0.0
    expect(live()).toBe(true);
  });

  it("is refused by auto-update", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    updateSettings({ autoUpdateExtensions: true });
    await bootWith(bundle());
    install.mockResolvedValueOnce(impostor());
    settleUpdate.mockResolvedValueOnce(null);

    await checkAllExtensionUpdates(true);

    expect(settleUpdate).toHaveBeenCalledWith(IMPOSTOR, "rollback");
    expect(live()).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(ID), expect.any(Error));
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

  it("queues a different version behind the running install, which then never starts and answers with the newer one", async () => {
    const v3 = bundle();
    await bootWith(bundle());
    serve({ "1.0.0": bundle(), "3.0.0": v3 });
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
    expect((await first).version).toBe("1.0.0");
    expect(settleUpdate).toHaveBeenCalledWith(ID, "rollback");
    expect(await second).toBe(await first);
    expect(install).toHaveBeenLastCalledWith(REPO, "1.0.0");
    expect(importer.mock.calls.some(([url]) => url.includes("v=3.0.0"))).toBe(false);
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
    expect(await running).toBe(await queued);
    expect(install.mock.calls.filter(([, v]) => v === "1.0.0")).toHaveLength(1);
  });
});

describe("an update overlapping another change to the extension", () => {
  /** A bundle whose import waits for `open()`: a start still under way. */
  const heldBundle = <T,>(mod: T) => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { mod: opened.then(() => mod), open };
  };

  it("ends with only the new version running when it lands while a start is importing", async () => {
    const v1 = { ...bundle(), activate: vi.fn(bundle().activate) };
    const v2 = { ...bundle(), activate: vi.fn(bundle().activate) };
    const start = heldBundle(v1);
    serve({ "1.0.0": start.mod, "2.0.0": v2 });
    useDisabledExtensions.setState({ ids: [ID] });

    const on = setExtensionEnabled(ID, true);
    await vi.waitFor(() => expect(importer).toHaveBeenCalled());
    const update = updateExtension(REPO, "2.0.0", ID);
    start.open();

    await expect(on).resolves.toBeUndefined();
    await expect(update).resolves.toMatchObject({ version: "2.0.0" });
    expect(v1.deactivate).toHaveBeenCalledTimes(v1.activate.mock.calls.length);
    expect(v2.activate).toHaveBeenCalledOnce();
    expect(live()).toBe(true);
  });

  it("ends uninstalled when uninstalled while the update is starting", async () => {
    const v1 = bundle();
    await bootWith(v1);
    const v2 = bundle();
    const start = heldBundle(v2);
    serve({ "1.0.0": v1, "2.0.0": start.mod });

    const update = updateExtension(REPO, "2.0.0", ID);
    await vi.waitFor(() => expect(importer).toHaveBeenCalledTimes(2));
    const gone = uninstallPlugin(ID);
    list = [];
    start.open();
    await Promise.all([update, gone]);

    expect(isPluginRunning(ID)).toBe(false);
    expect(live()).toBe(false);
    expect(v2.deactivate).toHaveBeenCalledOnce();
  });

  /** Make the next download wait for `land()`. */
  const slowDownload = () => {
    let land!: () => void;
    install.mockImplementationOnce(
      () => new Promise<ExtensionManifest>((resolve) => (land = () => resolve(manifest("2.0.0")))),
    );
    return () => land();
  };

  it("is not started, and leaves no files, when uninstalled while it downloads", async () => {
    await bootWith(bundle());
    serve({ "1.0.0": bundle(), "2.0.0": bundle() });
    const land = slowDownload();

    const update = updateExtension(REPO, "2.0.0", ID);
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    await uninstallPlugin(ID);
    list = [];
    land();

    await expect(update).rejects.toThrow(
      new InstallSupersededError(manifest("2.0.0"), "uninstalled"),
    );
    expect(isPluginRunning(ID)).toBe(false);
    expect(live()).toBe(false);
    expect(settleUpdate).toHaveBeenCalledWith(ID, "keep");
    expect(privilegedBridge?.uninstall).toHaveBeenCalledTimes(2);
  });

  it("installs afresh when asked again after being uninstalled while it downloads", async () => {
    await bootWith(bundle());
    serve({ "1.0.0": bundle(), "2.0.0": bundle() });
    const land = slowDownload();

    const first = updateExtension(REPO, "2.0.0", ID);
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    await uninstallPlugin(ID);
    list = [];
    const again = installFromGitHub(REPO, "2.0.0");
    land();

    await expect(first).rejects.toThrow(InstallSupersededError);
    await expect(again).resolves.toMatchObject({ version: "2.0.0" });
    expect(install).toHaveBeenCalledTimes(2);
    expect(live()).toBe(true);
  });

  it("lets other changes run while it downloads", async () => {
    await bootWith(bundle());
    serve({ "1.0.0": bundle(), "2.0.0": bundle() });
    const land = slowDownload();

    const update = updateExtension(REPO, "2.0.0", ID);
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    const toggled = setExtensionEnabled("acme.other", false).then(() => "done");
    const waited = new Promise((r) => setTimeout(() => r("waiting"), 0));

    await expect(Promise.race([toggled, waited])).resolves.toBe("done");
    land();
    await expect(update).resolves.toMatchObject({ version: "2.0.0" });
    expect(live()).toBe(true);
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

describe("usePluginRunning", () => {
  it("follows an installed extension starting, stopping and leaving", async () => {
    const { result } = renderHook(() => usePluginRunning(ID));
    expect(result.current).toBe(false);
    await act(() => bootWith(bundle()));
    expect(result.current).toBe(true);
    await act(() => setExtensionEnabled(ID, false));
    expect(result.current).toBe(false);
    await act(() => setExtensionEnabled(ID, true));
    expect(result.current).toBe(true);
    await act(() => uninstallPlugin(ID));
    expect(result.current).toBe(false);
  });

  it("stays false for an extension that failed to start", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    serve({ "1.0.0": broken() });
    const { result } = renderHook(() => usePluginRunning(ID));
    await act(() => loadExternalPlugins());
    expect(result.current).toBe(false);
    vi.restoreAllMocks();
  });
});

describe("an installed extension and a dev-folder copy of its id", () => {
  const DEV_SHEET = "acme.widget.dev.css";
  const devSheet = () => DEV_SHEET in useRegistry.getState().stylesheets;
  const devCopy = (): ExtensionModule & { deactivate: Mock } => ({
    activate: (api: SafelightAPI) => api.registerStylesheet({ id: DEV_SHEET, css: ".d{}" }),
    deactivate: vi.fn(),
  });
  const startDev = (mod: Partial<ExtensionModule>) =>
    startInstance({
      id: ID,
      source: "dev",
      bundle: "dev:widget",
      read: async () => ({ load: async () => mod }),
    });

  afterEach(() => {
    stopInstances("dev");
  });

  it("starts the installed copy again once the dev copy has unloaded", async () => {
    const installed = bundle();
    await bootWith(installed);
    await startDev(devCopy());
    expect(live()).toBe(false);
    expect(devSheet()).toBe(true);

    stopInstances("dev");
    await restoreDisplacedPlugins();

    expect(devSheet()).toBe(false);
    expect(live()).toBe(true);
    expect(isInstanceLive(ID)).toBe(true);
  });

  it("leaves the installed copy off when the user turned it off meanwhile", async () => {
    await bootWith(bundle());
    await startDev(devCopy());
    await setExtensionEnabled(ID, false);

    stopInstances("dev");
    await restoreDisplacedPlugins();

    expect(live()).toBe(false);
    expect(isInstanceLive(ID)).toBe(false);
  });

  it("does not start the installed copy while the dev copy is still running", async () => {
    await bootWith(bundle());
    const dev = devCopy();
    await startDev(dev);

    await restoreDisplacedPlugins();

    expect(dev.deactivate).not.toHaveBeenCalled();
    expect(devSheet()).toBe(true);
    expect(live()).toBe(false);
  });

  it("is not stopped by turning the installed extension off", async () => {
    await bootWith(bundle());
    const dev = devCopy();
    await startDev(dev);

    await setExtensionEnabled(ID, false);

    expect(dev.deactivate).not.toHaveBeenCalled();
    expect(devSheet()).toBe(true);
  });

  it("is not stopped by updating the installed extension", async () => {
    await bootWith(bundle());
    const dev = devCopy();
    await startDev(dev);
    serve({ "2.0.0": bundle() });

    await updateExtension(REPO, "2.0.0", ID);

    expect(dev.deactivate).not.toHaveBeenCalled();
    expect(devSheet()).toBe(true);
  });

  it("is not stopped by uninstalling the installed extension, and keeps its settings", async () => {
    await bootWith(bundle());
    const dev = devCopy();
    await startDev(dev);
    setExtSetting(ID, "tone", 3);

    await uninstallPlugin(ID);

    expect(dev.deactivate).not.toHaveBeenCalled();
    expect(devSheet()).toBe(true);
    expect(getExtSetting(ID, "tone", 0)).toBe(3);
  });
});
