// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Smoke: two windows editing one photo. Each window is its own copy of the app's
// modules (vi.resetModules between them), so each has its own develop store,
// catalog storage and window id, as real windows do, and follows the others'
// catalog records as useWindowSync has it do; they talk only over a
// BroadcastChannel stand-in that, like the real one, delivers a copy of each
// message to every other window later, never to the sender.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";
import { photo } from "@/catalog/stored-edit.fixtures";
import { MemoryFs, fsaDirectoryHandle } from "@/project/memory-fs.test-support";

vi.mock("@/native/privileged", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/native/privileged")>()),
  privilegedFs: () => null,
}));
vi.mock("@/modules/library/import-photos", () => ({
  isSupportedName: (name: string) => /\.(nef|jpe?g)$/i.test(name),
  importPhoto: async () => null,
  buildPreviewBlob: async () => null,
}));
// Re-rendering the grid thumbnail needs the render worker.
vi.mock("@/state/edited-thumbnail", () => ({ regenerateEditedThumbnail: () => {} }));

class FakeBroadcastChannel {
  static open = new Set<FakeBroadcastChannel>();
  readonly name: string;
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.open.add(this);
  }

  postMessage(message: unknown): void {
    for (const other of FakeBroadcastChannel.open) {
      if (other === this || other.name !== this.name) continue;
      const copy = structuredClone(message);
      setTimeout(() => {
        for (const listener of [...other.listeners]) listener({ data: copy } as MessageEvent);
      }, 0);
    }
  }

  addEventListener(_type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }

  close(): void {
    FakeBroadcastChannel.open.delete(this);
  }
}

const ROOT = "/home/u/photos";
const CATALOG = `${ROOT}/.safelight/catalog.json`;

interface AppWindow {
  develop: typeof import("@/state/develop-store").useDevelopStore;
  storage: import("@/project/project-storage").ProjectStorage;
  unfollow: () => void;
}

const windows: AppWindow[] = [];

/** A window with its own modules, opened on the project at `root`. */
async function openWindow(root: FileSystemDirectoryHandle): Promise<AppWindow> {
  vi.resetModules();
  const { ProjectStorage } = await import("@/project/project-storage");
  const { storageDeps } = await import("@/project/storage-deps");
  const { setCatalogStorage } = await import("@/catalog/storage");
  const { useDevelopStore } = await import("@/state/develop-store");
  const { followCatalogRecords } = await import("@/state/catalog-sync");
  const { storage } = await ProjectStorage.open(root, storageDeps);
  setCatalogStorage(storage);
  const opened = { develop: useDevelopStore, storage, unfollow: followCatalogRecords() };
  windows.push(opened);
  return opened;
}

function project() {
  const fs = new MemoryFs(ROOT);
  const x: CatalogPhoto = photo("x");
  fs.put(`${ROOT}/${x.relPath}`, "x");
  fs.put(CATALOG, JSON.stringify({ version: 1, photos: [x], edits: [] }));
  return { fs, root: fsaDirectoryHandle(fs, ROOT) };
}

const labels = (stack: { label: string }[] | undefined) => stack?.map((s) => s.label);

async function storedLabels(opened: AppWindow) {
  return labels((await opened.storage.getEditState("x"))?.stack);
}

async function edit(opened: AppWindow, key: "exposure" | "contrast", value: number, label: string) {
  opened.develop.getState().setParam(key, value);
  await opened.develop.getState().commitEdit(label);
}

async function settle() {
  await vi.advanceTimersByTimeAsync(5000);
  for (const opened of windows) await opened.storage.flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeBroadcastChannel.open.clear();
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const opened of windows.splice(0)) {
    opened.unfollow();
    opened.storage.close();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("smoke: two windows editing the same photo", () => {
  it("keeps both windows' steps in the photo's history", async () => {
    const { fs, root } = project();
    const a = await openWindow(root);
    const b = await openWindow(root);
    await vi.advanceTimersByTimeAsync(5000);
    await a.develop.getState().loadEdit("x");
    await b.develop.getState().loadEdit("x");

    await edit(a, "exposure", 1, "Exposure");
    await vi.advanceTimersByTimeAsync(100);
    expect(labels(b.develop.getState().history)).toEqual(["Original", "Exposure"]);
    await edit(b, "contrast", 20, "Contrast");
    await settle();

    const both = ["Original", "Exposure", "Contrast"];
    expect(await storedLabels(a)).toEqual(both);
    expect(await storedLabels(b)).toEqual(both);
    expect(labels(b.develop.getState().history)).toEqual(both);
    expect(b.develop.getState().params).toMatchObject({ exposure: 1, contrast: 20 });
    expect(labels(a.develop.getState().history)).toEqual(both);
    expect(a.develop.getState().params).toMatchObject({ exposure: 1, contrast: 20 });
    const onDisk = JSON.parse(fs.text(CATALOG) ?? "{}") as { edits: { photoId: string; stack: { label: string }[] }[] };
    expect(labels(onDisk.edits.find((e) => e.photoId === "x")?.stack)).toEqual(both);
  });

  // Fails today: an edit history is stamped whole and the newer one replaces the
  // other (ProjectStorage.apply, change-stamps.ts), so a step committed
  // within the other window's message delay is dropped from both windows and the
  // disk. Narrow (commits a few ms apart), but silent.
  it.fails("keeps both steps when both commit before either hears the other", async () => {
    const { root } = project();
    const a = await openWindow(root);
    const b = await openWindow(root);
    await vi.advanceTimersByTimeAsync(5000);
    await a.develop.getState().loadEdit("x");
    await b.develop.getState().loadEdit("x");

    await edit(a, "exposure", 1, "Exposure");
    await edit(b, "contrast", 20, "Contrast");
    await settle();

    expect(await storedLabels(a)).toEqual(expect.arrayContaining(["Exposure", "Contrast"]));
    expect(await storedLabels(b)).toEqual(expect.arrayContaining(["Exposure", "Contrast"]));
  });
});
