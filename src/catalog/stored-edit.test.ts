// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Appending a snapshot to a stored edit without opening Develop: the baseline
// comes from the stored cursor, a refusal writes nothing, and the photo that is
// open in Develop is reloaded so its next commit can't overwrite the new step.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/broadcast", () => ({
  broadcast: vi.fn(),
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));
vi.mock("@/state/edited-thumbnail", () => ({ regenerateEditedThumbnail: vi.fn() }));

import { appendStoredSnapshot, type StoredLook } from "./stored-edit";
import { installMemoryStorage, legacySnapshot, photo, snapshot } from "./stored-edit.fixtures";
import { setCatalogStorage } from "./storage";
import { LEGACY_PROCESS_VERSION, freshParams, type EditSnapshot, type EditState } from "./types";
import { broadcast } from "@/state/broadcast";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore } from "@/state/develop-store";
import { registerCatalogHooks, useRegistry } from "@/extensions/registry";
import type { CatalogHooksContribution } from "@/extensions/types";

type EditCommitCtx = Parameters<NonNullable<CatalogHooksContribution["onEditCommit"]>>[0];

const PHOTO = "photo-1";
const BAG = { "ext.stage.amount": 40 };

const edit = (stack: EditSnapshot[], currentIndex: number, photoId = PHOTO): EditState => ({
  photoId,
  stack,
  currentIndex,
});
const labelsOf = (stack: EditSnapshot[]) => stack.map((s) => s.label);

// Raise exposure on whatever the stored cursor selects.
const brighter = (base: StoredLook): StoredLook => ({
  params: { ...base.params, exposure: 1 },
  paramBag: base.paramBag,
});

// zustand keeps the actions in state, so the pristine object doubles as the
// reset baseline (nothing mutates it in place).
const INITIAL = useDevelopStore.getState();

beforeEach(() => {
  useDevelopStore.setState(INITIAL, true);
  useCatalogStore.setState({ photos: [photo(PHOTO)] });
  vi.mocked(broadcast).mockClear();
});

afterEach(() => {
  setCatalogStorage(null);
  useRegistry.setState({ catalogHooks: {} });
});

