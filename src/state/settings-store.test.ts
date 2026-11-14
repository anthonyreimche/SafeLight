// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "./settings-store";

type SettingsModule = typeof import("./settings-store");
type StorageListener = (e: StorageEvent) => void;

const KEY = "sl_settings_v1";

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}

/** The three bits of the document applySideEffects writes to. */
interface DomProbe {
  bodyStyle: { zoom: string };
  rootVars: Map<string, string>;
  rootClasses: Set<string>;
}

function stubDocument(): DomProbe {
  const probe: DomProbe = {
    bodyStyle: { zoom: "" },
    rootVars: new Map(),
    rootClasses: new Set(),
  };
  vi.stubGlobal("document", {
    body: { style: probe.bodyStyle },
    documentElement: {
      style: {
        setProperty: (k: string, v: string) => void probe.rootVars.set(k, v),
        removeProperty: (k: string) => void probe.rootVars.delete(k),
      },
      classList: {
        toggle: (name: string, on: boolean) =>
          on ? probe.rootClasses.add(name) : probe.rootClasses.delete(name),
      },
    },
  });
  return probe;
}

/** The store hydrates at module-evaluation time, so each scenario needs a fresh
 *  module graph on top of the storage it should have booted from. */
async function boot(stored?: string): Promise<SettingsModule> {
  vi.stubGlobal("localStorage", memoryStorage(stored === undefined ? {} : { [KEY]: stored }));
  vi.resetModules();
  return import("./settings-store");
}

const persisted = (): Partial<AppSettings> =>
  JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<AppSettings>;

let dom: DomProbe;

