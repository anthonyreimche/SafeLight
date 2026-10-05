// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Update processing for a Library selection: a photo whose stored edit is on the
// older processing gets one appended step that raises only the version, and a
// photo that is already current or was never edited is left untouched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/broadcast", () => ({
  broadcast: vi.fn(),
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));
vi.mock("@/state/edited-thumbnail", () => ({ regenerateEditedThumbnail: vi.fn() }));

import { updateProcessing } from "./update-processing";
import { installMemoryStorage, legacySnapshot, photo, snapshot } from "./stored-edit.fixtures";
import { setCatalogStorage } from "./storage";
import {
  CURRENT_PROCESS_VERSION,
  LEGACY_PROCESS_VERSION,
  type EditSnapshot,
  type EditState,
} from "./types";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore } from "@/state/develop-store";

const PHOTO = "photo-1";
const BAG = { "ext.stage.amount": 40 };

const edit = (stack: EditSnapshot[], currentIndex: number, photoId = PHOTO): EditState => ({
  photoId,
  stack,
  currentIndex,
});
const olderSnapshot = (label: string, exposure: number, bag?: Record<string, unknown>) =>
  snapshot(label, { exposure, processVersion: LEGACY_PROCESS_VERSION }, bag);
const labelsOf = (stack: EditSnapshot[]) => stack.map((s) => s.label);

// zustand keeps the actions in state, so the pristine object doubles as the
// reset baseline (nothing mutates it in place).
const INITIAL = useDevelopStore.getState();

beforeEach(() => {
  useDevelopStore.setState(INITIAL, true);
  useCatalogStore.setState({ photos: [photo(PHOTO)] });
});

afterEach(() => setCatalogStorage(null));

describe("updateProcessing", () => {
  it("appends one step that raises only the version, with the cursor on it", async () => {
    const stored = edit([olderSnapshot("Original", 0), olderSnapshot("Exposure", 1, BAG)], 1);
    const { written } = installMemoryStorage(stored);

    expect(await updateProcessing([PHOTO])).toBe(1);

    expect(written).toHaveLength(1);
    const { stack, currentIndex } = written[0];
    expect(labelsOf(stack)).toEqual(["Original", "Exposure", "Update processing"]);
    expect(currentIndex).toBe(2);
    expect(stack.slice(0, 2)).toEqual(stored.stack);
    expect(stack[2].params).toEqual({
      ...stored.stack[1].params,
      processVersion: CURRENT_PROCESS_VERSION,
    });
    expect(stack[2].paramBag).toEqual(BAG);
  });

  it("reads an edit that stores no version as the older processing", async () => {
    const { written } = installMemoryStorage(
      edit([legacySnapshot("Exposure", { exposure: 1 })], 0),
    );

    expect(await updateProcessing([PHOTO])).toBe(1);

    const top = written[0].stack[1];
    expect(top.label).toBe("Update processing");
    expect(top.params.exposure).toBe(1);
    expect(top.params.processVersion).toBe(CURRENT_PROCESS_VERSION);
  });

  it("works from the snapshot under the cursor and drops what lies past it", async () => {
    const { written } = installMemoryStorage(
      edit(
        [olderSnapshot("First", 0.25), olderSnapshot("Second", 0.5), olderSnapshot("Third", 0.75)],
        1,
      ),
    );

    await updateProcessing([PHOTO]);

    const { stack, currentIndex } = written[0];
    expect(labelsOf(stack)).toEqual(["First", "Second", "Update processing"]);
    expect(stack[2].params.exposure).toBe(0.5);
    expect(currentIndex).toBe(2);
  });

  it.each([
    { cursor: 1, on: "the current processing", outcome: "leaves it alone", changed: 0 },
    { cursor: 0, on: "the older processing", outcome: "updates it", changed: 1 },
  ])("a cursor on $on $outcome", async (row) => {
    const { written } = installMemoryStorage(
      edit([olderSnapshot("Older", 0.5), snapshot("Updated", { exposure: 0.5 })], row.cursor),
    );

    expect(await updateProcessing([PHOTO])).toBe(row.changed);
    expect(written).toHaveLength(row.changed);
  });

  it("leaves a current edit and a never-edited photo untouched", async () => {
    useCatalogStore.setState({ photos: [photo(PHOTO), photo("photo-2")] });
    const { written } = installMemoryStorage(edit([snapshot("Exposure", { exposure: 1 })], 0));

    expect(await updateProcessing([PHOTO, "photo-2"])).toBe(0);
    expect(written).toHaveLength(0);
  });

  it("counts only the photos it changed", async () => {
    useCatalogStore.setState({
      photos: ["a", "b", "c", "d"].map((id) => photo(id)),
    });
    const { written } = installMemoryStorage(
      edit([olderSnapshot("Exposure", 1)], 0, "a"),
      edit([snapshot("Exposure", { exposure: 1 })], 0, "b"),
      // "c" was never edited, and "gone" is not in the catalog.
      edit([olderSnapshot("Exposure", 2)], 0, "d"),
    );

    expect(await updateProcessing(["a", "b", "c", "gone", "d"])).toBe(2);
    expect(written.map((s) => s.photoId)).toEqual(["a", "d"]);
  });

  it("does nothing for an empty selection", async () => {
    const { written } = installMemoryStorage(edit([olderSnapshot("Exposure", 1)], 0));

    expect(await updateProcessing([])).toBe(0);
    expect(written).toHaveLength(0);
  });

  it("reloads the photo open in Develop on the current processing", async () => {
    useCatalogStore.setState({
      photos: [{ ...photo(PHOTO), exif: { colorTemperature: 4300 } }],
    });
    installMemoryStorage(edit([olderSnapshot("Exposure", 1)], 0));
    await useDevelopStore.getState().loadEdit(PHOTO, 4300);
    expect(useDevelopStore.getState().params.processVersion).toBe(LEGACY_PROCESS_VERSION);

    await updateProcessing([PHOTO]);

    const develop = useDevelopStore.getState();
    expect(develop.params.processVersion).toBe(CURRENT_PROCESS_VERSION);
    expect(develop.params.exposure).toBe(1);
    expect(labelsOf(develop.history)).toEqual(["Original", "Exposure", "Update processing"]);
    expect(develop.historyIndex).toBe(2);
    expect(develop.asShotTemperature).toBe(4300);
  });
});
