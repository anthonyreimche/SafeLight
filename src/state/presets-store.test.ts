// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevelopParams } from "@/catalog/types";
import type { Preset } from "./presets-store";

type PresetsModule = typeof import("./presets-store");
type StorageListener = (e: StorageEvent) => void;

const KEY = "safelight-presets";

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

/** The store hydrates at module-evaluation time, so each scenario needs a fresh
 *  module graph on top of the storage it should have booted from. */
async function boot(stored?: string): Promise<PresetsModule> {
  vi.stubGlobal("localStorage", memoryStorage(stored === undefined ? {} : { [KEY]: stored }));
  vi.resetModules();
  return import("./presets-store");
}

const persisted = (): Preset[] => JSON.parse(localStorage.getItem(KEY) ?? "[]") as Preset[];

function stored(...presets: Partial<Preset>[]): string {
  return JSON.stringify(
    presets.map((p, i) => ({ id: `p${i}`, name: `Preset ${i}`, params: {}, ...p })),
  );
}

/** A partial preset payload with a nested block, so deep-copying is observable. */
function punch(): Partial<DevelopParams> {
  return {
    exposure: 0.4,
    vignette: { amount: -30, midpoint: 50, roundness: 0, feather: 60, highlights: 0 },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("nextAvailableName", () => {
  let nextAvailableName: PresetsModule["nextAvailableName"];
  beforeEach(async () => {
    ({ nextAvailableName } = await boot());
  });

  const named = (...names: string[]): Preset[] =>
    names.map((name, i) => ({ id: `p${i}`, name, params: {} }));

  it("keeps the requested name when it is free", () => {
    expect(nextAvailableName(named("Punchy"), "Muted")).toBe("Muted");
    expect(nextAvailableName([], "Punchy")).toBe("Punchy");
  });

  it("starts suffixing at 2 and walks past the ones already taken", () => {
    expect(nextAvailableName(named("Punchy"), "Punchy")).toBe("Punchy 2");
    expect(nextAvailableName(named("Punchy", "Punchy 2"), "Punchy")).toBe("Punchy 3");
    expect(nextAvailableName(named("Punchy", "Punchy 3"), "Punchy")).toBe("Punchy 2");
  });

  it("collides case-insensitively, matching the panel's own check", () => {
    expect(nextAvailableName(named("PUNCHY"), "punchy")).toBe("punchy 2");
  });
});

describe("hydration", () => {
  it("starts empty with nothing stored", async () => {
    const { usePresetsStore } = await boot();
    expect(usePresetsStore.getState().presets).toEqual([]);
  });

  it("restores the stored list", async () => {
    const { usePresetsStore } = await boot(
      stored({ id: "a", name: "Punchy", group: "Portraits" }, { id: "b", name: "Muted" }),
    );
    expect(usePresetsStore.getState().presets.map((p) => p.name)).toEqual(["Punchy", "Muted"]);
    expect(usePresetsStore.getState().presets[0].group).toBe("Portraits");
  });

  it("starts empty for a payload that is not a preset list", async () => {
    // A non-array would reach the panel as `presets` and blow up on .map().
    for (const junk of ["{not json", "null", '{"a":1}', '"Punchy"', "7"]) {
      const { usePresetsStore } = await boot(junk);
      expect(usePresetsStore.getState().presets).toEqual([]);
    }
  });
});

describe("add", () => {
  it("appends a preset with its own id and persists the list", async () => {
    const { usePresetsStore } = await boot();

    usePresetsStore.getState().add("Punchy", punch());
    usePresetsStore.getState().add("Muted", { exposure: -0.2 });

    const { presets } = usePresetsStore.getState();
    expect(presets.map((p) => p.name)).toEqual(["Punchy", "Muted"]);
    expect(new Set(presets.map((p) => p.id)).size).toBe(2);
    expect(persisted().map((p) => p.name)).toEqual(["Punchy", "Muted"]);
  });

  it("snapshots the params so later edits to the photo don't rewrite the preset", async () => {
    const { usePresetsStore } = await boot();
    const params = punch();

    usePresetsStore.getState().add("Punchy", params);
    params.exposure = 99;
    params.vignette!.amount = 99;

    const [saved] = usePresetsStore.getState().presets;
    expect(saved.params.exposure).toBe(0.4);
    expect(saved.params.vignette?.amount).toBe(-30);
  });

  it("trims the group and leaves a blank one ungrouped", async () => {
    const { usePresetsStore } = await boot();

    usePresetsStore.getState().add("A", {}, "  Portraits  ");
    usePresetsStore.getState().add("B", {}, "   ");
    usePresetsStore.getState().add("C", {});

    const groups = usePresetsStore.getState().presets.map((p) => p.group);
    expect(groups).toEqual(["Portraits", undefined, undefined]);
  });

  it("carries an extension's stage params, but only when there are some", async () => {
    const { usePresetsStore } = await boot();
    const bag = { "denoise.amount": 40 };

    usePresetsStore.getState().add("With bag", {}, undefined, bag);
    usePresetsStore.getState().add("Empty bag", {}, undefined, {});
    usePresetsStore.getState().add("No bag", {});

    const [withBag, emptyBag, noBag] = usePresetsStore.getState().presets;
    expect(withBag.paramBag).toEqual(bag);
    expect(withBag.paramBag).not.toBe(bag); // snapshotted, not aliased
    expect("paramBag" in emptyBag).toBe(false);
    expect("paramBag" in noBag).toBe(false);
  });
});

describe("update", () => {
  it("replaces the params in place, keeping id, name and position", async () => {
    const { usePresetsStore } = await boot(
      stored({ id: "a", name: "Punchy" }, { id: "b", name: "Muted" }),
    );

    usePresetsStore.getState().update("a", { exposure: 1.2 }, "Portraits");

    const { presets } = usePresetsStore.getState();
    expect(presets.map((p) => p.id)).toEqual(["a", "b"]);
    expect(presets[0]).toMatchObject({ id: "a", name: "Punchy", group: "Portraits" });
    expect(presets[0].params).toEqual({ exposure: 1.2 });
    expect(presets[1].params).toEqual({});
  });

  it("clears a stage bag that the re-save no longer carries", async () => {
    const { usePresetsStore } = await boot(
      stored({ id: "a", name: "Punchy", paramBag: { "denoise.amount": 40 } }),
    );

    usePresetsStore.getState().update("a", { exposure: 0.1 });

    expect(usePresetsStore.getState().presets[0].paramBag).toBeUndefined();
    expect(persisted()[0].paramBag).toBeUndefined();
  });

  it("ignores an id that is not in the list", async () => {
    const { usePresetsStore } = await boot(stored({ id: "a", name: "Punchy" }));

    usePresetsStore.getState().update("ghost", { exposure: 5 });

    expect(usePresetsStore.getState().presets[0].params).toEqual({});
  });
});

describe("rename", () => {
  it("trims the new name and leaves everything else alone", async () => {
    const { usePresetsStore } = await boot(
      stored({ id: "a", name: "Punchy", group: "Portraits", params: { exposure: 0.4 } }),
    );

    usePresetsStore.getState().rename("a", "  Punchier  ");

    expect(usePresetsStore.getState().presets[0]).toEqual({
      id: "a",
      name: "Punchier",
      group: "Portraits",
      params: { exposure: 0.4 },
    });
    expect(persisted()[0].name).toBe("Punchier");
  });

  it("refuses a blank name rather than leaving a nameless preset", async () => {
    const { usePresetsStore } = await boot(stored({ id: "a", name: "Punchy" }));
    const seen = vi.fn();
    const unsub = usePresetsStore.subscribe(seen);

    usePresetsStore.getState().rename("a", "   ");

    expect(usePresetsStore.getState().presets[0].name).toBe("Punchy");
    expect(seen).not.toHaveBeenCalled(); // rejected outright — the panel never re-renders
    unsub();
  });
});

describe("setGroup", () => {
  it("moves a preset between groups and back to ungrouped", async () => {
    const { usePresetsStore } = await boot(stored({ id: "a", name: "Punchy" }));

    usePresetsStore.getState().setGroup("a", "  Landscapes ");
    expect(usePresetsStore.getState().presets[0].group).toBe("Landscapes");

    usePresetsStore.getState().setGroup("a", "");
    expect(usePresetsStore.getState().presets[0].group).toBeUndefined();

    usePresetsStore.getState().setGroup("a", "Landscapes");
    usePresetsStore.getState().setGroup("a");
    expect(usePresetsStore.getState().presets[0].group).toBeUndefined();
    expect(persisted()[0].group).toBeUndefined();
  });
});

describe("remove", () => {
  it("deletes one preset and persists what is left", async () => {
    const { usePresetsStore } = await boot(
      stored({ id: "a", name: "Punchy" }, { id: "b", name: "Muted" }),
    );

    usePresetsStore.getState().remove("a");

    expect(usePresetsStore.getState().presets.map((p) => p.id)).toEqual(["b"]);
    expect(persisted().map((p) => p.id)).toEqual(["b"]);
  });

  it("leaves the list intact for an unknown id", async () => {
    const { usePresetsStore } = await boot(stored({ id: "a", name: "Punchy" }));

    usePresetsStore.getState().remove("ghost");

    expect(usePresetsStore.getState().presets.map((p) => p.id)).toEqual(["a"]);
  });
});

describe("initPresets", () => {
  function storageEvent(key: string, newValue: string | null): StorageEvent {
    return { key, newValue } as unknown as StorageEvent;
  }

  async function bootWithWindow(seed?: string) {
    const listeners: StorageListener[] = [];
    vi.stubGlobal("window", {
      addEventListener: (_type: string, fn: StorageListener) => void listeners.push(fn),
    });
    const mod = await boot(seed);
    mod.initPresets();
    return {
      ...mod,
      notify: (raw: string | null, key = KEY) => listeners[0](storageEvent(key, raw)),
    };
  }

  it("adopts a list saved in another window", async () => {
    const { usePresetsStore, notify } = await bootWithWindow();

    notify(stored({ id: "x", name: "From the other window" }));

    expect(usePresetsStore.getState().presets.map((p) => p.name)).toEqual([
      "From the other window",
    ]);
  });

  it("adopts an emptied list", async () => {
    const { usePresetsStore, notify } = await bootWithWindow(stored({ id: "a", name: "Punchy" }));

    notify("[]");

    expect(usePresetsStore.getState().presets).toEqual([]);
  });

  it("ignores other keys, clears and payloads that are not a list", async () => {
    const { usePresetsStore, notify } = await bootWithWindow(stored({ id: "a", name: "Punchy" }));

    notify(stored({ id: "z", name: "Other store" }), "sl_settings_v1");
    notify(null);
    notify("{not json");
    notify('{"0":"Punchy"}');

    expect(usePresetsStore.getState().presets.map((p) => p.id)).toEqual(["a"]);
  });
});