describe("appendStoredSnapshot", () => {
  it("appends what next returns as one labelled snapshot with the cursor on it", async () => {
    const stored = edit(
      [snapshot("Original", {}), snapshot("Exposure", { exposure: 0.5 }, BAG)],
      1,
    );
    const { written } = installMemoryStorage(stored);

    const changed = await appendStoredSnapshot(PHOTO, 5200, "Test step", (base) => ({
      params: { ...base.params, contrast: 10 },
      paramBag: { ...base.paramBag, "ext.stage.radius": 2 },
    }));

    expect(changed).toBe(true);
    expect(written).toHaveLength(1);
    expect(labelsOf(written[0].stack)).toEqual(["Original", "Exposure", "Test step"]);
    expect(written[0].currentIndex).toBe(2);
    expect(written[0].stack[2].params).toEqual({ ...stored.stack[1].params, contrast: 10 });
    expect(written[0].stack[2].paramBag).toEqual({ ...BAG, "ext.stage.radius": 2 });
  });

  it("works from the snapshot under the stored cursor and drops what lies past it", async () => {
    const { written } = installMemoryStorage(
      edit(
        [
          snapshot("First", { exposure: 0.25 }),
          snapshot("Second", { exposure: 0.5 }),
          snapshot("Third", { exposure: 0.75 }),
        ],
        1,
      ),
    );
    const next = vi.fn(brighter);

    await appendStoredSnapshot(PHOTO, 5200, "Test step", next);

    expect(next.mock.calls[0][0].params.exposure).toBe(0.5);
    expect(labelsOf(written[0].stack)).toEqual(["First", "Second", "Test step"]);
    expect(written[0].currentIndex).toBe(2);
  });

  it("hands next an edit saved before process versions as version 1", async () => {
    installMemoryStorage(edit([legacySnapshot("Exposure", { exposure: 0.5 })], 0));
    const next = vi.fn(brighter);

    await appendStoredSnapshot(PHOTO, 5200, "Test step", next);

    expect(next.mock.calls[0][0].params.processVersion).toBe(LEGACY_PROCESS_VERSION);
    expect(next.mock.calls[0][0].params.exposure).toBe(0.5);
  });

  it.each([
    { stored: "no stored edit", state: undefined },
    { stored: "an empty stack", state: edit([], 0) },
  ])("starts from the as-shot defaults with $stored, under a seeded Original", async (row) => {
    const { written } = installMemoryStorage(...(row.state ? [row.state] : []));
    const next = vi.fn(brighter);

    await appendStoredSnapshot(PHOTO, 4300, "Test step", next);

    expect(next.mock.calls[0][0].params).toEqual(freshParams(4300));
    expect(next.mock.calls[0][0].paramBag).toEqual({});
    const { stack, currentIndex } = written[0];
    expect(labelsOf(stack)).toEqual(["Original", "Test step"]);
    expect(stack[0].params).toEqual(freshParams(4300));
    expect(stack[1].params.exposure).toBe(1);
    expect(currentIndex).toBe(1);
  });

  it("announces the new edit to extensions and the Library", async () => {
    installMemoryStorage(edit([snapshot("Original", {})], 0));
    const onEditCommit = vi.fn(async (_ctx: EditCommitCtx) => {});
    registerCatalogHooks("test-ext", { id: "test.hooks", onEditCommit });

    await appendStoredSnapshot(PHOTO, 5200, "Test step", brighter);

    expect(onEditCommit).toHaveBeenCalledTimes(1);
    const { photo: committed, editState } = onEditCommit.mock.calls[0][0];
    expect(committed.id).toBe(PHOTO);
    expect(labelsOf(editState.stack)).toEqual(["Original", "Test step"]);
    expect(broadcast).toHaveBeenCalledWith({
      type: "edit-update",
      payload: { photoId: PHOTO, params: editState.stack[1].params },
    });
  });

  it("writes and announces nothing when next declines", async () => {
    const { written } = installMemoryStorage(edit([snapshot("Original", {})], 0));
    const onEditCommit = vi.fn(async (_ctx: EditCommitCtx) => {});
    registerCatalogHooks("test-ext", { id: "test.hooks", onEditCommit });

    const changed = await appendStoredSnapshot(PHOTO, 5200, "Test step", () => null);

    expect(changed).toBe(false);
    expect(written).toHaveLength(0);
    expect(onEditCommit).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("seeds nothing for a never-edited photo when next declines", async () => {
    const { written } = installMemoryStorage();

    expect(await appendStoredSnapshot(PHOTO, 5200, "Test step", () => null)).toBe(false);
    expect(written).toHaveLength(0);
  });
});

describe("appendStoredSnapshot — the photo open in Develop", () => {
  const openInDevelop = async (photoId = PHOTO) => {
    await useDevelopStore.getState().loadEdit(photoId, 5200);
    return useDevelopStore.getState();
  };

  it("is reloaded, so Develop's history holds the stored step", async () => {
    installMemoryStorage(edit([snapshot("Original", {})], 0));
    await openInDevelop();

    await appendStoredSnapshot(PHOTO, 5200, "Test step", brighter);

    const develop = useDevelopStore.getState();
    expect(labelsOf(develop.history)).toEqual(["Original", "Test step"]);
    expect(develop.historyIndex).toBe(1);
    expect(develop.params.exposure).toBe(1);
  });

  it("keeps the stored step when Develop commits next", async () => {
    const { written } = installMemoryStorage(edit([snapshot("Original", {})], 0));
    await openInDevelop();
    await appendStoredSnapshot(PHOTO, 5200, "Test step", brighter);

    useDevelopStore.getState().setParam("contrast", 20);
    await useDevelopStore.getState().commitEdit("Contrast");

    const { stack } = written[written.length - 1];
    expect(labelsOf(stack)).toEqual(["Original", "Test step", "Contrast"]);
    expect(stack[2].params.exposure).toBe(1);
    expect(stack[2].params.contrast).toBe(20);
  });

  it("is reloaded with the as-shot temperature it was given", async () => {
    installMemoryStorage(edit([snapshot("Original", { temperature: 4300 })], 0));
    await openInDevelop();

    await appendStoredSnapshot(PHOTO, 4300, "Test step", brighter);

    expect(useDevelopStore.getState().asShotTemperature).toBe(4300);
  });

  it("leaves Develop alone while another photo is open", async () => {
    installMemoryStorage(
      edit([snapshot("Original", {})], 0),
      edit([snapshot("Original", {})], 0, "photo-2"),
    );
    const develop = await openInDevelop("photo-2");

    await appendStoredSnapshot(PHOTO, 5200, "Test step", brighter);

    expect(useDevelopStore.getState().photoId).toBe("photo-2");
    expect(useDevelopStore.getState().history).toBe(develop.history);
  });

  it("is left as it was when next declines", async () => {
    installMemoryStorage(edit([snapshot("Original", {})], 0));
    const develop = await openInDevelop();

    await appendStoredSnapshot(PHOTO, 5200, "Test step", () => null);

    expect(useDevelopStore.getState().history).toBe(develop.history);
  });
});
