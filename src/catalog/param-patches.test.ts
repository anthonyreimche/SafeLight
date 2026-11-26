// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Reading and changing the settings of Library photos that aren't open (#218):
// a photo's look as stored, and patches of its settings committed across a
// selection in one catalogue write, a step on each photo in the extension's name.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/broadcast", () => ({
  broadcast: vi.fn(),
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));
vi.mock("@/state/edited-thumbnail", () => ({ regenerateEditedThumbnail: vi.fn(), refreshStoredThumbnails: vi.fn() }));

import { applyParamPatches, storedLook } from "./param-patches";
import { installMemoryStorage, photo, snapshot } from "./stored-edit.fixtures";
import { setCatalogStorage } from "./storage";
import { freshParams, type EditSnapshot, type EditState } from "./types";
import { broadcast } from "@/state/broadcast";
import { useCatalogStore } from "@/state/catalog-store";
import { registerCatalogHooks, useRegistry } from "@/extensions/registry";

const edit = (photoId: string, stack: EditSnapshot[], currentIndex = stack.length - 1): EditState => ({
  photoId,
  stack,
  currentIndex,
});

beforeEach(() => {
  useCatalogStore.setState({
    photos: [photo("a"), photo("b"), { ...photo("c"), exif: { colorTemperature: 4300 } }],
  });
  vi.mocked(broadcast).mockClear();
});

afterEach(() => {
  setCatalogStorage(null);
  useRegistry.setState({ catalogHooks: {} });
});

describe("storedLook", () => {
  it("is the settings and bag under the stored cursor", async () => {
    installMemoryStorage(
      edit("a", [snapshot("Original", {}), snapshot("Bright", { exposure: 0.5 }, { "x.s.on": true }), snapshot("Brighter", { exposure: 1 })], 1),
    );
    const look = await storedLook("a");
    expect(look.params.exposure).toBe(0.5);
    expect(look.paramBag).toEqual({ "x.s.on": true });
  });

  it("is the as-shot defaults for a photo never edited", async () => {
    installMemoryStorage();
    const look = await storedLook("c");
    expect(look.params).toEqual(freshParams(4300));
    expect(look.paramBag).toEqual({});
  });

  it("refuses a photo the catalogue doesn't hold", async () => {
    installMemoryStorage();
    await expect(storedLook("gone")).rejects.toThrow(/not in the catalogue/);
  });
});

describe("applyParamPatches", () => {
  it("commits each photo's own patch as one step in the extension's name, all in one write", async () => {
    const memory = installMemoryStorage(
      edit("a", [snapshot("Original", { contrast: 20 }, { "x.s.on": true })]),
      edit("b", [snapshot("Original", {})]),
    );
    const changed = await applyParamPatches(
      [
        { photoId: "a", params: { exposure: 0.4, temperature: 5100 } },
        { photoId: "b", params: { exposure: -0.3, tint: 6 } },
      ],
      "Match exposure and colour",
      "batch-consistency",
    );
    expect(changed).toBe(2);
    expect(memory.batches).toHaveLength(1);
    const [a, b] = ["a", "b"].map((id) => memory.written.find((e) => e.photoId === id)!);
    const stepA = a.stack[a.currentIndex];
    expect(stepA.label).toBe("Match exposure and colour");
    expect(stepA.source).toBe("batch-consistency");
    expect(stepA.params).toMatchObject({ exposure: 0.4, temperature: 5100, contrast: 20 });
    expect(stepA.paramBag).toEqual({ "x.s.on": true });
    expect(b.stack[b.currentIndex].params).toMatchObject({ exposure: -0.3, tint: 6 });
  });

  it("seeds a never-edited photo from its as-shot look", async () => {
    const memory = installMemoryStorage();
    await applyParamPatches([{ photoId: "c", params: { exposure: 1 } }], "Match", "m");
    const state = memory.written[0];
    expect(state.stack.map((s) => s.label)).toEqual(["Original", "Match"]);
    expect(state.stack[1].params).toEqual({ ...freshParams(4300), exposure: 1 });
  });

  it("leaves out a photo that already holds every value, and announces only the ones it changed", async () => {
    const memory = installMemoryStorage(
      edit("a", [snapshot("Original", { exposure: 0.4 })]),
      edit("b", [snapshot("Original", {})]),
    );
    const onEditCommit = vi.fn(async () => {});
    registerCatalogHooks("test-ext", { id: "test.hooks", onEditCommit });
    const changed = await applyParamPatches(
      [
        { photoId: "a", params: { exposure: 0.4 } },
        { photoId: "b", params: { exposure: 0.4 } },
      ],
      "Match",
      "m",
    );
    expect(changed).toBe(1);
    expect(memory.written.map((e) => e.photoId)).toEqual(["b"]);
    expect(onEditCommit).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({ type: "edit-update", payload: { photoId: "b" } });
    expect(broadcast).not.toHaveBeenCalledWith({ type: "edit-update", payload: { photoId: "a" } });
  });

  it("writes nothing when one of the photos isn't in the catalogue", async () => {
    const memory = installMemoryStorage();
    await expect(
      applyParamPatches(
        [
          { photoId: "a", params: { exposure: 1 } },
          { photoId: "gone", params: { exposure: 1 } },
        ],
        "Match",
        "m",
      ),
    ).rejects.toThrow(/gone.*not in the catalogue/);
    expect(memory.written).toHaveLength(0);
  });

  it.each([
    { what: "a setting Safelight doesn't have", params: { brightness: 1 }, error: /brightness/ },
    { what: "a value of the wrong kind", params: { exposure: "1" }, error: /exposure/ },
    { what: "a number that isn't finite", params: { exposure: Number.NaN }, error: /exposure/ },
    { what: "the process version", params: { processVersion: 1 }, error: /processVersion/ },
  ])("refuses $what and writes nothing", async ({ params, error }) => {
    const memory = installMemoryStorage();
    await expect(
      applyParamPatches(
        [
          { photoId: "a", params: { exposure: 1 } },
          { photoId: "b", params: params as never },
        ],
        "Match",
        "m",
      ),
    ).rejects.toThrow(error);
    expect(memory.written).toHaveLength(0);
  });

  it("refuses patches that aren't a list of photo patches", async () => {
    installMemoryStorage();
    await expect(applyParamPatches([{ photoId: "a", params: { exposure: 1 } }], 3 as never, "m")).rejects.toThrow(/label/);
    await expect(applyParamPatches({} as never, "Match", "m")).rejects.toThrow(/list/);
    await expect(applyParamPatches([{ photoId: "a", params: [] as never }], "Match", "m")).rejects.toThrow(/params/);
  });

  it("merges two patches for the same photo in order", async () => {
    const memory = installMemoryStorage();
    await applyParamPatches(
      [
        { photoId: "a", params: { exposure: 1, tint: 4 } },
        { photoId: "a", params: { exposure: 2 } },
      ],
      "Match",
      "m",
    );
    expect(memory.written).toHaveLength(1);
    expect(memory.written[0].stack[1].params).toMatchObject({ exposure: 2, tint: 4 });
  });
});
