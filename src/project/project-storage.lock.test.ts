// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The writer lock ProjectStorage.open takes on a catalogue (storage-options), so
// the app and `slu` never write one catalog.json at once: the real storage over
// the desktop fs bridge and its lock files, on temp folders.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeFsBridge } from "@/extensions/types";
import { createFsBridge } from "../../electron/fs-bridge.cjs";
import { REFRESH_MS, STALE_MS } from "../../electron/file-lock.cjs";

const h = vi.hoisted(() => ({ fs: null as NativeFsBridge | null }));

vi.mock("@/native/privileged", () => ({ privilegedFs: () => h.fs }));
vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({
    persistPreviews: true,
    thumbMaxEdge: 768,
    catalogLocation: "in-folder",
    externalCatalogDir: "",
  }),
}));

import { ProjectStorage, type ProjectStorageDeps } from "./project-storage";
import { ProjectLockedError, type StorageOpenOptions } from "./storage-options";
import { nativeDirectoryHandle } from "./native-fs";

class FakeChannel {
  postMessage(message: unknown): void {
    structuredClone(message);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

let temp: string;
let project: string;
let workingDir: string;
let lockFile: string;
let bridge: NativeFsBridge;
const storages: ProjectStorage[] = [];

const writer = {
  write: async (file: string, data: Uint8Array) => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, data);
  },
};

const deps: ProjectStorageDeps = {
  isSupportedName: (name) => /\.jpe?g$/i.test(name),
  importPhoto: async () => null,
  buildPreviewBlob: async () => null,
  persistPreviews: () => true,
  emitPhotoImport: async () => null,
};

const holder = () => JSON.parse(fs.readFileSync(lockFile, "utf8")) as { app: string; token: string };

async function open(options?: StorageOpenOptions) {
  const opened = await ProjectStorage.open(
    nativeDirectoryHandle(project),
    deps,
    undefined,
    undefined,
    undefined,
    undefined,
    options,
  );
  storages.push(opened.storage);
  return opened;
}

async function closeAll() {
  for (const storage of storages.splice(0)) {
    storage.close();
    await storage.released();
  }
}

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-lock-"));
  project = path.join(temp, "shoot");
  workingDir = path.join(project, ".safelight");
  lockFile = path.join(workingDir, "writer.lock");
  fs.mkdirSync(workingDir, { recursive: true });
  fs.writeFileSync(path.join(project, "a.jpg"), "A");
  fs.writeFileSync(
    path.join(workingDir, "catalog.json"),
    JSON.stringify({
      version: 2,
      id: "cat-1",
      photos: [{ id: "a", relPath: "a.jpg", filename: "a.jpg", folder: "", fileSize: 1 }],
      edits: [],
    }),
  );
  bridge = {
    ...createFsBridge({ userData: path.join(temp, "userData"), writer }),
    pickDirectory: async () => null,
    reveal: async () => false,
  };
  h.fs = bridge;
  vi.stubGlobal("BroadcastChannel", FakeChannel);
});

afterEach(async () => {
  await closeAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("the writer lock", () => {
  it("is taken by the app's open and given back once it has closed", async () => {
    const opened = await open();

    expect(holder().app).toBe("safelight");
    opened.storage.close();
    await opened.storage.released();

    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("is given back by the flush of a window that is closing", async () => {
    const opened = await open();
    await opened.storage.putPhoto({ ...opened.photos[0], rating: 4 });

    await opened.storage.flush({ unloading: true });

    expect(fs.existsSync(lockFile)).toBe(false);
    expect(fs.readFileSync(path.join(workingDir, "catalog.json"), "utf8")).toContain('"rating":4');
  });

  it("is kept through a close that is called off, and given back once the page really leaves", async () => {
    vi.stubGlobal("window", new EventTarget());
    const opened = await open();
    await opened.storage.putPhoto({ ...opened.photos[0], rating: 4 });

    await opened.storage.flush({ unloading: true });

    expect(fs.readFileSync(path.join(workingDir, "catalog.json"), "utf8")).toContain('"rating":4');
    expect(holder().app).toBe("safelight");
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(fs.existsSync(lockFile)).toBe(false));
  });

  it("is given back as the page leaves after a flush with nothing to write", async () => {
    vi.stubGlobal("window", new EventTarget());
    const opened = await open();

    await opened.storage.flush({ unloading: true });

    expect(holder().app).toBe("safelight");
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(fs.existsSync(lockFile)).toBe(false));
  });

  it("fails an open asked to fail while the app holds it", async () => {
    const held = await bridge.lockProject!(workingDir, "safelight");

    const failed = open({ recordsOnly: true, lock: { owner: "slu", whenHeld: "fail", waitMs: 0 } });

    await expect(failed).rejects.toBeInstanceOf(ProjectLockedError);
    await expect(failed).rejects.toMatchObject({ heldBy: { app: "safelight" } });
    expect(held.ok && holder().token === held.token).toBe(true);
  });

  it("waits for `slu` to let go", async () => {
    const held = await bridge.lockProject!(workingDir, "slu");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setTimeout(() => void bridge.releaseProjectLock!(workingDir, held.ok ? held.token : ""), 300);

    const started = Date.now();
    await open({ recordsOnly: true, lock: { owner: "safelight", whenHeld: "wait-then-take", waitMs: 3000 } });

    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(holder().app).toBe("safelight");
    expect(warn).not.toHaveBeenCalled();
  });

  it("takes it over from `slu` once the wait runs out, with a warning", async () => {
    await bridge.lockProject!(workingDir, "slu");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const started = Date.now();
    await open({ recordsOnly: true, lock: { owner: "safelight", whenHeld: "wait-then-take", waitMs: 400 } });

    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
    expect(holder().app).toBe("safelight");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/slu/));
  });

  it("is taken over at once from the app's own earlier copy", async () => {
    await bridge.lockProject!(workingDir, "safelight");

    const started = Date.now();
    const opened = await open();

    expect(Date.now() - started).toBeLessThan(1000);
    opened.storage.close();
    await opened.storage.released();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("isn't taken by a pop-out window, nor by a bridge without it", async () => {
    vi.stubGlobal("location", { search: "?detached=library" });
    await open();
    expect(fs.existsSync(lockFile)).toBe(false);
    await closeAll();
    vi.unstubAllGlobals();
    vi.stubGlobal("BroadcastChannel", FakeChannel);

    const { lockProject: _l, refreshProjectLock: _r, releaseProjectLock: _u, ...older } = bridge;
    h.fs = older;
    await open();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("is kept fresh while open, as often as `slu` refreshes its locks, and the refresh stops on close", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const refresh = vi.spyOn(bridge, "refreshProjectLock");
    const opened = await open({ recordsOnly: true });

    vi.advanceTimersByTime(REFRESH_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    opened.storage.close();
    await opened.storage.released();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(STALE_MS);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(lockFile)).toBe(false);
  });
});
