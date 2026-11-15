// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import type { SharedSettings } from "@/state/shared-settings";
import { applyMirror, type StorageLike } from "./main";

function memoryStorage(initial: Record<string, string>): StorageLike & { items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  return {
    items,
    get length() {
      return items.size;
    },
    key: (i) => [...items.keys()][i] ?? null,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, v),
    removeItem: (k) => void items.delete(k),
  };
}

const mirror = (storage: Record<string, string>): SharedSettings => ({
  version: 1,
  appVersion: "3.3.0",
  writtenAt: 0,
  guiPid: null,
  recentProjects: [],
  storage,
});

const UPDATES_OFF = JSON.stringify({ checkExtensionUpdates: false, autoUpdateExtensions: false });

describe("applyMirror", () => {
  it("replaces the mirrored keys with the GUI's and leaves the rest", () => {
    const storage = memoryStorage({
      sl_pipeline: "old",
      "sl_ext_settings_gone": "{}",
      sl_dock_layout_v4: "kept",
    });
    applyMirror(storage, mirror({ sl_pipeline: "new", "sl_ext_settings_safelight.basic": "{\"a\":1}" }));
    expect(Object.fromEntries(storage.items)).toEqual({
      sl_pipeline: "new",
      "sl_ext_settings_safelight.basic": "{\"a\":1}",
      sl_dock_layout_v4: "kept",
      sl_settings_v1: UPDATES_OFF,
    });
  });

  it("takes no key the mirror shouldn't carry", () => {
    const storage = memoryStorage({});
    applyMirror(storage, mirror({ sl_keybindings: "x", sl_pipeline: "p" }));
    expect(Object.fromEntries(storage.items)).toEqual({ sl_pipeline: "p", sl_settings_v1: UPDATES_OFF });
  });

  it("keeps the GUI's settings but never lets the engine check for or install updates", () => {
    const storage = memoryStorage({});
    applyMirror(storage, mirror({
      sl_settings_v1: JSON.stringify({ highBitDepth: true, checkExtensionUpdates: true, autoUpdateExtensions: true }),
    }));
    expect(JSON.parse(storage.getItem("sl_settings_v1") ?? "")).toEqual({
      highBitDepth: true,
      checkExtensionUpdates: false,
      autoUpdateExtensions: false,
    });
  });

  it("without a mirror clears the mirrored keys and still turns updates off", () => {
    const storage = memoryStorage({ sl_settings_v1: "{\"highBitDepth\":true}", "safelight-presets": "[]" });
    applyMirror(storage, null);
    expect(Object.fromEntries(storage.items)).toEqual({
      sl_settings_v1: UPDATES_OFF,
    });
  });
});
