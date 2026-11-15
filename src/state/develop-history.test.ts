// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A commit that changes nothing must leave the history alone: a stray click
// after an undo would otherwise add a duplicate step and throw away the redo
// steps. The renderer broadcast and the grid-thumbnail regen are stubbed;
// persistence runs against the in-memory catalogue storage.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./broadcast", () => ({
  broadcast: vi.fn(),
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));
vi.mock("./edited-thumbnail", () => ({ regenerateEditedThumbnail: vi.fn() }));

import { useDevelopStore } from "./develop-store";
import { broadcast } from "./broadcast";
import { regenerateEditedThumbnail } from "./edited-thumbnail";
import { useCatalogStore } from "./catalog-store";
import { setCatalogStorage } from "@/catalog/storage";
import {
  installMemoryStorage,
  legacySnapshot,
  photo,
  snapshot,
  type MemoryEdits,
} from "@/catalog/stored-edit.fixtures";

const PHOTO_ID = "photo-1";

const s = () => useDevelopStore.getState();
const labels = () => s().history.map((h) => h.label);

const INITIAL = useDevelopStore.getState();

let storage: MemoryEdits;

beforeEach(() => {
  useDevelopStore.setState(INITIAL, true);
  useCatalogStore.setState({ photos: [photo(PHOTO_ID)] });
  storage = installMemoryStorage();
});

afterEach(() => {
  setCatalogStorage(null);
});

describe("a commit after undo", () => {
  beforeEach(async () => {
    await s().loadEdit(PHOTO_ID, 5000);
    for (const contrast of [10, 20, 30]) {
      s().setParam("contrast", contrast);
      await s().commitEdit("Contrast");
    }
    s().undo();
    s().undo();
    expect(s().canRedo()).toBe(true);
    vi.mocked(broadcast).mockClear();
    vi.mocked(regenerateEditedThumbnail).mockClear();
  });

  it("adds nothing and keeps the redo steps when nothing changed", async () => {
    const singles = storage.singles.length;
    await s().commitEdit("Exposure");

    expect(labels()).toEqual(["Original", "Contrast", "Contrast", "Contrast"]);
    expect(s().historyIndex).toBe(1);
    expect(s().canRedo()).toBe(true);
    expect(storage.singles).toHaveLength(singles);
    expect(regenerateEditedThumbnail).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("still appends a real change and drops the redo steps", async () => {
    const singles = storage.singles.length;
    s().setParam("contrast", 50);
    await s().commitEdit("Contrast");

    expect(labels()).toEqual(["Original", "Contrast", "Contrast"]);
    expect(s().historyIndex).toBe(2);
    expect(s().canRedo()).toBe(false);
    expect(storage.singles).toHaveLength(singles + 1);
  });
});

describe("a commit on a stored stack", () => {
  it("adds nothing when nothing changed since the photo opened", async () => {
    storage = installMemoryStorage({
      photoId: PHOTO_ID,
      stack: [
        snapshot("Original", {}),
        snapshot("Exposure", { exposure: 1 }, { "a.stage.k": 2 }),
      ],
      currentIndex: 1,
    });
    await s().loadEdit(PHOTO_ID, 5000);
    await s().commitEdit("Exposure");

    expect(labels()).toEqual(["Original", "Exposure"]);
    expect(storage.singles).toHaveLength(0);
  });

  it("adds nothing on a stack saved before process versions", async () => {
    storage = installMemoryStorage({
      photoId: PHOTO_ID,
      stack: [legacySnapshot("Exposure", { exposure: 1 })],
      currentIndex: 0,
    });
    await s().loadEdit(PHOTO_ID, 5000);
    await s().commitEdit("Exposure");

    expect(labels()).toEqual(["Original", "Exposure"]);
    expect(storage.singles).toHaveLength(0);
  });
});

// A History panel jumps straight to any step: one look change, one broadcast and
// one stored cursor, never a run of single steps whose writes could land out of order.
describe("going to a step", () => {
  beforeEach(async () => {
    await s().loadEdit(PHOTO_ID, 5000);
    for (const contrast of [10, 20, 30]) {
      s().setParam("contrast", contrast);
      await s().commitEdit("Contrast");
    }
    vi.mocked(broadcast).mockClear();
  });

  it("shows an earlier step and stores its cursor in one write", () => {
    const singles = storage.singles.length;
    s().goToHistory(1);

    expect(s().historyIndex).toBe(1);
    expect(s().params.contrast).toBe(10);
    expect(labels()).toEqual(["Original", "Contrast", "Contrast", "Contrast"]);
    expect(storage.singles).toHaveLength(singles + 1);
    expect(storage.singles.at(-1)?.currentIndex).toBe(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("goes forward over several redo steps", () => {
    s().goToHistory(0);
    s().goToHistory(3);

    expect(s().historyIndex).toBe(3);
    expect(s().params.contrast).toBe(30);
    expect(storage.singles.at(-1)?.currentIndex).toBe(3);
  });

  it("does nothing for the step shown, a step outside the history or a fraction", () => {
    const singles = storage.singles.length;
    for (const index of [3, -1, 4, 1.5, NaN]) s().goToHistory(index);

    expect(s().historyIndex).toBe(3);
    expect(storage.singles).toHaveLength(singles);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("does nothing while the photo's stored edit couldn't be read", () => {
    useDevelopStore.setState({ editError: "Couldn't read the file." });
    s().goToHistory(0);

    expect(s().historyIndex).toBe(3);
  });

  it("leaves undo and redo stepping one at a time", () => {
    s().goToHistory(1);
    s().redo();
    expect(s().params.contrast).toBe(20);
    s().undo();
    s().undo();
    expect(s().historyIndex).toBe(0);
    expect(s().canUndo()).toBe(false);
  });
});
