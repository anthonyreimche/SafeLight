// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Appending a snapshot to a stored edit without opening Develop: the baseline
// comes from the stored cursor, a refusal writes nothing, and the photo that is
// open in Develop is reloaded so its next commit can't overwrite the new step.
// Many photos at once go to the catalog in one write.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/broadcast", () => ({
  broadcast: vi.fn(),
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));
vi.mock("@/state/edited-thumbnail", () => ({ regenerateEditedThumbnail: vi.fn() }));

import {
  appendStoredSnapshot,
  appendStoredSnapshots,
  storedSnapshotTargets,
  type StoredLook,
  type StoredSnapshotTarget,
} from "./stored-edit";
import { installMemoryStorage, legacySnapshot, photo, snapshot } from "./stored-edit.fixtures";
import { catalogStorage, setCatalogStorage } from "./storage";
import {
  LEGACY_PROCESS_VERSION,
  NEUTRAL_TEMPERATURE_K,
  freshParams,
  type EditSnapshot,
  type EditState,
} from "./types";
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
// Declines a photo that is already as bright as the step would make it.
const brightenOnce = (base: StoredLook): StoredLook | null =>
  base.params.exposure === 1 ? null : brighter(base);
const original = (photoId: string) => edit([snapshot("Original", {})], 0, photoId);

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

  it("keeps the stored step when Develop commits while it is being saved", async () => {
    const { written } = installMemoryStorage(edit([snapshot("Original", {})], 0));
    await openInDevelop();
    // The storage holds the edit at once and saves it after (as ProjectStorage does).
    const storage = catalogStorage();
    const store = storage.putEditStates.bind(storage);
    let saved = (): void => {};
    const saving = new Promise<void>((resolve) => (saved = resolve));
    vi.spyOn(storage, "putEditStates").mockImplementationOnce(async (editStates) => {
      await store(editStates);
      await saving;
    });

    const appending = appendStoredSnapshot(PHOTO, 5200, "Test step", brighter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    useDevelopStore.getState().setParam("contrast", 20);
    await useDevelopStore.getState().commitEdit("Contrast");
    saved();
    await appending;

    const { stack } = written[written.length - 1];
    expect(labelsOf(stack)).toEqual(["Original", "Test step", "Contrast"]);
    expect(labelsOf(useDevelopStore.getState().history)).toEqual([
      "Original",
      "Test step",
      "Contrast",
    ]);
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

describe("appendStoredSnapshots", () => {
  const IDS = ["a", "b", "c"];
  const targetsOf = (...ids: string[]): StoredSnapshotTarget[] =>
    ids.map((photoId) => ({ photoId, asShot: 5200 }));
  const hookOnCommit = () => {
    const onEditCommit = vi.fn(async (_ctx: EditCommitCtx) => {});
    registerCatalogHooks("test-ext", { id: "test.hooks", onEditCommit });
    return onEditCommit;
  };

  beforeEach(() => {
    useCatalogStore.setState({ photos: IDS.map((id) => photo(id)) });
  });

  afterEach(() => vi.restoreAllMocks());

  it("stores every photo's new state with one putEditStates call", async () => {
    const { batches, singles } = installMemoryStorage(
      original("a"),
      edit([snapshot("Original", {}), snapshot("Exposure", { exposure: 0.5 })], 1, "b"),
    ); // "c" was never edited

    const changed = await appendStoredSnapshots(targetsOf(...IDS), "Test step", brighter);

    expect(changed).toBe(3);
    expect(singles).toHaveLength(0);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((state) => state.photoId)).toEqual(IDS);
    expect(batches[0].map((state) => labelsOf(state.stack))).toEqual([
      ["Original", "Test step"],
      ["Original", "Exposure", "Test step"],
      ["Original", "Test step"],
    ]);
    expect(batches[0].map((state) => state.currentIndex)).toEqual([1, 2, 1]);
  });

  it("works each photo out from its own stored edit", async () => {
    const { batches } = installMemoryStorage(
      edit(
        [
          snapshot("First", { exposure: 0.25 }),
          snapshot("Second", { exposure: 0.5 }),
          snapshot("Third", { exposure: 0.75 }),
        ],
        1,
        "a",
      ),
    );
    const next = vi.fn(brighter);

    await appendStoredSnapshots(
      [
        { photoId: "a", asShot: 5200 },
        { photoId: "c", asShot: 4300 },
      ],
      "Test step",
      next,
    );

    // "a" continues from the snapshot under its cursor and drops what lay past it.
    expect(next.mock.calls[0][0].params.exposure).toBe(0.5);
    expect(labelsOf(batches[0][0].stack)).toEqual(["First", "Second", "Test step"]);
    // "c" was never edited, so it starts from its own as-shot temperature.
    expect(next.mock.calls[1][0].params).toEqual(freshParams(4300));
    expect(batches[0][1].stack[0].params).toEqual(freshParams(4300));
    expect(labelsOf(batches[0][1].stack)).toEqual(["Original", "Test step"]);
  });

  it("leaves the photos next declines out of the batch and out of the announcements", async () => {
    const { batches } = installMemoryStorage(
      original("a"),
      edit([snapshot("Exposure", { exposure: 1 })], 0, "b"),
      original("c"),
    );
    const onEditCommit = hookOnCommit();

    const changed = await appendStoredSnapshots(targetsOf(...IDS), "Test step", brightenOnce);

    expect(changed).toBe(2);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((state) => state.photoId)).toEqual(["a", "c"]);
    expect(onEditCommit.mock.calls.map(([ctx]) => ctx.photo.id)).toEqual(["a", "c"]);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it("writes and announces nothing when next declines every photo", async () => {
    const { batches, singles } = installMemoryStorage(original("a"));
    const onEditCommit = hookOnCommit();

    expect(await appendStoredSnapshots(targetsOf("a", "b"), "Test step", () => null)).toBe(0);

    expect(batches).toHaveLength(0);
    expect(singles).toHaveLength(0);
    expect(onEditCommit).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("does nothing for no photos", async () => {
    const { batches, singles } = installMemoryStorage();
    const next = vi.fn(brighter);

    expect(await appendStoredSnapshots([], "Test step", next)).toBe(0);

    expect(next).not.toHaveBeenCalled();
    expect(batches).toHaveLength(0);
    expect(singles).toHaveLength(0);
  });

  it("announces each stored photo once, after the whole batch is written", async () => {
    const memory = installMemoryStorage(original("a"), original("b"));
    const storedBeforeHook: number[] = [];
    const onEditCommit = vi.fn(async (_ctx: EditCommitCtx) => {
      storedBeforeHook.push(memory.written.length);
    });
    registerCatalogHooks("test-ext", { id: "test.hooks", onEditCommit });

    await appendStoredSnapshots(targetsOf("a", "b"), "Test step", brighter);

    expect(onEditCommit).toHaveBeenCalledTimes(2);
    expect(storedBeforeHook).toEqual([2, 2]);
    memory.batches[0].forEach((state, i) => {
      const { photo: committed, editState } = onEditCommit.mock.calls[i][0];
      expect(committed.id).toBe(state.photoId);
      expect(editState).toEqual(state);
      expect(broadcast).toHaveBeenCalledWith({
        type: "edit-update",
        payload: { photoId: state.photoId, params: state.stack[state.currentIndex].params },
      });
    });
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it("handles a photo listed twice once", async () => {
    const { batches } = installMemoryStorage(original("a"));
    const onEditCommit = hookOnCommit();

    expect(await appendStoredSnapshots(targetsOf("a", "a"), "Test step", brighter)).toBe(1);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(onEditCommit).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("writes and announces none of the photos when working one out fails", async () => {
    const { written } = installMemoryStorage(original("a"), original("b"));
    const onEditCommit = hookOnCommit();
    let seen = 0;
    const failsOnSecond = (base: StoredLook): StoredLook => {
      if (++seen === 2) throw new Error("next failed");
      return brighter(base);
    };

    await expect(
      appendStoredSnapshots(targetsOf("a", "b"), "Test step", failsOnSecond),
    ).rejects.toThrow("next failed");

    expect(written).toHaveLength(0);
    expect(onEditCommit).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("announces the other photos when announcing one throws, and logs it", async () => {
    installMemoryStorage(original("a"), original("b"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error("listener failed");
    vi.mocked(broadcast).mockImplementationOnce(() => {
      throw failure;
    });
    const onEditCommit = hookOnCommit();

    expect(await appendStoredSnapshots(targetsOf("a", "b"), "Test step", brighter)).toBe(2);

    expect(onEditCommit.mock.calls.map(([ctx]) => ctx.photo.id)).toEqual(["a", "b"]);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.any(String), failure);
  });

  it("announces nothing when the write fails", async () => {
    installMemoryStorage(original("a"));
    vi.spyOn(catalogStorage(), "putEditStates").mockRejectedValue(new Error("disk full"));
    const onEditCommit = hookOnCommit();

    await expect(
      appendStoredSnapshots(targetsOf("a"), "Test step", brighter),
    ).rejects.toThrow("disk full");

    expect(onEditCommit).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe("appendStoredSnapshots — the photo open in Develop", () => {
  const targets: StoredSnapshotTarget[] = [
    { photoId: "a", asShot: 5200 },
    { photoId: "b", asShot: 4300 },
  ];
  // Counts the reloads without replacing them.
  const watchReloads = () => {
    const loadEdit = vi.fn(useDevelopStore.getState().loadEdit);
    useDevelopStore.setState({ loadEdit });
    return loadEdit;
  };

  beforeEach(() => {
    useCatalogStore.setState({ photos: [photo("a"), photo("b")] });
  });

  it("is reloaded once, with the as-shot temperature it was given", async () => {
    installMemoryStorage(original("a"), original("b"));
    await useDevelopStore.getState().loadEdit("b", 4300);
    const loadEdit = watchReloads();

    await appendStoredSnapshots(targets, "Test step", brighter);

    expect(loadEdit).toHaveBeenCalledTimes(1);
    expect(loadEdit).toHaveBeenCalledWith("b", 4300);
    const develop = useDevelopStore.getState();
    expect(develop.photoId).toBe("b");
    expect(labelsOf(develop.history)).toEqual(["Original", "Test step"]);
    expect(develop.historyIndex).toBe(1);
  });

  it("holds its new step before any photo's hooks run", async () => {
    installMemoryStorage(original("a"), original("b"));
    await useDevelopStore.getState().loadEdit("b", 4300);
    const historyInHook: string[][] = [];
    registerCatalogHooks("test-ext", {
      id: "test.hooks",
      onEditCommit: async () => {
        historyInHook.push(labelsOf(useDevelopStore.getState().history));
      },
    });

    await appendStoredSnapshots(targets, "Test step", brighter);

    // A hook is awaited, and a commit or undo meanwhile writes Develop's history back.
    expect(historyInHook).toEqual([
      ["Original", "Test step"],
      ["Original", "Test step"],
    ]);
  });

  it("keeps the step when Develop commits while the first photo's hooks run", async () => {
    const { written } = installMemoryStorage(original("a"), original("b"));
    await useDevelopStore.getState().loadEdit("b", 4300);
    registerCatalogHooks("test-ext", {
      id: "test.hooks",
      onEditCommit: async ({ photo: committed }) => {
        if (committed.id !== "a") return;
        useDevelopStore.getState().setParam("contrast", 20);
        await useDevelopStore.getState().commitEdit("Contrast");
      },
    });

    await appendStoredSnapshots(targets, "Test step", brighter);

    const { stack } = written[written.length - 1];
    expect(labelsOf(stack)).toEqual(["Original", "Test step", "Contrast"]);
    expect(stack[2].params.exposure).toBe(1);
  });

  it("is not reloaded when its photo is among those next declines", async () => {
    installMemoryStorage(original("a"), edit([snapshot("Exposure", { exposure: 1 })], 0, "b"));
    await useDevelopStore.getState().loadEdit("b", 4300);
    const loadEdit = watchReloads();

    await appendStoredSnapshots(targets, "Test step", brightenOnce);

    expect(loadEdit).not.toHaveBeenCalled();
  });

  it("is not reloaded when another photo is open", async () => {
    installMemoryStorage(original("a"), original("b"), original("c"));
    useCatalogStore.setState({ photos: [photo("a"), photo("b"), photo("c")] });
    await useDevelopStore.getState().loadEdit("c", 5200);
    const loadEdit = watchReloads();

    await appendStoredSnapshots(targets, "Test step", brighter);

    expect(loadEdit).not.toHaveBeenCalled();
    expect(useDevelopStore.getState().photoId).toBe("c");
  });
});

describe("storedSnapshotTargets", () => {
  it("lists the catalog photos among the ids, in order, with their as-shot temperature", () => {
    useCatalogStore.setState({
      photos: [photo("a"), { ...photo("b"), exif: { colorTemperature: 4300 } }],
    });

    expect(storedSnapshotTargets(["b", "gone", "a"])).toEqual([
      { photoId: "b", asShot: 4300 },
      { photoId: "a", asShot: NEUTRAL_TEMPERATURE_K },
    ]);
  });
});
