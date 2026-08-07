// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type UIStoreModule = typeof import("./ui-store");

const SORT_KEY = "sl_sort_v1";
const GRID_KEY = "sl_grid_size_v1";

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

/** The store seeds sort state at module-evaluation time, so each scenario
 *  needs a fresh module graph on top of the storage it should have booted from. */
async function boot(seed: Record<string, string> = {}): Promise<UIStoreModule> {
  vi.stubGlobal("localStorage", memoryStorage(seed));
  vi.resetModules();
  return import("./ui-store");
}

beforeEach(() => {
  vi.stubGlobal("document", {
    body: { style: {} },
    documentElement: {
      style: { setProperty: () => {}, removeProperty: () => {} },
      classList: { toggle: () => {} },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sort persistence", () => {
  it("seeds from the Preferences default when nothing is stored", async () => {
    const { useUIStore } = await boot();
    expect(useUIStore.getState().sortField).toBe("dateImported");
    expect(useUIStore.getState().sortDirection).toBe("desc");
  });

  it("restores the last-used sort on boot", async () => {
    const { useUIStore } = await boot({
      [SORT_KEY]: JSON.stringify({ field: "filename", direction: "asc" }),
    });
    expect(useUIStore.getState().sortField).toBe("filename");
    expect(useUIStore.getState().sortDirection).toBe("asc");
  });

  it("restores an extension-contributed sort id verbatim", async () => {
    const { useUIStore } = await boot({
      [SORT_KEY]: JSON.stringify({ field: "my-ext.camera", direction: "desc" }),
    });
    expect(useUIStore.getState().sortField).toBe("my-ext.camera");
  });

  it("persists the sort choice when it changes", async () => {
    const { useUIStore } = await boot();
    useUIStore.getState().setSort("rating", "asc");
    expect(JSON.parse(localStorage.getItem(SORT_KEY) ?? "null")).toEqual({
      field: "rating",
      direction: "asc",
    });
  });

  it("falls back to the default when the stored payload is invalid", async () => {
    const { useUIStore } = await boot({
      [SORT_KEY]: '{"field":42,"direction":"sideways"}',
    });
    expect(useUIStore.getState().sortField).toBe("dateImported");
    expect(useUIStore.getState().sortDirection).toBe("desc");
  });

  it("falls back to the default when the stored payload is not JSON", async () => {
    const { useUIStore } = await boot({ [SORT_KEY]: "not json" });
    expect(useUIStore.getState().sortField).toBe("dateImported");
    expect(useUIStore.getState().sortDirection).toBe("desc");
  });
});

describe("grid size persistence", () => {
  it("restores the last-used size on boot", async () => {
    const { useUIStore } = await boot({ [GRID_KEY]: "260" });
    expect(useUIStore.getState().gridSize).toBe(260);
  });

  it("persists the size when the slider or stepper changes it", async () => {
    const { useUIStore } = await boot();
    useUIStore.getState().setGridSize(320);
    expect(localStorage.getItem(GRID_KEY)).toBe("320");
    useUIStore.getState().stepGridSize(-1);
    expect(localStorage.getItem(GRID_KEY)).toBe("300");
  });

  it("falls back to the Preferences default when the stored value is invalid", async () => {
    for (const bad of ["oops", "9000", "-20"]) {
      const { useUIStore } = await boot({ [GRID_KEY]: bad });
      expect(useUIStore.getState().gridSize).toBe(200);
    }
  });
});

describe("grid size stepping", () => {
  it("steps one slider stop per call", async () => {
    const { useUIStore, GRID_SIZE_STEP } = await boot();
    const start = useUIStore.getState().gridSize;
    useUIStore.getState().stepGridSize(1);
    expect(useUIStore.getState().gridSize).toBe(start + GRID_SIZE_STEP);
    useUIStore.getState().stepGridSize(-1);
    expect(useUIStore.getState().gridSize).toBe(start);
  });

  it("clamps at the slider bounds", async () => {
    const { useUIStore, GRID_SIZE_MIN, GRID_SIZE_MAX } = await boot();
    useUIStore.getState().setGridSize(GRID_SIZE_MAX);
    useUIStore.getState().stepGridSize(1);
    expect(useUIStore.getState().gridSize).toBe(GRID_SIZE_MAX);
    useUIStore.getState().setGridSize(GRID_SIZE_MIN);
    useUIStore.getState().stepGridSize(-1);
    expect(useUIStore.getState().gridSize).toBe(GRID_SIZE_MIN);
  });
});
