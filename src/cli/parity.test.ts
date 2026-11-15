// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `safelight set` and `safelight undo` write the catalogue the app writes for the same
// steps: one project changed through main(), its twin through the app's own
// store path (appendStoredSnapshots, then Develop's undo), both on the real
// ProjectStorage under the Node shims.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/edited-thumbnail", () => ({ regenerateEditedThumbnail: vi.fn() }));

import type { StoredPhoto } from "@/catalog/types";
import { appendStoredSnapshots, storedSnapshotTargets } from "@/catalog/stored-edit";
import { setCatalogStorage } from "@/catalog/storage";
import { nativeDirectoryHandle } from "@/project/native-fs";
import { ProjectStorage, type ProjectStorageDeps } from "@/project/project-storage";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore } from "@/state/develop-store";
import { installNodeHost } from "./host";
import { main, type MainIO } from "./main";
import { createNodeFsBridge } from "./node-fs";

class FakeChannel {
  postMessage(message: unknown): void {
    structuredClone(message);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

const NO_IMPORT: ProjectStorageDeps = {
  isSupportedName: () => false,
  importPhoto: async () => null,
  buildPreviewBlob: async () => null,
  persistPreviews: () => false,
  emitPhotoImport: async () => null,
};

let temp: string;
let userData: string;

const record = (id: string, relPath: string): StoredPhoto => ({
  id,
  filename: relPath,
  relPath,
  folder: "",
  width: 6000,
  height: 4000,
  fileSize: 1,
  mimeType: "image/x-sony-arw",
  rating: 0,
  colorLabel: "none",
  flag: "none",
  rotation: 0,
  keywords: [],
  dateCreated: 1,
  dateImported: 2,
  exif: { colorTemperature: 5200 },
});

function seed(root: string): void {
  fs.mkdirSync(path.join(root, ".safelight"), { recursive: true });
  fs.writeFileSync(path.join(root, "a.ARW"), "A");
  const catalog = { version: 2, id: "cat-1", photos: [record("a", "a.ARW")], edits: [], removed: [] };
  fs.writeFileSync(path.join(root, ".safelight", "catalog.json"), JSON.stringify(catalog));
}

function sink(): NodeJS.WriteStream {
  return Object.assign(new Writable({ write: (_c, _e, done) => done() }), { isTTY: false }) as unknown as NodeJS.WriteStream;
}

async function slu(argv: string[], cwd: string): Promise<number> {
  const io: MainIO = {
    stdout: sink(),
    stderr: sink(),
    stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
    env: { SLU_USER_DATA: userData },
    cwd,
    platform: process.platform,
    home: temp,
    moduleFile: path.join(temp, "safelight.mjs"),
    onInterrupt: () => () => {},
  };
  return main(argv, io);
}

/** The app's copy of `root`'s catalogue, open as the main window opens it, records only. */
async function openAsApp(root: string): Promise<ProjectStorage> {
  installNodeHost({ bridge: createNodeFsBridge(userData), platform: process.platform, storage: {} });
  const opened = await ProjectStorage.open(
    nativeDirectoryHandle(root), NO_IMPORT, undefined, undefined, undefined, undefined, { recordsOnly: true },
  );
  setCatalogStorage(opened.storage);
  useCatalogStore.setState({ photos: opened.photos });
  return opened.storage;
}

async function closeApp(storage: ProjectStorage): Promise<void> {
  await storage.flush();
  storage.close();
  await storage.released();
  setCatalogStorage(null);
}

/** catalog.json with the times taken out: each step's, and each change stamp's
 *  time and writer (`[ms, "<writer>:<n>"]`), which differ between any two writes. */
function catalogText(root: string): string {
  return fs
    .readFileSync(path.join(root, ".safelight", "catalog.json"), "utf8")
    .replace(/"timestamp":\d+/g, '"timestamp":0')
    .replace(/\[\d+,"[^"]*:\d+"\]/g, "[0,\"\"]");
}

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "slu-parity-"));
  userData = path.join(temp, "userData");
  fs.mkdirSync(userData);
  vi.stubGlobal("BroadcastChannel", FakeChannel);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("safelight and the app write the same catalogue", () => {
  it("for set, then undo", async () => {
    const viaSlu = path.join(temp, "slu");
    const viaApp = path.join(temp, "app");
    seed(viaSlu);
    seed(viaApp);

    expect(await slu(["set", "a.ARW", "exposure=1", "contrast=10"], viaSlu)).toBe(0);
    let app = await openAsApp(viaApp);
    expect(
      await appendStoredSnapshots(storedSnapshotTargets(["a"]), "Exposure, Contrast", (base) => ({
        params: { ...base.params, exposure: 1, contrast: 10 },
        paramBag: base.paramBag,
      })),
    ).toBe(1);
    await closeApp(app);
    expect(catalogText(viaSlu)).toBe(catalogText(viaApp));

    expect(await slu(["undo", "a.ARW"], viaSlu)).toBe(0);
    app = await openAsApp(viaApp);
    await useDevelopStore.getState().loadEdit("a", 5200);
    useDevelopStore.getState().undo();
    await vi.waitFor(async () => expect((await app.getEditState("a"))?.currentIndex).toBe(0));
    await closeApp(app);
    expect(catalogText(viaSlu)).toBe(catalogText(viaApp));
  });
});
