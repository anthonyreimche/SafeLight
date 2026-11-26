// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An extension writing a photo's edit through api.catalog.putEditState, e.g. a
// batch Auto in Library that includes the photo Develop holds. Develop's next
// commit writes back the history it holds, so that photo must reload from the
// catalogue, or the extension's step is lost.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeScopedAPI } from "./host";
import { installMemoryStorage, snapshot } from "@/catalog/stored-edit.fixtures";
import { catalogStorage, setCatalogStorage } from "@/catalog/storage";
import type { EditSnapshot, EditState } from "@/catalog/types";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import { photo } from "@/catalog/stored-edit.fixtures";
import { refreshStoredThumbnails } from "@/state/edited-thumbnail";

vi.mock("@/state/edited-thumbnail", () => ({ regenerateEditedThumbnail: vi.fn(), refreshStoredThumbnails: vi.fn() }));

class FakeChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const PHOTO = "photo-1";
const OTHER = "photo-2";

const edit = (stack: EditSnapshot[], photoId = PHOTO): EditState => ({
  photoId,
  stack,
  currentIndex: stack.length - 1,
});
const labelsOf = (stack: EditSnapshot[]) => stack.map((s) => s.label);
const ORIGINAL = snapshot("Original", { temperature: 4300 });
const AUTO = snapshot("Auto", { temperature: 4300, exposure: 1 });

const INITIAL = useDevelopStore.getState();

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  useDevelopStore.setState(INITIAL, true);
});

afterEach(() => {
  setCatalogStorage(null);
  vi.unstubAllGlobals();
});

