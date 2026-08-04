// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Per-extension settings: the lazy localStorage read, the write-through to disk,
// the change listeners extensions subscribe to, and the cross-window storage-event
// sync. The lazy read is the subtle part — getExtSetting runs during render and
// must never populate the store as a side effect. Run with `npm test`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteExtensionSettings,
  getAllExtSettings,
  getExtSetting,
  initExtSettings,
  onExtSettingChange,
  setExtSetting,
  useExtSettings,
} from "./ext-settings.ts";

const EXT = "acme.tool";
const OTHER = "other.ext";
const keyFor = (id: string) => `sl_ext_settings_${id}`;

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  } satisfies Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

type StorageHandler = (e: StorageEvent) => void;

let storage: ReturnType<typeof memoryStorage>;
let onStorage: StorageHandler | null;

function stubWindow(): void {
  onStorage = null;
  vi.stubGlobal("window", {
    addEventListener: (type: string, cb: StorageHandler) => {
      if (type === "storage") onStorage = cb;
    },
  });
}

/** Replay what another window's write looks like to this one. */
function fireStorage(key: string | null, newValue: string | null): void {
  if (!onStorage) throw new Error("initExtSettings() was never called");
  onStorage({ key, newValue } as StorageEvent);
}

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  stubWindow();
  useExtSettings.setState({}, true);
});

afterEach(() => {
  // The listener registry is module-level; clearing both ids keeps a subscription
  // from leaking into the next test.
  deleteExtensionSettings(EXT);
  deleteExtensionSettings(OTHER);
  vi.unstubAllGlobals();
});

describe("reading settings", () => {
  it("returns the fallback for a key that was never set", () => {
    expect(getExtSetting(EXT, "strength", 0.5)).toBe(0.5);
    expect(getAllExtSettings(EXT)).toEqual({});
  });

  it("reads persisted values lazily, without populating the store mid-render", () => {
    storage.setItem(keyFor(EXT), JSON.stringify({ strength: 0.8, label: "warm" }));

    expect(getExtSetting(EXT, "strength", 0.5)).toBe(0.8);
    expect(getAllExtSettings(EXT)).toEqual({ strength: 0.8, label: "warm" });
    expect(useExtSettings.getState()).toEqual({});
  });

  it("distinguishes a stored null from an absent key", () => {
    setExtSetting(EXT, "profile", null);
    expect(getExtSetting<string | null>(EXT, "profile", "fallback")).toBeNull();
    expect(getExtSetting(EXT, "missing", "fallback")).toBe("fallback");
  });

  it("falls back to empty when the stored blob is unreadable", () => {
    storage.setItem(keyFor(EXT), "{ not json");
    expect(getAllExtSettings(EXT)).toEqual({});
    expect(getExtSetting(EXT, "strength", 0.5)).toBe(0.5);
  });
});

describe("writing settings", () => {
  it("writes through to localStorage under the extension's own key", () => {
    setExtSetting(EXT, "strength", 0.8);

    expect(JSON.parse(storage.getItem(keyFor(EXT)) ?? "null")).toEqual({ strength: 0.8 });
    expect(useExtSettings.getState()[EXT]).toEqual({ strength: 0.8 });
  });

  it("merges into the values already on disk instead of replacing them", () => {
    storage.setItem(keyFor(EXT), JSON.stringify({ label: "warm" }));

    setExtSetting(EXT, "strength", 0.8);

    expect(getAllExtSettings(EXT)).toEqual({ label: "warm", strength: 0.8 });
  });

  it("keeps each extension's values separate", () => {
    setExtSetting(EXT, "strength", 0.8);
    setExtSetting(OTHER, "strength", 0.1);

    expect(getExtSetting(EXT, "strength", 0)).toBe(0.8);
    expect(getExtSetting(OTHER, "strength", 0)).toBe(0.1);
  });

  it("keeps the in-memory value when localStorage refuses the write", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {},
    } satisfies Pick<Storage, "getItem" | "setItem" | "removeItem">);

    expect(() => setExtSetting(EXT, "strength", 0.8)).not.toThrow();
    expect(getExtSetting(EXT, "strength", 0)).toBe(0.8);
  });
});

