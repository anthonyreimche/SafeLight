// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Steps carry the extension that made them, and an extension's local undo,
// redo and jump (#281) are steps of the photo's history in its name that move
// only its own values. The renderer broadcast and the grid-thumbnail regen are
// stubbed; persistence runs against the in-memory catalogue storage.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./broadcast", () => ({
  broadcast: vi.fn(),
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));
vi.mock("./edited-thumbnail", () => ({ regenerateEditedThumbnail: vi.fn() }));

import { commitsAs, useDevelopStore } from "./develop-store";
import { useCatalogStore } from "./catalog-store";
import { setCatalogStorage } from "@/catalog/storage";
import { normalizeParams } from "@/catalog/types";
import { installMemoryStorage, photo, type MemoryEdits } from "@/catalog/stored-edit.fixtures";
import { localHistory } from "./local-history";

const PHOTO_ID = "photo-1";
const INITIAL = useDevelopStore.getState();

const s = () => useDevelopStore.getState();
const top = () => s().history[s().historyIndex];
const local = (source: string) => localHistory(s().history, s().historyIndex, source);

let storage: MemoryEdits;

beforeEach(async () => {
  useDevelopStore.setState(INITIAL, true);
  useCatalogStore.setState({ photos: [photo(PHOTO_ID)] });
  storage = installMemoryStorage();
  await s().loadEdit(PHOTO_ID, 5000);
});

afterEach(() => {
  setCatalogStorage(null);
});

async function edit(source: string, label: string, patch: Parameters<typeof normalizeParams>[0]): Promise<void> {
  for (const [key, value] of Object.entries(patch ?? {})) s().setParam(key as "exposure", value as number);
  await commitsAs(source, () => s().commitEdit(label));
}

describe("a step's source", () => {
  it("is the extension a commit was made for, in memory and stored", async () => {
    await edit("basic", "Exposure", { exposure: 1 });
    expect(top().source).toBe("basic");
    expect(storage.singles.at(-1)?.stack.at(-1)?.source).toBe("basic");
  });

  it("is left off a commit made outside any extension", async () => {
    s().setParam("exposure", 1);
    await s().commitEdit("Exposure");
    expect(top()).not.toHaveProperty("source");
  });

  it("is taken by the steps resetParams, restoreEdit and applyPreset commit", async () => {
    await edit("basic", "Exposure", { exposure: 1 });
    await commitsAs("basic", () => s().resetParams(["exposure"], "Reset Exposure"));
    expect(top()).toMatchObject({ label: "Reset Exposure", source: "basic" });
    await commitsAs("snapshots", () => s().restoreEdit({ params: normalizeParams({ contrast: 5 }) }, "Snapshot A"));
    expect(top()).toMatchObject({ label: "Snapshot A", source: "snapshots" });
    await commitsAs("presets", () => s().applyPreset(normalizeParams({ contrast: 9 })));
    expect(top().source).toBe("presets");
  });

  it("is not carried into a commit started after the call returns", async () => {
    await commitsAs("basic", async () => {});
    s().setParam("exposure", 2);
    await s().commitEdit("Exposure");
    expect(top()).not.toHaveProperty("source");
  });
});

describe("local undo and redo", () => {
  beforeEach(async () => {
    await edit("basic", "Exposure", { exposure: 1 });
    await edit("basic", "Contrast", { contrast: 20 });
    await edit("hsl", "Saturation", { saturation: 15 });
  });

  it("takes back the extension's last step as a new step in its name, keeping later edits", async () => {
    const length = s().history.length;
    await s().localUndo("basic");
    expect(s().history).toHaveLength(length + 1);
    expect(top()).toMatchObject({ label: "Undo Contrast", source: "basic", local: { to: 1 } });
    expect(s().params).toMatchObject({ exposure: 1, contrast: 0, saturation: 15 });
    expect(local("basic").cursor).toBe(0);
    expect(storage.singles.at(-1)?.stack.at(-1)?.label).toBe("Undo Contrast");
  });

  it("brings it back with local redo", async () => {
    await s().localUndo("basic");
    await s().localRedo("basic");
    expect(top()).toMatchObject({ label: "Redo Contrast", source: "basic" });
    expect(s().params).toMatchObject({ exposure: 1, contrast: 20, saturation: 15 });
    expect(local("basic").cursor).toBe(1);
  });

  it("goes back before the extension's first step and no further", async () => {
    await s().localUndo("basic");
    await s().localUndo("basic");
    expect(s().params).toMatchObject({ exposure: 0, contrast: 0, saturation: 15 });
    const length = s().history.length;
    await s().localUndo("basic");
    expect(s().history).toHaveLength(length);
  });

  it("has nothing to redo at the extension's latest step", async () => {
    const length = s().history.length;
    await s().localRedo("basic");
    expect(s().history).toHaveLength(length);
  });

  it("jumps to any of the extension's steps in one move", async () => {
    await s().goToLocalHistory("basic", -1);
    expect(top().label).toBe("Undo to Original");
    expect(s().params).toMatchObject({ exposure: 0, contrast: 0, saturation: 15 });
    await s().goToLocalHistory("basic", 1);
    expect(top().label).toBe("Redo to Contrast");
    expect(s().params).toMatchObject({ exposure: 1, contrast: 20 });
  });

  it("is itself undone by the global undo", async () => {
    await s().localUndo("basic");
    s().undo();
    expect(s().params).toMatchObject({ exposure: 1, contrast: 20, saturation: 15 });
    expect(local("basic").cursor).toBe(1);
  });

  it("does nothing for an extension with no steps", async () => {
    const length = s().history.length;
    await s().localUndo("effects");
    await s().goToLocalHistory("effects", 0);
    expect(s().history).toHaveLength(length);
  });
});
