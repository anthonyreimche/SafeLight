// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// When each photo's edit last changed, read from the history the shown project's
// storage holds, for the Library's Edited filter and sort. A and B are two windows
// on one in-memory project folder; this window shows B.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The plain-browser build: no native file bridge.
vi.mock("@/native/privileged", () => ({ privilegedFs: () => null }));

import { photo, snapshot } from "./stored-edit.fixtures";
import { setCatalogStorage } from "./storage";
import type { EditSnapshot, EditState } from "./types";
import { MemoryFs, fsaDirectoryHandle } from "@/project/memory-fs.test-support";
import { ProjectStorage } from "@/project/project-storage";
import { storageDeps } from "@/project/storage-deps";
import { act, renderHook } from "@testing-library/react";
import { editTimeOf, editTimesVersion, editedAt, subscribeEditTimes, useEditedAt } from "./edit-times";

class FakeChannel {
  postMessage(message: unknown): void {
    structuredClone(message);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

const ROOT = "/home/u/photos";

const at = (timestamp: number, label: string): EditSnapshot => ({ ...snapshot(label, {}), timestamp });
const edit = (photoId: string, stack: EditSnapshot[], currentIndex = stack.length - 1): EditState => ({
  photoId,
  stack,
  currentIndex,
});

const storages: ProjectStorage[] = [];

async function openProject(fs: MemoryFs): Promise<ProjectStorage> {
  const { storage } = await ProjectStorage.open(fsaDirectoryHandle(fs, ROOT), storageDeps);
  storages.push(storage);
  return storage;
}

function projectFolder(...ids: string[]): MemoryFs {
  const fs = new MemoryFs(ROOT);
  const photos = ids.map((id) => photo(id));
  for (const p of photos) fs.put(`${ROOT}/${p.relPath}`, p.id);
  fs.put(`${ROOT}/.safelight/catalog.json`, JSON.stringify({ version: 1, photos, edits: [] }));
  return fs;
}

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.useFakeTimers();
});

afterEach(() => {
  setCatalogStorage(null);
  for (const storage of storages.splice(0)) storage.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("editTimeOf", () => {
  it("is undefined for a photo with no history, or with every step undone", () => {
    expect(editTimeOf(undefined)).toBeUndefined();
    expect(editTimeOf(edit("x", [at(100, "Original")]))).toBeUndefined();
    expect(editTimeOf(edit("x", [at(100, "Original"), at(200, "Exposure")], 0))).toBeUndefined();
  });

  it("is the time of the step the history stands on, not of a later undone one", () => {
    const steps = [at(100, "Original"), at(200, "Exposure"), at(300, "Contrast")];
    expect(editTimeOf(edit("x", steps))).toBe(300);
    expect(editTimeOf(edit("x", steps, 1))).toBe(200);
  });
});

describe("editedAt", () => {
  it("reads the edit the shown project holds, as soon as it is stored", async () => {
    const b = await openProject(projectFolder("x", "y"));
    setCatalogStorage(b);
    expect(editedAt("x")).toBeUndefined();

    await b.putEditState(edit("x", [at(100, "Original"), at(200, "Exposure")]));

    expect(editedAt("x")).toBe(200);
    expect(editedAt("y")).toBeUndefined();
  });

  it("tells its listeners when this window stores an edit", async () => {
    const b = await openProject(projectFolder("x"));
    setCatalogStorage(b);
    const heard = vi.fn();
    const stop = subscribeEditTimes(heard);
    const before = editTimesVersion();

    await b.putEditState(edit("x", [at(100, "Original"), at(200, "Exposure")]));

    expect(heard).toHaveBeenCalled();
    expect(editTimesVersion()).not.toBe(before);
    stop();
  });

  it("takes on another window's edit and tells its listeners", async () => {
    const fs = projectFolder("x");
    const a = await openProject(fs);
    const b = await openProject(fs);
    setCatalogStorage(b);
    const heard = vi.fn();
    const stop = subscribeEditTimes(heard);

    await a.putEditState(edit("x", [at(100, "Original"), at(400, "Exposure")]));

    await vi.waitFor(() => expect(editedAt("x")).toBe(400));
    expect(heard).toHaveBeenCalled();
    stop();
  });

  it("tells its listeners when another project is shown", async () => {
    const b = await openProject(projectFolder("x"));
    const heard = vi.fn();
    const stop = subscribeEditTimes(heard);

    setCatalogStorage(b);

    expect(heard).toHaveBeenCalled();
    stop();
  });

  it("ignores a storage this window doesn't show", async () => {
    const hidden = await openProject(projectFolder("x"));
    const heard = vi.fn();
    const stop = subscribeEditTimes(heard);

    await hidden.putEditState(edit("x", [at(100, "Original"), at(200, "Exposure")]));

    expect(heard).not.toHaveBeenCalled();
    expect(editedAt("x")).toBeUndefined();
    stop();
  });
});

describe("useEditedAt", () => {
  it("follows one photo's edit time as edits are stored", async () => {
    const b = await openProject(projectFolder("x", "y"));
    setCatalogStorage(b);
    const { result } = renderHook(() => useEditedAt("x"));
    expect(result.current).toBeUndefined();

    await act(async () => {
      await b.putEditState(edit("x", [at(100, "Original"), at(200, "Exposure")]));
    });
    expect(result.current).toBe(200);

    await act(async () => {
      await b.putEditState(edit("x", [at(100, "Original"), at(200, "Exposure")], 0));
    });
    expect(result.current).toBeUndefined();
  });
});
