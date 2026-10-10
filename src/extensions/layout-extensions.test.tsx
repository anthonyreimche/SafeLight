// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Saved layouts remember which panel and tool extensions are on, and turning
// extensions on and off runs one change at a time. Drives the real loader and
// dock through the stubbed Electron bridge (window.safelightNative), with only
// the bundle import — an app:// URL jsdom cannot fetch — substituted, as in
// loader.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ExtensionManifest, ExtensionModule, SafelightAPI } from "./types";
import { useRegistry } from "./registry";
import { useTrust } from "./trust";
import { importPluginModule } from "./plugin-module";
import { BUILTIN_EXTENSIONS } from "./builtin";
import { noteExtensionRunning } from "./extension-kinds";
import {
  loadExternalPlugins,
  setExtensionEnabled,
  uninstallPlugin,
  useDisabledExtensions,
} from "./loader";
import {
  CUSTOM_LAYOUT,
  addUserLayout,
  applyDockLayout,
  updateUserLayout,
  useDockStore,
  useLayoutStore,
  useUserLayouts,
} from "./dock";

vi.mock("./plugin-module", () => ({ importPluginModule: vi.fn() }));

const Empty = () => null;

interface Bundle extends ExtensionModule {
  activate: Mock<(api: SafelightAPI) => void>;
  deactivate: Mock<() => void>;
}

/** A bundle whose only contribution is a panel, `${id}.view`, docked on
 *  Develop's left rail; the panel's presence says whether it is running. */
const panelBundle = (id: string): Bundle => ({
  activate: vi.fn((api: SafelightAPI) =>
    api.registerPanel({
      id: `${id}.view`,
      title: id,
      component: Empty,
      defaultDock: { module: "develop", direction: "left" },
    }),
  ),
  deactivate: vi.fn(),
});

/** A bundle that renders into photos through what `register` contributes. */
const pixelBundle = (register: (api: SafelightAPI) => void): Bundle => ({
  activate: vi.fn(register),
  deactivate: vi.fn(),
});
const stageBundle = (id: string) =>
  pixelBundle((api) =>
    api.registerProcessingStage({
      id: `${id}.grade`,
      name: "Grade",
      phase: "effects",
      glsl: "",
      uniforms: [],
    }),
  );
const transformBundle = (id: string) =>
  pixelBundle((api) => api.registerPipeline({ id: `${id}.look`, name: "Look" }));
const exportBundle = (id: string) =>
  pixelBundle((api) =>
    api.registerExportProcessor({ id: `${id}.mark`, label: "Mark", process: async (b) => b }),
  );

const manifest = (id: string): ExtensionManifest => ({
  id,
  name: id,
  version: "1.0.0",
  main: "index.js",
  repository: `acme/${id.split(".")[1]}`,
});

const running = (id: string) => `${id}.view` in useRegistry.getState().panels;

/** Holds a bundle's import until `open()`: an extension still starting. */
function held(mod: Bundle) {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { mod: opened.then(() => mod), open };
}

const importer = vi.mocked(importPluginModule);
let installed: ExtensionManifest[];
let bundles: Record<string, Bundle | Promise<Bundle>>;
/** Every id a test installed, removed from disk since or not. */
let touched: string[];

/** Install `id` running `bundle` (served to the import by id). */
function install(id: string, bundle: Bundle | Promise<Bundle>): void {
  installed.push(manifest(id));
  bundles[id] = bundle;
  touched.push(id);
}

/** Its files are gone, as when deleted outside Safelight; nothing else knows. */
function removeFromDisk(id: string): void {
  installed = installed.filter((m) => m.id !== id);
}

const trustBefore = useTrust.getState().list;

beforeEach(() => {
  localStorage.clear();
  installed = [];
  bundles = {};
  touched = [];
  vi.stubGlobal("safelightNative", {
    plugins: {
      list: async () => installed,
      uninstall: vi.fn(async () => {}),
    },
  });
  importer.mockReset();
  importer.mockImplementation(async (url) => {
    const id = new URL(url).pathname.split("/")[2];
    const bundle = bundles[id];
    if (!bundle) throw new Error(`no bundle for ${url}`);
    return bundle;
  });
  useRegistry.setState({ panels: {}, processingStages: {}, pipelines: {}, exportProcessors: {} });
  useDisabledExtensions.setState({ ids: [] });
  useUserLayouts.setState({ layouts: {} });
  void applyDockLayout(CUSTOM_LAYOUT);
});