describe("change listeners", () => {
  it("notifies subscribers of the key and its new value", () => {
    const seen: [string, unknown][] = [];
    const off = onExtSettingChange(EXT, (key, value) => seen.push([key, value]));

    setExtSetting(EXT, "strength", 0.8);
    setExtSetting(EXT, "label", "warm");

    expect(seen).toEqual([
      ["strength", 0.8],
      ["label", "warm"],
    ]);
    off();
  });

  it("scopes notifications to one extension", () => {
    const cb = vi.fn();
    const off = onExtSettingChange(EXT, cb);

    setExtSetting(OTHER, "strength", 0.1);

    expect(cb).not.toHaveBeenCalled();
    off();
  });

  it("stops notifying after unsubscribe, leaving other subscribers alone", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onExtSettingChange(EXT, a);
    onExtSettingChange(EXT, b);

    offA();
    setExtSetting(EXT, "strength", 0.8);

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith("strength", 0.8);
  });
});

describe("deleteExtensionSettings", () => {
  it("erases the stored values and forgets the cached ones", () => {
    setExtSetting(EXT, "strength", 0.8);

    deleteExtensionSettings(EXT);

    expect(storage.getItem(keyFor(EXT))).toBeNull();
    expect(getAllExtSettings(EXT)).toEqual({});
    expect(EXT in useExtSettings.getState()).toBe(false);
  });

  it("leaves every other extension's values in place", () => {
    setExtSetting(EXT, "strength", 0.8);
    setExtSetting(OTHER, "strength", 0.1);

    deleteExtensionSettings(EXT);

    expect(getExtSetting(OTHER, "strength", 0)).toBe(0.1);
    expect(storage.getItem(keyFor(OTHER))).not.toBeNull();
  });

  it("drops the extension's listeners along with its data", () => {
    const cb = vi.fn();
    onExtSettingChange(EXT, cb);

    deleteExtensionSettings(EXT);
    setExtSetting(EXT, "strength", 0.8);

    expect(cb).not.toHaveBeenCalled();
  });
});

describe("cross-window sync", () => {
  beforeEach(() => initExtSettings());

  it("adopts values another window wrote and notifies on the changed keys", () => {
    setExtSetting(EXT, "strength", 0.8);
    const cb = vi.fn();
    const off = onExtSettingChange(EXT, cb);

    fireStorage(keyFor(EXT), JSON.stringify({ strength: 0.8, label: "warm" }));

    expect(useExtSettings.getState()[EXT]).toEqual({ strength: 0.8, label: "warm" });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("label", "warm");
    off();
  });

  it("forgets the extension when another window deletes its settings", () => {
    setExtSetting(EXT, "strength", 0.8);
    setExtSetting(OTHER, "strength", 0.1);
    const cb = vi.fn();
    const off = onExtSettingChange(EXT, cb);

    fireStorage(keyFor(EXT), null);

    expect(EXT in useExtSettings.getState()).toBe(false);
    expect(useExtSettings.getState()[OTHER]).toEqual({ strength: 0.1 });
    expect(cb).not.toHaveBeenCalled();
    off();
  });

  it("ignores keys that belong to other parts of the app", () => {
    setExtSetting(EXT, "strength", 0.8);

    fireStorage("sl_theme", JSON.stringify({ strength: 0.1 }));
    fireStorage(null, JSON.stringify({ strength: 0.1 }));

    expect(useExtSettings.getState()[EXT]).toEqual({ strength: 0.8 });
  });

  it("survives an unparseable payload without disturbing the cached values", () => {
    setExtSetting(EXT, "strength", 0.8);

    expect(() => fireStorage(keyFor(EXT), "{ not json")).not.toThrow();
    expect(useExtSettings.getState()[EXT]).toEqual({ strength: 0.8 });
  });

  it("re-notifies for structurally identical object values", () => {
    // Change detection is a reference compare, and the incoming payload is
    // freshly parsed, so object-valued settings always look changed.
    setExtSetting(EXT, "range", { min: 0, max: 1 });
    const cb = vi.fn();
    const off = onExtSettingChange(EXT, cb);

    fireStorage(keyFor(EXT), JSON.stringify({ range: { min: 0, max: 1 } }));

    expect(cb).toHaveBeenCalledWith("range", { min: 0, max: 1 });
    off();
  });
});
