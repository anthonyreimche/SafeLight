// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Saved layouts the user lets switch extensions turn the panel and tool
// extensions they tick on and the rest off, and turning extensions on and off
// runs one change at a time. Drives the real loader and
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
  initEnablement,
  layoutExtensionChoices,
  loadExternalPlugins,
  setExtensionEnabled,
  uninstallPlugin,
  useDisabledExtensions,
} from "./loader";
import {
  CUSTOM_LAYOUT,
  addUserLayout,
  applyDockLayout,
  setLayoutExtensions,
  setLayoutSwitchesExtensions,
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

const LAYOUT = "user.test";

/** A layout with no module entries, so the dock is seeded from the defaults of
 *  whatever panels are registered when it is resolved. */
function saveLayout(extensions?: Record<string, boolean>, switches = true): void {
  useUserLayouts.setState({
    layouts: {
      [LAYOUT]: {
        id: LAYOUT,
        name: "Test",
        modules: {},
        switchesExtensions: switches,
        ...(extensions && { extensions }),
      },
    },
  });
}
const docked = () => useDockStore.getState().rails.flatMap((r) => r.panels);
const disabled = () => [...useDisabledExtensions.getState().ids].sort();
/** Counts writes of the disabled list from here on. */
function countDisabledWrites(): () => number {
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  return () => setItem.mock.calls.filter(([key]) => key === "sl_ext_disabled").length;
}

/** Install and start a panel extension per id, then turn off those in `off`. */
async function boot(ids: string[], off: string[] = []): Promise<void> {
  for (const id of ids) install(id, panelBundle(id));
  await loadExternalPlugins();
  for (const id of off) await setExtensionEnabled(id, false);
}

beforeEach(() => useDockStore.setState({ module: "develop" }));

describe("a layout's extension switch", () => {
  it("is off for a new layout, which ticks nothing", async () => {
    install("acme.panel", panelBundle("acme.panel"));
    await loadExternalPlugins();

    const id = addUserLayout("Culling");

    expect(useUserLayouts.getState().layouts[id].switchesExtensions).toBeFalsy();
    expect(remembered(id)).toBeUndefined();
  });

  it("is left alone, with its ticks, when the layout is updated", async () => {
    install("acme.panel", panelBundle("acme.panel"));
    install("acme.tool", panelBundle("acme.tool"));
    await loadExternalPlugins();
    const id = addUserLayout();
    setLayoutSwitchesExtensions(id, true);
    await applyDockLayout(CUSTOM_LAYOUT);

    await setExtensionEnabled("acme.tool", false);
    updateUserLayout(id);

    expect(useUserLayouts.getState().layouts[id].switchesExtensions).toBe(true);
    expect(remembered(id)).toEqual({ "acme.panel": true, "acme.tool": true });
  });

  it("ticks panel and tool extensions as they run when turned on, and nothing that renders into photos", async () => {
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
    const disabledWrites = countDisabledWrites();

    setLayoutSwitchesExtensions(id, true);

    expect(remembered(id)).toEqual({ "acme.panel": true, "acme.tool": false });
    expect(disabledWrites()).toBe(0);
  });

  it("leaves out an installed extension it has never seen running", async () => {
    install("acme.panel", panelBundle("acme.panel"));
    install("acme.idle", panelBundle("acme.idle"));
    useDisabledExtensions.setState({ ids: ["acme.idle"] });
    await loadExternalPlugins();
    const id = addUserLayout();

    setLayoutSwitchesExtensions(id, true);

    expect(remembered(id)).toEqual({ "acme.panel": true });
  });

  it("forgets an uninstalled extension", async () => {
    install("acme.panel", panelBundle("acme.panel"));
    install("acme.tool", panelBundle("acme.tool"));
    await loadExternalPlugins();
    await uninstallPlugin("acme.tool");
    const id = addUserLayout();

    setLayoutSwitchesExtensions(id, true);

    expect(remembered(id)).toEqual({ "acme.panel": true });
  });

  it("keeps a layout's saved ticks when turned on for one not showing, filling the rest from what is on", async () => {
    await boot(["acme.panel", "acme.tool", "acme.new"], ["acme.new"]);
    saveLayout({ "acme.panel": false }, false);

    setLayoutSwitchesExtensions(LAYOUT, true);

    expect(remembered(LAYOUT)).toEqual({
      "acme.panel": false,
      "acme.tool": true,
      "acme.new": false,
    });
    expect(running("acme.panel")).toBe(true);
  });

  it("switches extensions to its ticks when the layout is updated while they differ, as picking it would", async () => {
    await boot(["acme.tool"]);
    saveLayout({ "acme.tool": true });
    await setExtensionEnabled("acme.tool", false);

    updateUserLayout(LAYOUT);

    await vi.waitFor(() => expect(running("acme.tool")).toBe(true));
    expect(remembered(LAYOUT)).toEqual({ "acme.tool": true });
    expect(useLayoutStore.getState().activeId).toBe(LAYOUT);
  });

  it("keeps the ticks when turned off, and picking the layout then switches nothing", async () => {
    await boot(["acme.panel"]);
    saveLayout({ "acme.panel": false });

    setLayoutSwitchesExtensions(LAYOUT, false);
    const disabledWrites = countDisabledWrites();
    await applyDockLayout(LAYOUT);

    expect(remembered(LAYOUT)).toEqual({ "acme.panel": false });
    expect(disabledWrites()).toBe(0);
    expect(running("acme.panel")).toBe(true);
  });
});

describe("ticking an extension in a layout", () => {
  it("switches it now in the layout showing", async () => {
    await boot(["acme.panel", "acme.tool"]);
    saveLayout({ "acme.panel": true, "acme.tool": true });
    await applyDockLayout(LAYOUT);

    await setLayoutExtensions(LAYOUT, { "acme.tool": false });

    expect(remembered(LAYOUT)).toEqual({ "acme.panel": true, "acme.tool": false });
    expect(running("acme.tool")).toBe(false);
    expect(disabled()).toEqual(["acme.tool"]);
  });

  it("switches every extension ticked at once with one write of the disabled list", async () => {
    await boot(["acme.a", "acme.b"]);
    saveLayout({ "acme.a": true, "acme.b": true });
    await applyDockLayout(LAYOUT);
    const disabledWrites = countDisabledWrites();

    await setLayoutExtensions(LAYOUT, { "acme.a": false, "acme.b": false });

    expect(disabledWrites()).toBe(1);
    expect(disabled()).toEqual(["acme.a", "acme.b"]);
  });

  it("only saves in a layout not showing", async () => {
    await boot(["acme.tool"]);
    saveLayout({ "acme.tool": true });

    await setLayoutExtensions(LAYOUT, { "acme.tool": false });

    expect(remembered(LAYOUT)).toEqual({ "acme.tool": false });
    expect(running("acme.tool")).toBe(true);
  });

  it("only saves in the layout showing while it doesn't switch extensions", async () => {
    await boot(["acme.tool"]);
    saveLayout({ "acme.tool": true }, false);
    await applyDockLayout(LAYOUT);

    await setLayoutExtensions(LAYOUT, { "acme.tool": false });

    expect(remembered(LAYOUT)).toEqual({ "acme.tool": false });
    expect(running("acme.tool")).toBe(true);
  });
});

describe("applying a saved layout", () => {
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

  it("switches nothing for a layout saved before layouts had the choice", async () => {
    await boot(["acme.panel", "acme.tool"], ["acme.tool"]);
    useUserLayouts.setState({
      layouts: {
        [LAYOUT]: {
          id: LAYOUT,
          name: "Test",
          modules: {},
          extensions: { "acme.panel": false, "acme.tool": true },
        },
      },
    });
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

  it("shows a later pick whose ticks match only once a layout still switching has finished", async () => {
    await boot(["acme.tool"]);
    const layout = (id: string, on: boolean) => ({
      id,
      name: id,
      modules: {},
      switchesExtensions: true,
      extensions: { "acme.tool": on },
    });
    useUserLayouts.setState({
      layouts: { "user.a": layout("user.a", false), "user.b": layout("user.b", true) },
    });

    await Promise.all([applyDockLayout("user.a"), applyDockLayout("user.b")]);

    expect(useLayoutStore.getState().activeId).toBe("user.b");
    expect(running("acme.tool")).toBe(true);
    expect(disabled()).toEqual([]);
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

describe("turning an extension on or off elsewhere", () => {
  it("records it in the layout showing when that layout switches extensions", async () => {
    await boot(["acme.tool"]);
    saveLayout({ "acme.tool": true });
    await applyDockLayout(LAYOUT);

    await setExtensionEnabled("acme.tool", false);

    expect(remembered(LAYOUT)).toEqual({ "acme.tool": false });
  });

  it("records nothing in a layout that doesn't switch, one not showing, or for one that renders into photos", async () => {
    await boot(["acme.tool"]);
    install("acme.film", stageBundle("acme.film"));
    await loadExternalPlugins();
    saveLayout({ "acme.tool": true }, false);
    await applyDockLayout(LAYOUT);
    await setExtensionEnabled("acme.tool", false);
    expect(remembered(LAYOUT)).toEqual({ "acme.tool": true });

    setLayoutSwitchesExtensions(LAYOUT, true);
    await setExtensionEnabled("acme.film", false);
    expect(remembered(LAYOUT)).toEqual({ "acme.tool": false });

    await applyDockLayout(CUSTOM_LAYOUT);
    await setExtensionEnabled("acme.tool", true);
    expect(remembered(LAYOUT)).toEqual({ "acme.tool": false });
  });

  it("records nothing when another window turns it off", async () => {
    initEnablement();
    await boot(["acme.tool"]);
    saveLayout({ "acme.tool": true });
    await applyDockLayout(LAYOUT);

    window.dispatchEvent(
      new StorageEvent("storage", { key: "sl_ext_disabled", newValue: '["acme.tool"]' }),
    );
    await vi.waitFor(() => expect(running("acme.tool")).toBe(false));

    expect(remembered(LAYOUT)).toEqual({ "acme.tool": true });
  });
});

describe("the extensions a layout lists", () => {
  it("lists built-ins but the core and installed ones but banned, saying why a layout won't switch some", async () => {
    install("acme.panel", panelBundle("acme.panel"));
    install("acme.film", stageBundle("acme.film"));
    install("acme.idle", panelBundle("acme.idle"));
    install("acme.banned", panelBundle("acme.banned"));
    useDisabledExtensions.setState({ ids: ["acme.idle"] });
    await loadExternalPlugins();
    noteExtensionRunning("core.hsl");
    useTrust.setState({ list: { ...trustBefore, repos: ["acme/banned"] } });

    const choices = layoutExtensionChoices(installed);
    const hold = (id: string) => choices.find((c) => c.id === id)?.hold;

    expect(hold("acme.panel")).toBeNull();
    expect(hold("core.hsl")).toBeNull();
    expect(hold("acme.film")).toBe("pixels");
    expect(hold("acme.idle")).toBe("unseen");
    expect(hold("core.accessibility")).toBe("kept");
    expect(choices.some((c) => c.id === "core" || c.id === "acme.banned")).toBe(false);
    const names = choices.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