afterEach(async () => {
  // The loader's map of running bundles outlives a test.
  for (const id of touched) await uninstallPlugin(id);
  useTrust.setState({ list: trustBefore });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const remembered = (layoutId: string) =>
  useUserLayouts.getState().layouts[layoutId]?.extensions;

describe("what a saved layout remembers", () => {
  it("records panel and tool extensions as on or off, and nothing that renders into photos", async () => {
    install("acme.panel", panelBundle("acme.panel"));
    install("acme.tool", panelBundle("acme.tool"));
    install("acme.film", stageBundle("acme.film"));
    install("acme.look", transformBundle("acme.look"));
    install("acme.export", exportBundle("acme.export"));
    await loadExternalPlugins();
    await setExtensionEnabled("acme.tool", false);
    await setExtensionEnabled("acme.film", false);
    // Safelight's own that a layout never switches, seen running earlier.
    for (const id of ["core", "core.accessibility", "core.devtools"]) noteExtensionRunning(id);
    await setExtensionEnabled("core.devtools", false);

    const id = addUserLayout("Culling");

    expect(remembered(id)).toEqual({ "acme.panel": true, "acme.tool": false });
  });

  it("leaves out an installed extension it has never seen running", async () => {
    install("acme.panel", panelBundle("acme.panel"));
    install("acme.idle", panelBundle("acme.idle"));
    useDisabledExtensions.setState({ ids: ["acme.idle"] });
    await loadExternalPlugins();

    const id = addUserLayout();

    expect(remembered(id)).toEqual({ "acme.panel": true });
  });

  it("refreshes what it remembers when the layout is updated", async () => {
    install("acme.panel", panelBundle("acme.panel"));
    install("acme.tool", panelBundle("acme.tool"));
    await loadExternalPlugins();
    const id = addUserLayout();

    await setExtensionEnabled("acme.tool", false);
    updateUserLayout(id);

    expect(remembered(id)).toEqual({ "acme.panel": true, "acme.tool": false });
  });

  it("forgets an uninstalled extension in layouts saved afterwards", async () => {
    install("acme.panel", panelBundle("acme.panel"));
    install("acme.tool", panelBundle("acme.tool"));
    await loadExternalPlugins();
    await uninstallPlugin("acme.tool");

    const id = addUserLayout();

    expect(remembered(id)).toEqual({ "acme.panel": true });
  });
});

describe("applying a saved layout", () => {
  const LAYOUT = "user.test";

  /** A layout with no module entries, so the dock is seeded from the defaults of
   *  whatever panels are registered when it is resolved. */
  function saveLayout(extensions?: Record<string, boolean>): void {
    useUserLayouts.setState({
      layouts: { [LAYOUT]: { id: LAYOUT, name: "Test", modules: {}, ...(extensions && { extensions }) } },
    });
  }
  const docked = () => useDockStore.getState().rails.flatMap((r) => r.panels);
  const disabled = () => [...useDisabledExtensions.getState().ids].sort();
  /** Counts writes of the disabled list from here on. */
  function countDisabledWrites(): () => number {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    return () => setItem.mock.calls.filter(([key]) => key === "sl_ext_disabled").length;
  }

  beforeEach(() => useDockStore.setState({ module: "develop" }));

  /** Install and start a panel extension per id, then turn off those in `off`. */
  async function boot(ids: string[], off: string[] = []): Promise<void> {
    for (const id of ids) install(id, panelBundle(id));
    await loadExternalPlugins();
    for (const id of off) await setExtensionEnabled(id, false);
  }

  it("switches its extensions before the dock is rebuilt", async () => {
    await boot(["acme.panel", "acme.tool", "acme.other"], ["acme.tool", "acme.other"]);
    saveLayout({ "acme.panel": false, "acme.tool": true });

    await applyDockLayout(LAYOUT);

    expect(running("acme.panel")).toBe(false);
    expect(running("acme.tool")).toBe(true);
    expect(running("acme.other")).toBe(false);
    expect(disabled()).toEqual(["acme.other", "acme.panel"]);
    expect(docked()).toEqual(["acme.tool.view"]);
    expect(useLayoutStore.getState().activeId).toBe(LAYOUT);
  });

  it("writes the disabled list once for the whole switch", async () => {
    await boot(["acme.a", "acme.b", "acme.c"]);
    saveLayout({ "acme.a": false, "acme.b": false, "acme.c": false });
    const disabledWrites = countDisabledWrites();

    await applyDockLayout(LAYOUT);

    expect(disabledWrites()).toBe(1);
    expect(disabled()).toEqual(["acme.a", "acme.b", "acme.c"]);
  });

  it("leaves alone what is gone, banned or now known to render into photos", async () => {
    await boot(["acme.gone", "acme.banned"]);
    install("acme.film", stageBundle("acme.film"));
    await loadExternalPlugins();
    // Saved while all three were panel extensions to Safelight's knowledge.
    saveLayout({ "acme.gone": false, "acme.banned": false, "acme.film": false });
    removeFromDisk("acme.gone");
    useTrust.setState({ list: { ...trustBefore, repos: ["acme/banned"] } });
    const disabledWrites = countDisabledWrites();

    await applyDockLayout(LAYOUT);

    expect(disabledWrites()).toBe(0);
    expect(disabled()).toEqual([]);
    expect("acme.film.grade" in useRegistry.getState().processingStages).toBe(true);
    expect(useLayoutStore.getState().activeId).toBe(LAYOUT);
  });

  it("switches the rest, and shows the layout, when one extension fails to start", async () => {
    await boot(["acme.broken", "acme.tool"], ["acme.broken", "acme.tool"]);
    bundles["acme.broken"] = pixelBundle(() => {
      throw new Error("boom");
    });
    saveLayout({ "acme.broken": true, "acme.tool": true });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await applyDockLayout(LAYOUT);

    expect(running("acme.tool")).toBe(true);
    expect(useLayoutStore.getState().activeId).toBe(LAYOUT);
    expect(logged).toHaveBeenCalledWith(
      "[extensions] the layout could not switch acme.broken:",
      new Error("boom"),
    );
  });

  it("switches nothing for a layout saved before layouts remembered extensions", async () => {
    await boot(["acme.panel", "acme.tool"], ["acme.tool"]);
    saveLayout();
    const disabledWrites = countDisabledWrites();

    await applyDockLayout(LAYOUT);

    expect(disabledWrites()).toBe(0);
    expect(running("acme.panel")).toBe(true);
    expect(running("acme.tool")).toBe(false);
    expect(useLayoutStore.getState().activeId).toBe(LAYOUT);
  });

  it("lets a later choice win over a layout still switching extensions", async () => {
    await boot(["acme.tool"], ["acme.tool"]);
    const start = held(panelBundle("acme.tool"));
    bundles["acme.tool"] = start.mod;
    saveLayout({ "acme.tool": true });

    const switching = applyDockLayout(LAYOUT);
    void applyDockLayout(CUSTOM_LAYOUT);
    start.open();
    await switching;

    expect(useLayoutStore.getState().activeId).toBe(CUSTOM_LAYOUT);
    expect(running("acme.tool")).toBe(true);
  });
});

describe("turning an extension on and off", () => {
  it("ends off and stopped when turned off while it is still starting", async () => {
    const bundle = panelBundle("acme.tool");
    const start = held(bundle);
    install("acme.tool", start.mod);
    useDisabledExtensions.setState({ ids: ["acme.tool"] });

    const on = setExtensionEnabled("acme.tool", true);
    const off = setExtensionEnabled("acme.tool", false);
    start.open();
    await Promise.all([on, off]);

    expect(useDisabledExtensions.getState().ids).toEqual(["acme.tool"]);
    expect(running("acme.tool")).toBe(false);
    expect(bundle.deactivate).toHaveBeenCalledTimes(bundle.activate.mock.calls.length);
  });

  it("starts once when turned on twice while it is still starting", async () => {
    const bundle = panelBundle("acme.tool");
    const start = held(bundle);
    install("acme.tool", start.mod);
    useDisabledExtensions.setState({ ids: ["acme.tool"] });

    const first = setExtensionEnabled("acme.tool", true);
    const second = setExtensionEnabled("acme.tool", true);
    start.open();
    await Promise.all([first, second]);

    expect(bundle.activate).toHaveBeenCalledTimes(1);
    expect(running("acme.tool")).toBe(true);
  });

  it("ends off when turned off while launch is still loading it", async () => {
    const bundle = panelBundle("acme.tool");
    const start = held(bundle);
    install("acme.tool", start.mod);

    const launch = loadExternalPlugins();
    await vi.waitFor(() => expect(importer).toHaveBeenCalled());
    const off = setExtensionEnabled("acme.tool", false);
    start.open();
    await Promise.all([launch, off]);

    expect(running("acme.tool")).toBe(false);
    expect(bundle.deactivate).toHaveBeenCalledTimes(bundle.activate.mock.calls.length);
  });

  it("starts a built-in once when it is turned on twice", async () => {
    const hsl = BUILTIN_EXTENSIONS.find((b) => b.id === "core.hsl")!;
    const activate = vi.spyOn(hsl, "activate");
    try {
      useDisabledExtensions.setState({ ids: ["core.hsl"] });
      await Promise.all([
        setExtensionEnabled("core.hsl", true),
        setExtensionEnabled("core.hsl", true),
      ]);
      expect(activate).toHaveBeenCalledTimes(1);
    } finally {
      await setExtensionEnabled("core.hsl", false);
      activate.mockRestore();
    }
  });
});
