// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { createViewSlice } from "./view-slice.ts";
import type { DevelopState } from "../develop-store";

// The two persisted toggles are read at slice-creation time, so the store must
// be built AFTER the storage stub is in place — hence a factory, not a
// module-level store.
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

// The view slice only reads and writes its own fields, so a partial store is
// enough; the rest of DevelopState is irrelevant here.
function makeStore() {
  return create<DevelopState>()(
    (set, get, store) =>
      ({ ...createViewSlice(set, get, store) }) as unknown as DevelopState,
  );
}

function boot(stored: Record<string, string> = {}) {
  vi.stubGlobal("localStorage", memoryStorage(stored));
  return makeStore();
}

let store: ReturnType<typeof makeStore>;
beforeEach(() => {
  store = boot();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clipping overlay", () => {
  it("hydrates the stored bitmask", () => {
    expect(boot({ sl_show_clipping: "2" }).getState().showClipping).toBe(2);
    expect(boot({ sl_show_clipping: "3" }).getState().showClipping).toBe(3);
  });

  it("falls back to off for a missing or unrecognised stored value", () => {
    expect(boot().getState().showClipping).toBe(0);
    expect(boot({ sl_show_clipping: "7" }).getState().showClipping).toBe(0);
  });

  it("persists the mode set from the UI", () => {
    store.getState().setShowClipping(1);
    expect(store.getState().showClipping).toBe(1);
    expect(localStorage.getItem("sl_show_clipping")).toBe("1");
  });

  it("toggles between off and both channels", () => {
    store.getState().toggleClipping();
    expect(store.getState().showClipping).toBe(3);
    expect(localStorage.getItem("sl_show_clipping")).toBe("3");
    store.getState().toggleClipping();
    expect(store.getState().showClipping).toBe(0);
    expect(localStorage.getItem("sl_show_clipping")).toBe("0");
  });

  it("toggles a single-channel mode off rather than completing it", () => {
    store.getState().setShowClipping(2); // highlights only
    store.getState().toggleClipping();
    expect(store.getState().showClipping).toBe(0);
  });
});

describe("colour assessment", () => {
  it("hydrates from storage", () => {
    expect(boot({ sl_color_assessment: "1" }).getState().colorAssessment).toBe(true);
    expect(boot({ sl_color_assessment: "0" }).getState().colorAssessment).toBe(false);
    expect(boot().getState().colorAssessment).toBe(false);
  });

  it("flips and persists", () => {
    store.getState().toggleColorAssessment();
    expect(store.getState().colorAssessment).toBe(true);
    expect(localStorage.getItem("sl_color_assessment")).toBe("1");
    store.getState().toggleColorAssessment();
    expect(store.getState().colorAssessment).toBe(false);
    expect(localStorage.getItem("sl_color_assessment")).toBe("0");
  });
});

describe("panel bypass", () => {
  it("records a bypassed panel and deletes the key when released", () => {
    store.getState().setPanelBypass("basic", true);
    expect(store.getState().bypassedPanels).toEqual({ basic: true });
    store.getState().setPanelBypass("basic", false);
    // Released panels are removed, not stored as false — consumers test for key
    // presence and an empty map means "nothing bypassed".
    expect(store.getState().bypassedPanels).toEqual({});
  });

  it("keeps panels independent", () => {
    store.getState().setPanelBypass("basic", true);
    store.getState().setPanelBypass("hsl", true);
    store.getState().setPanelBypass("basic", false);
    expect(store.getState().bypassedPanels).toEqual({ hsl: true });
  });

  it("does not notify subscribers when the state is already correct", () => {
    // Press-and-hold fires repeats; a redundant set must not re-render the panel
    // stack (and re-trigger a render pass).
    const seen = vi.fn();
    const unsub = store.subscribe(seen);
    store.getState().setPanelBypass("basic", false);
    expect(seen).not.toHaveBeenCalled();
    store.getState().setPanelBypass("basic", true);
    expect(seen).toHaveBeenCalledTimes(1);
    store.getState().setPanelBypass("basic", true);
    expect(seen).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("togglePanelBypass flips a panel in and out of the map", () => {
    store.getState().togglePanelBypass("curve");
    expect(store.getState().bypassedPanels).toEqual({ curve: true });
    store.getState().togglePanelBypass("curve");
    expect(store.getState().bypassedPanels).toEqual({});
  });

  it("never persists the bypass map", () => {
    store.getState().setPanelBypass("basic", true);
    store.getState().togglePanelBypass("hsl");
    expect(localStorage.length).toBe(0);
  });
});

describe("ephemeral picker and overlay state", () => {
  it("defaults to every picker off", () => {
    const s = store.getState();
    expect([s.guidedEditing, s.wbPicking, s.hslPicking, s.maskColorPicking]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(s.selectedHslBand).toBe("hue");
  });

  it("sets each flag without persisting it", () => {
    store.getState().setGuidedEditing(true);
    store.getState().setWbPicking(true);
    store.getState().setHslPicking(true);
    store.getState().setMaskColorPicking(true);
    store.getState().setSelectedHslBand("saturation");
    const s = store.getState();
    expect([s.guidedEditing, s.wbPicking, s.hslPicking, s.maskColorPicking]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(s.selectedHslBand).toBe("saturation");
    expect(localStorage.length).toBe(0);
  });
});