describe("api.catalog.putEditState on the photo Develop holds", () => {
  it("reloads Develop, so its history ends with the extension's step", async () => {
    installMemoryStorage(edit([ORIGINAL]));
    await useDevelopStore.getState().loadEdit(PHOTO, 4300);

    await makeScopedAPI("ext.auto").catalog.putEditState(edit([ORIGINAL, AUTO]));

    const develop = useDevelopStore.getState();
    expect(labelsOf(develop.history)).toEqual(["Original", "Auto"]);
    expect(develop.historyIndex).toBe(1);
    expect(develop.params.exposure).toBe(1);
    expect(develop.asShotTemperature).toBe(4300);
  });

  it("keeps the extension's step when Develop commits next", async () => {
    const { written } = installMemoryStorage(edit([ORIGINAL]));
    await useDevelopStore.getState().loadEdit(PHOTO, 4300);
    await makeScopedAPI("ext.auto").catalog.putEditState(edit([ORIGINAL, AUTO]));

    useDevelopStore.getState().setParam("contrast", 20);
    await useDevelopStore.getState().commitEdit("Contrast");

    const { stack } = written[written.length - 1];
    expect(labelsOf(stack)).toEqual(["Original", "Auto", "Contrast"]);
    expect(stack[2].params.exposure).toBe(1);
    expect(stack[2].params.contrast).toBe(20);
  });

  it("keeps the extension's step when Develop commits while it is being saved", async () => {
    const { written } = installMemoryStorage(edit([ORIGINAL]));
    await useDevelopStore.getState().loadEdit(PHOTO, 4300);
    // The storage holds the edit at once and saves it after (as ProjectStorage does).
    const storage = catalogStorage();
    const store = storage.putEditState.bind(storage);
    let saved = (): void => {};
    const saving = new Promise<void>((resolve) => (saved = resolve));
    vi.spyOn(storage, "putEditState").mockImplementationOnce(async (editState) => {
      await store(editState);
      await saving;
    });

    const putting = makeScopedAPI("ext.auto").catalog.putEditState(edit([ORIGINAL, AUTO]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    useDevelopStore.getState().setParam("contrast", 20);
    await useDevelopStore.getState().commitEdit("Contrast");
    saved();
    await putting;

    expect(labelsOf(written[written.length - 1].stack)).toEqual(["Original", "Auto", "Contrast"]);
    expect(labelsOf(useDevelopStore.getState().history)).toEqual(["Original", "Auto", "Contrast"]);
  });

  it.each([
    ["a null snapshot", [ORIGINAL, null]],
    ["a snapshot with params that aren't an object", [ORIGINAL, { timestamp: 1, label: "Bad", params: 7 }]],
    ["a stack that isn't a list", "nope"],
  ])("rejects an edit holding %s, storing nothing", async (_label, stack) => {
    const { written } = installMemoryStorage(edit([ORIGINAL]));
    const bad = { photoId: PHOTO, stack, currentIndex: 1 } as unknown as EditState;

    await expect(makeScopedAPI("ext.auto").catalog.putEditState(bad)).rejects.toThrow(
      /edit state/i,
    );

    expect(written).toEqual([]);
  });

  it("accepts a snapshot without params, which Develop opens on the defaults", async () => {
    const { written } = installMemoryStorage(edit([ORIGINAL]));
    const bare = { timestamp: 1, label: "Bare" } as unknown as EditSnapshot;

    await makeScopedAPI("ext.auto").catalog.putEditState(edit([ORIGINAL, bare]));

    expect(labelsOf(written[written.length - 1].stack)).toEqual(["Original", "Bare"]);
  });

  it("leaves Develop alone while it holds another photo", async () => {
    installMemoryStorage(edit([ORIGINAL]), edit([ORIGINAL], OTHER));
    await useDevelopStore.getState().loadEdit(OTHER, 4300);
    const held = useDevelopStore.getState().history;

    await makeScopedAPI("ext.auto").catalog.putEditState(edit([ORIGINAL, AUTO]));

    expect(useDevelopStore.getState().photoId).toBe(OTHER);
    expect(useDevelopStore.getState().history).toBe(held);
  });

  it("lets Develop finish opening another photo when the edit is for the one it is leaving", async () => {
    installMemoryStorage(edit([ORIGINAL]), edit([ORIGINAL, AUTO], OTHER));
    await useDevelopStore.getState().loadEdit(PHOTO, 4300);
    const storage = catalogStorage();
    const read = storage.getEditState.bind(storage);
    let answer = (): void => {};
    const answered = new Promise<void>((resolve) => (answer = resolve));
    vi.spyOn(storage, "getEditState").mockImplementationOnce(async (photoId) => {
      await answered;
      return read(photoId);
    });

    const opening = useDevelopStore.getState().loadEdit(OTHER, 4300);
    await makeScopedAPI("ext.auto").catalog.putEditState(edit([ORIGINAL, AUTO]));
    answer();
    await opening;

    expect(useDevelopStore.getState().photoId).toBe(OTHER);
    expect(labelsOf(useDevelopStore.getState().history)).toEqual(["Original", "Auto"]);
  });
});

// SafeLight #297: the grid kept the old preview after an extension's write.
describe("api.catalog.putEditState and the grid preview", () => {
  it("queues the photo's preview to be drawn again from the edit it stores", async () => {
    installMemoryStorage(edit([ORIGINAL], OTHER));
    vi.mocked(refreshStoredThumbnails).mockClear();

    await makeScopedAPI("ext.auto").catalog.putEditState(edit([ORIGINAL, AUTO], OTHER));

    expect(refreshStoredThumbnails).toHaveBeenCalledWith([OTHER]);
  });
});

describe("api.catalog.applyBagPatch", () => {
  it("commits a patch to a photo that isn't open as a step made for the extension", async () => {
    const { written } = installMemoryStorage(edit([ORIGINAL], OTHER));
    useCatalogStore.setState({ photos: [photo(PHOTO), photo(OTHER)] });

    await makeScopedAPI("ext.map").catalog.applyBagPatch(OTHER, { "ext.map.stage.tMean": [0.5] }, "Match colours");

    const stored = written[written.length - 1];
    expect(stored.photoId).toBe(OTHER);
    expect(labelsOf(stored.stack)).toEqual(["Original", "Match colours"]);
    expect(stored.stack[1].source).toBe("ext.map");
    expect(stored.stack[1].paramBag).toEqual({ "ext.map.stage.tMean": [0.5] });
  });

  it("reloads Develop when the photo is the one open there", async () => {
    installMemoryStorage(edit([ORIGINAL]));
    useCatalogStore.setState({ photos: [photo(PHOTO)] });
    await useDevelopStore.getState().loadEdit(PHOTO, 4300);

    await makeScopedAPI("ext.map").catalog.applyBagPatch(PHOTO, { "ext.map.stage.on": true }, "Match colours");

    expect(labelsOf(useDevelopStore.getState().history)).toEqual(["Original", "Match colours"]);
    expect(useDevelopStore.getState().paramBag["ext.map.stage.on"]).toBe(true);
  });
});

describe("api.develop.putPhotoData for another photo", () => {
  it("writes that photo's blob under the extension's key, and the open photo's when none is named", () => {
    const put = vi.fn(async () => {});
    installMemoryStorage();
    Object.assign(catalogStorage(), { putPhotoBlob: put });
    useCatalogStore.setState({ photos: [photo(PHOTO), photo(OTHER)] });
    useDevelopStore.setState({ photoId: PHOTO });
    const develop = makeScopedAPI("ext.map").develop;
    develop.putPhotoData("hist", new Uint8Array([1]), OTHER);
    develop.putPhotoData("hist", new Uint8Array([2]));
    expect(put).toHaveBeenNthCalledWith(1, OTHER, "ext.map.hist", new Uint8Array([1]));
    expect(put).toHaveBeenNthCalledWith(2, PHOTO, "ext.map.hist", new Uint8Array([2]));
  });
});