beforeEach(() => {
  dom = stubDocument();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hydration", () => {
  it("boots on the factory defaults when nothing is stored", async () => {
    const { getSettings, DEFAULT_SETTINGS } = await boot();
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("layers the stored values over the defaults", async () => {
    const { getSettings, DEFAULT_SETTINGS } = await boot(
      JSON.stringify({ uiScale: 1.5, exportQuality: 72, thumbMaxEdge: 960 }),
    );
    const s = getSettings();
    expect([s.uiScale, s.exportQuality, s.thumbMaxEdge]).toEqual([1.5, 72, 960]);
    // Everything the payload didn't mention keeps its default.
    expect(s.canvasSurround).toBe(DEFAULT_SETTINGS.canvasSurround);
    expect(s.exportPresets).toEqual([]);
  });

  it("ignores a stored key that no longer maps to a setting", async () => {
    const { getSettings, DEFAULT_SETTINGS } = await boot(
      JSON.stringify({ retiredPreference: "gone", exportBundle: false }),
    );
    expect(getSettings().exportBundle).toBe(false);
    expect(getSettings().uiScale).toBe(DEFAULT_SETTINGS.uiScale);
  });

  it("falls back to the defaults for an unreadable store", async () => {
    for (const junk of ["{not json", '"a string"', "[1,2]", "null", "42"]) {
      const { getSettings, DEFAULT_SETTINGS } = await boot(junk);
      expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("replaces a non-finite stored scale with the default, keeps a real one", async () => {
    // JSON turns NaN and Infinity into null; the stepper can't recover from them.
    const { getSettings, DEFAULT_SETTINGS } = await boot('{"uiScale":null}');
    expect(getSettings().uiScale).toBe(DEFAULT_SETTINGS.uiScale);
    expect(DEFAULT_SETTINGS.uiScale).toBe(1);
    expect((await boot('{"uiScale":1.3}')).getSettings().uiScale).toBe(1.3);
  });

  it("folds the retired update channels into stable", async () => {
    for (const legacy of ["minor", "patch", ""]) {
      const { getSettings } = await boot(JSON.stringify({ updateChannel: legacy }));
      expect(getSettings().updateChannel).toBe("stable");
    }
    const { getSettings } = await boot(JSON.stringify({ updateChannel: "all" }));
    expect(getSettings().updateChannel).toBe("all");
  });

  // TIFF's depth defaults to 16; PNG's must not, or every PNG would turn 16-bit.
  describe("the PNG bit depth", () => {
    it("defaults to 8 beside a TIFF default of 16", async () => {
      const { getSettings, DEFAULT_SETTINGS } = await boot();
      expect(DEFAULT_SETTINGS.exportPngBitDepth).toBe(8);
      expect(DEFAULT_SETTINGS.exportTiffBitDepth).toBe(16);
      expect(getSettings().exportPngBitDepth).toBe(8);
    });

    it("reads a stored choice back after a restart", async () => {
      const { updateSettings } = await boot();
      updateSettings({ exportPngBitDepth: 16 });
      expect(persisted().exportPngBitDepth).toBe(16);

      const { getSettings } = await boot(localStorage.getItem(KEY) ?? "");
      expect(getSettings().exportPngBitDepth).toBe(16);
    });

    it("gives 8 to settings stored before the field existed", async () => {
      const { getSettings } = await boot(
        JSON.stringify({ exportFormat: "image/png", exportTiffBitDepth: 16, exportQuality: 72 }),
      );
      expect(getSettings().exportPngBitDepth).toBe(8);
      expect(getSettings().exportTiffBitDepth).toBe(16);
    });
  });
});

describe("updateSettings", () => {
  it("patches only the named keys and writes the whole object back", async () => {
    const { updateSettings, getSettings, DEFAULT_SETTINGS } = await boot();

    updateSettings({ exportQuality: 60 });

    expect(getSettings().exportQuality).toBe(60);
    expect(getSettings().exportFormat).toBe(DEFAULT_SETTINGS.exportFormat);
    // The full object is persisted, so the next boot doesn't need the defaults.
    expect(persisted()).toEqual(getSettings());
  });

  it("round-trips a change through storage into a fresh boot", async () => {
    const { updateSettings } = await boot();
    updateSettings({
      uiFont: "Inter, sans-serif",
      exportLongEdge: 2048,
      exportPresets: [
        {
          name: "Web",
          format: "image/webp",
          quality: 82,
          longEdge: 1600,
          colorSpace: "srgb",
          sharpenAmount: 30,
          sharpenRadius: 1,
          tiffBitDepth: 8,
        },
      ],
      colorOverrides: { neutral: { "--color-text": "#101010" } },
    });
    const raw = localStorage.getItem(KEY);

    const { getSettings } = await boot(raw ?? "");

    const s = getSettings();
    expect(s.uiFont).toBe("Inter, sans-serif");
    expect(s.exportLongEdge).toBe(2048);
    expect(s.exportPresets[0].name).toBe("Web");
    expect(s.colorOverrides).toEqual({ neutral: { "--color-text": "#101010" } });
  });

  it("keeps an explicit null (export at original size) rather than defaulting it", async () => {
    const { updateSettings } = await boot();
    updateSettings({ exportLongEdge: 3000 });
    updateSettings({ exportLongEdge: null });

    const { getSettings } = await boot(localStorage.getItem(KEY) ?? "");
    expect(getSettings().exportLongEdge).toBeNull();
  });
});

// Whether and how Safelight updates itself and its extensions is the user's
// call in Preferences; an extension writing settings can't change it.
describe("updateSettingsFromExtension", () => {
  it("drops the update policy keys and applies the rest", async () => {
    const { updateSettingsFromExtension, getSettings, DEFAULT_SETTINGS } = await boot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    updateSettingsFromExtension({
      checkExtensionUpdates: !DEFAULT_SETTINGS.checkExtensionUpdates,
      autoUpdateExtensions: !DEFAULT_SETTINGS.autoUpdateExtensions,
      checkForUpdates: !DEFAULT_SETTINGS.checkForUpdates,
      updateChannel: "all",
      exportQuality: 60,
    });
    const s = getSettings();
    expect(s.checkExtensionUpdates).toBe(DEFAULT_SETTINGS.checkExtensionUpdates);
    expect(s.autoUpdateExtensions).toBe(DEFAULT_SETTINGS.autoUpdateExtensions);
    expect(s.checkForUpdates).toBe(DEFAULT_SETTINGS.checkForUpdates);
    expect(s.updateChannel).toBe(DEFAULT_SETTINGS.updateChannel);
    expect(s.exportQuality).toBe(60);
    expect(persisted().exportQuality).toBe(60);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("is what the extension API's appSettings.update calls", async () => {
    const { readFileSync } = await import("node:fs");
    const host = readFileSync(new URL("../extensions/host.tsx", import.meta.url), "utf8");
    expect(host).toMatch(/appSettings: { update: updateSettingsFromExtension }/);
  });
});

describe("resetSettings", () => {
  it("puts every preference back to its factory value and persists that", async () => {
    const { updateSettings, resetSettings, getSettings, DEFAULT_SETTINGS } = await boot(
      JSON.stringify({ uiScale: 2, highContrast: true, updateChannel: "all" }),
    );
    updateSettings({ defaultGridSize: 320 });

    resetSettings();

    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(persisted()).toEqual(DEFAULT_SETTINGS);
  });
});

describe("document side effects", () => {
  it("applies CSS zoom only above/below 100%", async () => {
    const { updateSettings } = await boot();

    updateSettings({ uiScale: 1.25 });
    expect(dom.bodyStyle.zoom).toBe("1.25");

    updateSettings({ uiScale: 1 });
    expect(dom.bodyStyle.zoom).toBe("");
  });

  it("overrides the mono stack only while a font is chosen", async () => {
    const { updateSettings } = await boot();

    updateSettings({ uiFont: "IBM Plex Mono" });
    expect(dom.rootVars.get("--font-mono")).toBe("IBM Plex Mono");

    updateSettings({ uiFont: "" });
    expect(dom.rootVars.has("--font-mono")).toBe(false);
  });

  it("pins the canvas surround, or hands it back to the theme", async () => {
    const { updateSettings } = await boot();

    updateSettings({ canvasSurroundOverride: true, canvasSurround: "#3b3b3b" });
    expect(dom.rootVars.get("--color-canvas-surround")).toBe("#3b3b3b");

    updateSettings({ canvasSurroundOverride: false });
    expect(dom.rootVars.has("--color-canvas-surround")).toBe(false);
  });

  it("mirrors reduce-motion onto the root class", async () => {
    const { updateSettings } = await boot();

    updateSettings({ reduceMotion: true });
    expect(dom.rootClasses.has("sl-reduce-motion")).toBe(true);

    updateSettings({ reduceMotion: false });
    expect(dom.rootClasses.has("sl-reduce-motion")).toBe(false);
  });
});

describe("stepCanvasSurround", () => {
  it("indexes the middle-grey rung the stepper falls back to", async () => {
    const { CANVAS_SURROUND_SHADES, DEFAULT_CANVAS_SURROUND, DEFAULT_CANVAS_SURROUND_INDEX } =
      await boot();
    expect(CANVAS_SURROUND_SHADES[DEFAULT_CANVAS_SURROUND_INDEX].value).toBe(
      DEFAULT_CANVAS_SURROUND,
    );
  });

  it("walks one rung at a time in both directions", async () => {
    const { stepCanvasSurround, getSettings } = await boot();

    stepCanvasSurround(-1);
    expect(getSettings().canvasSurround).toBe("#686868");

    stepCanvasSurround(1);
    stepCanvasSurround(1);
    expect(getSettings().canvasSurround).toBe("#8a8a8a");
  });

  it("clamps at black and at white", async () => {
    const { stepCanvasSurround, getSettings, CANVAS_SURROUND_SHADES } = await boot();

    for (let i = 0; i < CANVAS_SURROUND_SHADES.length + 2; i++) stepCanvasSurround(-1);
    expect(getSettings().canvasSurround).toBe("#000000");

    for (let i = 0; i < CANVAS_SURROUND_SHADES.length + 2; i++) stepCanvasSurround(1);
    expect(getSettings().canvasSurround).toBe("#ffffff");
  });

  it("resumes from middle grey when the stored shade is off the ladder", async () => {
    const { stepCanvasSurround, getSettings } = await boot(
      JSON.stringify({ canvasSurround: "#123456" }),
    );

    stepCanvasSurround(1);

    expect(getSettings().canvasSurround).toBe("#8a8a8a");
  });

  it("pins the surround even when it was following the theme", async () => {
    const { stepCanvasSurround, getSettings } = await boot(
      JSON.stringify({ canvasSurroundOverride: false }),
    );

    stepCanvasSurround(-1);

    expect(getSettings().canvasSurroundOverride).toBe(true);
    expect(dom.rootVars.get("--color-canvas-surround")).toBe("#686868");
  });
});

describe("validation", () => {
  it("keeps the interface scale inside its range, whatever was stored", async () => {
    for (const bad of [0, -1, 50, "big", true]) {
      const { getSettings, UI_SCALE_MIN, UI_SCALE_MAX } = await boot(JSON.stringify({ uiScale: bad }));
      const scale = getSettings().uiScale;
      expect(scale).toBeGreaterThanOrEqual(UI_SCALE_MIN);
      expect(scale).toBeLessThanOrEqual(UI_SCALE_MAX);
    }
    expect((await boot('{"uiScale":0}')).getSettings().uiScale).toBe(1);
    expect((await boot('{"uiScale":50}')).getSettings().uiScale).toBe(2);
  });

  it("replaces wrong-typed stored values with the defaults", async () => {
    const { getSettings, DEFAULT_SETTINGS } = await boot(
      JSON.stringify({ developMaxEdge: "x", reduceMotion: "yes", uiFont: 3, colorOverrides: [], exportPresets: {} }),
    );
    const s = getSettings();
    expect(s.developMaxEdge).toBe(DEFAULT_SETTINGS.developMaxEdge);
    expect(s.reduceMotion).toBe(false);
    expect(s.uiFont).toBe("");
    expect(s.colorOverrides).toEqual({});
    expect(s.exportPresets).toEqual([]);
  });

  it("defaults developDynamicDetail off, keeps a stored boolean and refuses other types", async () => {
    expect((await boot("{}")).getSettings().developDynamicDetail).toBe(false);
    expect((await boot('{"developDynamicDetail":true}')).getSettings().developDynamicDetail).toBe(true);
    expect((await boot('{"developDynamicDetail":"yes"}')).getSettings().developDynamicDetail).toBe(false);
    const { updateSettings } = await boot("{}");
    updateSettings({ developDynamicDetail: true });
    expect(persisted()).toMatchObject({ developDynamicDetail: true });
  });

  it("keeps a key from a newer build through a load and save", async () => {
    const { updateSettings } = await boot(JSON.stringify({ fromTheFuture: { a: 1 } }));
    updateSettings({ exportBundle: false });
    expect(persisted()).toMatchObject({ fromTheFuture: { a: 1 }, exportBundle: false });
  });

  it("refuses wrong-typed and unknown keys in an update", async () => {
    const { updateSettings, getSettings } = await boot();
    updateSettings(JSON.parse('{"uiScale":"abc","thumbMaxEdge":"big","bogusKey":1}') as Partial<AppSettings>);
    expect(getSettings().uiScale).toBe(1);
    expect(getSettings().thumbMaxEdge).toBe(640);
    expect(persisted()).not.toHaveProperty("bogusKey");
    expect(getSettings()).not.toHaveProperty("bogusKey");
  });

  it("clamps an out-of-range scale in an update", async () => {
    const { updateSettings, getSettings } = await boot();
    updateSettings({ uiScale: 0.1 });
    expect(getSettings().uiScale).toBe(0.8);
    expect(dom.bodyStyle.zoom).toBe("0.8");
    updateSettings({ uiScale: 0 });
    expect(getSettings().uiScale).toBe(0.8);
  });

  it("accepts the shapes the extensions write", async () => {
    const { updateSettings, getSettings } = await boot();
    updateSettings({ exportLongEdge: 2048 });
    expect(getSettings().exportLongEdge).toBe(2048);
    updateSettings({ exportLongEdge: null });
    expect(getSettings().exportLongEdge).toBeNull();
    updateSettings({ exportLongEdge: -5 });
    expect(getSettings().exportLongEdge).toBeNull();
    const presets = [{ name: "Web" }] as unknown as AppSettings["exportPresets"];
    updateSettings({ exportPresets: presets, colorOverrides: { dark: { "--color-accent": "#fff" } } });
    expect(getSettings().exportPresets).toEqual(presets);
    expect(getSettings().colorOverrides).toEqual({ dark: { "--color-accent": "#fff" } });
  });
});

describe("initSettings", () => {
  function storageEvent(key: string, newValue: string | null): StorageEvent {
    return { key, newValue } as unknown as StorageEvent;
  }

  async function bootWithWindow(stored?: string) {
    const listeners: StorageListener[] = [];
    vi.stubGlobal("window", {
      addEventListener: (_type: string, fn: StorageListener) => void listeners.push(fn),
    });
    const mod = await boot(stored);
    mod.initSettings();
    return { ...mod, notify: (raw: string | null, key = KEY) => listeners[0](storageEvent(key, raw)) };
  }

  it("applies the current settings to the document at boot", async () => {
    await bootWithWindow(JSON.stringify({ uiScale: 1.4, uiFont: "Inter" }));
    expect(dom.bodyStyle.zoom).toBe("1.4");
    expect(dom.rootVars.get("--font-mono")).toBe("Inter");
  });

  it("adopts a preference changed in another window", async () => {
    const { getSettings, notify } = await bootWithWindow();

    notify(JSON.stringify({ ...getSettings(), uiScale: 1.75, reduceMotion: true }));

    expect(getSettings().uiScale).toBe(1.75);
    expect(dom.bodyStyle.zoom).toBe("1.75");
    expect(dom.rootClasses.has("sl-reduce-motion")).toBe(true);
  });

  it("migrates a legacy channel arriving from an older build", async () => {
    const { getSettings, notify } = await bootWithWindow();

    notify(JSON.stringify({ updateChannel: "patch" }));

    expect(getSettings().updateChannel).toBe("stable");
  });

  it("ignores other keys, clears and unreadable payloads", async () => {
    const { getSettings, updateSettings, notify } = await bootWithWindow();
    updateSettings({ uiScale: 1.1 });

    notify(JSON.stringify({ uiScale: 2 }), "sl_theme");
    notify(null);
    notify("{not json");
    notify("[1,2]");

    expect(getSettings().uiScale).toBe(1.1);
  });
});
