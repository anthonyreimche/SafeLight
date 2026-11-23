// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A stage uniform declared `computed` is a value its extension works out for
// each photo (a lens profile's coefficients), not one the user set. It rides the
// photo's bag so every render of the photo draws it, but it never counts as an
// edit: no history step, no Edited badge, and Copy Settings and presets leave
// it out.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./broadcast", () => ({
  broadcast: vi.fn(),
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));
vi.mock("./edited-thumbnail", () => ({ regenerateEditedThumbnail: vi.fn() }));
vi.mock("@/modules/library/import-photos", () => ({ settlePendingMetadata: async () => {} }));

import { useDevelopStore } from "./develop-store";
import { useCatalogStore } from "./catalog-store";
import { setCatalogStorage } from "@/catalog/storage";
import { editTimeOf } from "@/catalog/edit-times";
import { defaultCopy, pasteLook } from "@/catalog/paste-look";
import { copySettingsSource } from "@/catalog/paste-settings";
import { DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";
import { installMemoryStorage, photo, snapshot, type MemoryEdits } from "@/catalog/stored-edit.fixtures";
import { registerProcessingStage, unregisterExtension } from "@/extensions/registry";
import { isComputedParam, withoutComputedParams } from "@/extensions/param-registry";
import { checkStageContract } from "@/extensions/stage-validation";
import type { ProcessingStageContribution } from "@/extensions/types";

const EXT = "acme.lens";
const K1 = "acme.lens.warp.k1";
const K2 = "acme.lens.warp.k2";
const AMOUNT = "acme.lens.warp.amount";

const WARP: ProcessingStageContribution = {
  id: "acme.lens.warp",
  name: "Warp",
  phase: "scene-linear",
  glsl: "c.rgb *= 1.0 + k1 * amount;",
  uniforms: [
    { key: "k1", glslType: "float", default: 0, computed: true },
    { key: "amount", glslType: "float", default: 0 },
  ],
  passes: [
    {
      uniforms: [{ key: "k2", glslType: "float", default: 0, computed: true }],
      glsl: "vec3 c = readPrev(vUv) * (1.0 + k2);",
    },
  ],
};

const A = "photo-a";
const B = "photo-b";

const s = () => useDevelopStore.getState();
const labels = () => s().history.map((h) => h.label);
const INITIAL = useDevelopStore.getState();

let storage: MemoryEdits;
const storedOf = (id: string) => storage.written.filter((e) => e.photoId === id).at(-1);

beforeEach(() => {
  useDevelopStore.setState(INITIAL, true);
  useCatalogStore.setState({ photos: [photo(A), photo(B)] });
  storage = installMemoryStorage();
  registerProcessingStage(EXT, WARP);
});

afterEach(() => {
  unregisterExtension(EXT);
  setCatalogStorage(null);
});

describe("declaring computed uniforms", () => {
  it("marks a stage's computed uniforms, inline and in its passes, and only those", () => {
    expect(isComputedParam(K1)).toBe(true);
    expect(isComputedParam(K2)).toBe(true);
    expect(isComputedParam(AMOUNT)).toBe(false);
  });

  it("forgets them once the extension is gone", () => {
    unregisterExtension(EXT);
    expect(isComputedParam(K1)).toBe(false);
  });

  it("strips them from a bag, keeping the bag itself when it holds none", () => {
    expect(withoutComputedParams({ [K1]: 1, [K2]: 2, [AMOUNT]: 3 })).toEqual({ [AMOUNT]: 3 });
    const plain = { [AMOUNT]: 3 };
    expect(withoutComputedParams(plain)).toBe(plain);
  });

  it("refuses a computed flag that isn't true or false", () => {
    const bad = { ...WARP, uniforms: [{ key: "k1", glslType: "float", default: 0, computed: "yes" }] };
    expect(checkStageContract(bad as unknown as ProcessingStageContribution, EXT).error).toMatch(/computed/);
  });
});

describe("a photo whose only change is computed values", () => {
  it("is left with no step and unedited, its values stored on the step it opened on", async () => {
    await s().loadEdit(A, 5000);
    s().setDynParams({ [K1]: 0.3, [K2]: 0.1 });
    await s().loadEdit(B, 5000);

    const stored = storedOf(A)!;
    expect(stored.stack.map((e) => e.label)).toEqual(["Original"]);
    expect(stored.currentIndex).toBe(0);
    expect(stored.stack[0].paramBag).toMatchObject({ [K1]: 0.3, [K2]: 0.1 });
    expect(editTimeOf(stored)).toBeUndefined();
  });

  it("refreshes the step it stands on in place, keeping its label and time", async () => {
    await s().loadEdit(A, 5000);
    s().setParam("contrast", 10);
    await s().commitEdit("Contrast");
    const made = s().history[1].timestamp;

    s().setDynParams({ [K1]: 0.5 });
    await s().commitEdit("Edit");

    expect(labels()).toEqual(["Original", "Contrast"]);
    expect(s().history[1].timestamp).toBe(made);
    expect(s().history[1].paramBag?.[K1]).toBe(0.5);
    const stored = storedOf(A)!;
    expect(stored.stack.map((e) => e.label)).toEqual(["Original", "Contrast"]);
    expect(stored.stack[1].paramBag?.[K1]).toBe(0.5);
    expect(editTimeOf(stored)).toBe(made);
  });

  it("writes nothing when the computed values are the ones already stored", async () => {
    storage = installMemoryStorage({
      photoId: A,
      stack: [snapshot("Original", { temperature: 5000 }, { [K1]: 0.3 })],
      currentIndex: 0,
    });
    await s().loadEdit(A, 5000);
    s().setDynParams({ [K1]: 0.3 });
    await s().commitEdit("Edit");
    expect(storage.written).toHaveLength(0);
  });
});

describe("a user change made with computed values", () => {
  it("makes one step holding both", async () => {
    await s().loadEdit(A, 5000);
    s().setDynParams({ [AMOUNT]: 1, [K1]: 0.4 });
    await s().commitEdit("Warp");

    expect(labels()).toEqual(["Original", "Warp"]);
    expect(s().history[1].paramBag).toMatchObject({ [AMOUNT]: 1, [K1]: 0.4 });
  });
});

describe("copying and presets", () => {
  it("pastes no computed value: the photo keeps its own", () => {
    const base = { params: DEFAULT_DEVELOP_PARAMS, paramBag: { [K1]: 0.3 } };
    const pasted = pasteLook(base, { params: {}, paramBag: { [K1]: 0.9, [K2]: 0.2, [AMOUNT]: 2 } });
    expect(pasted.paramBag).toEqual({ [K1]: 0.3, [AMOUNT]: 2 });
  });

  it("leaves computed values out of what Copy Settings offers", async () => {
    storage = installMemoryStorage({
      photoId: A,
      stack: [snapshot("Original", { temperature: 5000 }, { [K1]: 0.3, [AMOUNT]: 2 })],
      currentIndex: 0,
    });
    const source = await copySettingsSource(A);
    expect(source?.paramBag).toEqual({ [AMOUNT]: 2 });
    expect(defaultCopy({ params: DEFAULT_DEVELOP_PARAMS, paramBag: { [K1]: 0.3, [AMOUNT]: 2 } }).paramBag).toEqual({
      [AMOUNT]: 2,
    });
  });

  it("applies a preset's user values over the photo, never its computed ones", async () => {
    await s().loadEdit(A, 5000);
    s().setDynParams({ [K1]: 0.3 });
    await s().applyPreset({ ...DEFAULT_DEVELOP_PARAMS }, { [K1]: 0.9, [AMOUNT]: 2 });
    expect(s().paramBag).toMatchObject({ [K1]: 0.3, [AMOUNT]: 2 });

    s().setPreviewParams({ ...DEFAULT_DEVELOP_PARAMS }, { [K1]: 0.9, [AMOUNT]: 4 });
    expect(s().previewParamBag).toMatchObject({ [K1]: 0.3, [AMOUNT]: 4 });
  });
});
