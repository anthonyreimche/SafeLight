// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Paste settings onto Library photos: the pasted subset merges over each
// photo's look, a paste never moves a photo between process versions, and the
// whole selection is stored in one catalog write.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pasteSettings } from "./paste-settings";
import { installMemoryStorage, photo } from "./stored-edit.fixtures";
import { setCatalogStorage } from "./storage";
import {
  CURRENT_PROCESS_VERSION,
  LEGACY_PROCESS_VERSION,
  freshParams,
  type DevelopParams,
  type EditState,
} from "./types";
import { broadcast } from "@/state/broadcast";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore } from "@/state/develop-store";
import { registerCatalogHooks, useRegistry } from "@/extensions/registry";
import type { CatalogHooksContribution } from "@/extensions/types";

type EditCommitCtx = Parameters<NonNullable<CatalogHooksContribution["onEditCommit"]>>[0];

vi.mock("@/state/broadcast", () => ({
  broadcast: vi.fn(),
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

// zustand keeps the actions in state, so the pristine object doubles as the
// reset baseline (nothing mutates it in place).
const INITIAL_DEVELOP = useDevelopStore.getState();

const PHOTO = "photo-1";

let written: EditState[];

function install(seed?: EditState): void {
  written = installMemoryStorage(...(seed ? [seed] : [])).written;
}

const clip = (params: Partial<DevelopParams>) => ({
  params,
  paramBag: {},
  sourceName: "source.jpg",
  fieldCount: Object.keys(params).length,
});

beforeEach(() => {
  useCatalogStore.setState({ photos: [photo(PHOTO)] });
});

afterEach(() => {
  setCatalogStorage(null);
  useDevelopStore.setState(INITIAL_DEVELOP, true);
});

describe("pasteSettings — process versions", () => {
  it("starts a never-edited photo at the current version", async () => {
    install();
    await pasteSettings([PHOTO], clip({ exposure: 1 }));
    const { stack } = written.at(-1)!;
    expect(stack[0].label).toBe("Original");
    expect(stack[0].params.processVersion).toBe(CURRENT_PROCESS_VERSION);
    const top = stack.at(-1)!;
    expect(top.params.exposure).toBe(1);
    expect(top.params.processVersion).toBe(CURRENT_PROCESS_VERSION);
  });

  it("keeps an old edit at version 1 even when the clipboard carries a version", async () => {
    install({
      photoId: PHOTO,
      currentIndex: 0,
      // Written by a build from before process versions: no version field.
      stack: [{ timestamp: 0, label: "Edit", params: { exposure: 0.5 } as DevelopParams }],
    });
    await pasteSettings([PHOTO], clip({ contrast: 10, processVersion: 2 }));
    const top = written.at(-1)!.stack.at(-1)!;
    expect(top.params.contrast).toBe(10);
    expect(top.params.exposure).toBe(0.5);
    expect(top.params.processVersion).toBe(LEGACY_PROCESS_VERSION);
  });
});

describe("pasteSettings — a stored cursor outside its stack", () => {
  const stackWithCursor = (currentIndex: number): EditState => ({
    photoId: PHOTO,
    currentIndex,
    stack: [
      { timestamp: 0, label: "First", params: { exposure: 0.25 } as DevelopParams },
      { timestamp: 0, label: "Second", params: { exposure: 0.5 } as DevelopParams },
    ],
  });

  it.each([
    { cursor: 7, base: "last", exposure: 0.5, labels: ["First", "Second", "Paste Settings"] },
    { cursor: NaN, base: "newest", exposure: 0.5, labels: ["First", "Second", "Paste Settings"] },
    { cursor: -3, base: "first", exposure: 0.25, labels: ["First", "Paste Settings"] },
  ])("merges over the $base snapshot when the cursor is $cursor", async ({ cursor, exposure, labels }) => {
    install(stackWithCursor(cursor));
    await pasteSettings([PHOTO], clip({ contrast: 10 }));
    const { stack } = written.at(-1)!;
    expect(stack.map((snap) => snap.label)).toEqual(labels);
    expect(stack.at(-1)!.params.exposure).toBe(exposure);
    expect(stack.at(-1)!.params.contrast).toBe(10);
  });
});

describe("pasteSettings — the photo open in Develop", () => {
  const seed = (): EditState => ({
    photoId: PHOTO,
    currentIndex: 0,
    stack: [{ timestamp: 0, label: "Original", params: freshParams() }],
  });

  it("is reloaded, so Develop's history holds the pasted step", async () => {
    install(seed());
    await useDevelopStore.getState().loadEdit(PHOTO);

    await pasteSettings([PHOTO], clip({ contrast: 10 }));

    const develop = useDevelopStore.getState();
    expect(develop.history.map((snap) => snap.label)).toEqual(["Original", "Paste Settings"]);
    expect(develop.historyIndex).toBe(1);
    expect(develop.params.contrast).toBe(10);
  });

  it("is left alone when another photo is open", async () => {
    install(seed());
    useCatalogStore.setState({ photos: [photo(PHOTO), photo("photo-2")] });
    await useDevelopStore.getState().loadEdit("photo-2");
    const { history } = useDevelopStore.getState();

    await pasteSettings([PHOTO], clip({ contrast: 10 }));

    expect(useDevelopStore.getState().history).toBe(history);
  });
});

describe("pasteSettings — one catalog write for the selection", () => {
  const IDS = ["a", "b", "c"];
  const original = (photoId: string): EditState => ({
    photoId,
    currentIndex: 0,
    stack: [{ timestamp: 0, label: "Original", params: freshParams() }],
  });
  // "b" was never edited.
  const seed = () => installMemoryStorage(original("a"), original("c"));

  beforeEach(() => {
    useCatalogStore.setState({ photos: IDS.map((id) => photo(id)) });
    vi.mocked(broadcast).mockClear();
  });

  afterEach(() => useRegistry.setState({ catalogHooks: {} }));

  it("stores every photo with one putEditStates call and no putEditState call", async () => {
    const { batches, singles } = seed();

    expect(await pasteSettings([...IDS, "gone"], clip({ contrast: 10 }))).toBe(3);

    expect(batches).toHaveLength(1);
    expect(batches[0].map((state) => state.photoId)).toEqual(IDS);
    expect(singles).toHaveLength(0);
    for (const { stack, currentIndex } of batches[0]) {
      expect(stack[currentIndex].label).toBe("Paste Settings");
      expect(stack[currentIndex].params.contrast).toBe(10);
    }
  });

  it("runs the edit hooks and the broadcast once per photo", async () => {
    seed();
    const onEditCommit = vi.fn(async (_ctx: EditCommitCtx) => {});
    registerCatalogHooks("test-ext", { id: "test.hooks", onEditCommit });

    await pasteSettings(IDS, clip({ contrast: 10 }));

    expect(onEditCommit.mock.calls.map(([ctx]) => ctx.photo.id)).toEqual(IDS);
    expect(broadcast).toHaveBeenCalledTimes(3);
    for (const photoId of IDS)
      expect(broadcast).toHaveBeenCalledWith({
        type: "edit-update",
        payload: { photoId, params: expect.objectContaining({ contrast: 10 }) },
      });
  });

  it("reloads the photo open in Develop once", async () => {
    seed();
    await useDevelopStore.getState().loadEdit("b");
    const loadEdit = vi.fn(useDevelopStore.getState().loadEdit);
    useDevelopStore.setState({ loadEdit });

    await pasteSettings(IDS, clip({ contrast: 10 }));

    expect(loadEdit).toHaveBeenCalledTimes(1);
    expect(loadEdit.mock.calls[0][0]).toBe("b");
    expect(useDevelopStore.getState().params.contrast).toBe(10);
  });

  it.each([
    { selection: "empty", ids: [] },
    { selection: "made of photos that aren't in the catalog", ids: ["gone", "missing"] },
  ])("writes nothing when the selection is $selection", async ({ ids }) => {
    const { batches, singles } = seed();

    expect(await pasteSettings(ids, clip({ contrast: 10 }))).toBe(0);

    expect(batches).toHaveLength(0);
    expect(singles).toHaveLength(0);
  });
});
