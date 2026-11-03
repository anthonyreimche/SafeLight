// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Smoke: opening folders laid out the ways real disks are, end to end through the
// real scan, ProjectStorage and working-dir over real temp folders, with the
// desktop bridge bound to the main process's own fs:* handlers (electron/ipc/
// fs.cjs). Only the importer is a stand-in: it reads the file, not its pixels.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseExif } from "@/catalog/exif";
import { ascii, buildTiff } from "@/catalog/tiff-fixture";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import type { NativeFsBridge } from "@/extensions/types";
// @ts-expect-error -- the main process's CommonJS, outside the renderer's typed sources
import { fsChannels } from "../../electron/ipc/fs.cjs";

const h = vi.hoisted(() => ({
  bridge: null as NativeFsBridge | null,
  settings: {
    catalogLocation: "in-folder" as "in-folder" | "external",
    externalCatalogDir: "",
    persistPreviews: false,
    thumbMaxEdge: 768,
  },
}));

vi.mock("@/native/privileged", () => ({ privilegedFs: () => h.bridge }));
vi.mock("@/state/settings-store", () => ({ getSettings: () => h.settings }));

import { ProjectStorage, type OpenedProject, type ProjectStorageDeps } from "./project-storage";
import { nativeDirectoryHandle } from "./native-fs";

/** The bridge the preload hands the renderer, calling the fs:* handlers directly. */
function bridgeOver(userData: string): NativeFsBridge {
  const channels = fsChannels({
    userData: () => userData,
    fileWriter: {
      async write(file: string, data: Uint8Array) {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, data);
      },
    },
    shell: {},
    dialog: {},
    BrowserWindow: {},
  } as never) as { channel: string; handler: (event: unknown, ...args: unknown[]) => Promise<unknown> }[];
  const handlers = new Map(channels.map((c) => [c.channel, c.handler]));
  const call =
    (name: string) =>
    (...args: unknown[]) =>
      handlers.get(`fs:${name}`)!({}, ...args);
  const methods = [
    "read",
    "write",
    "list",
    "mkdir",
    "externalCatalogDir",
    "listExternalCatalogs",
    "setSpilloverPointer",
    "getSpilloverPointer",
    "clearSpilloverPointer",
    "remove",
    "move",
    "exists",
  ];
  return {
    ...Object.fromEntries(methods.map((name) => [name, call(name)])),
    pickDirectory: async () => null,
    reveal: async () => false,
  } as unknown as NativeFsBridge;
}

let built = 0;

const deps: ProjectStorageDeps = {
  isSupportedName: (name) => /\.(jpe?g|cr3)$/i.test(name),
  importPhoto: async (fileHandle, directoryHandle) => {
    const file = await fileHandle.getFile();
    return {
      id: `p${++built}:${file.name}`,
      filename: file.name,
      relPath: "",
      folder: "",
      directoryHandle,
      fileHandle,
      thumbnailBlob: null,
      thumbnailUrl: null,
      width: 4000,
      height: 3000,
      fileSize: file.size,
      mimeType: "image/jpeg",
      rating: 0,
      colorLabel: "none",
      flag: "none",
      rotation: 0,
      keywords: [],
      dateCreated: file.lastModified,
      dateImported: 2,
      exif: { dateTimeOriginal: (await parseExif(file)).dateTimeOriginal },
    };
  },
  buildPreviewBlob: async () => null,
  persistPreviews: () => false,
  emitPhotoImport: async () => null,
};

const edit = (photoId: string, label: string): EditState => ({
  photoId,
  stack: [{ timestamp: 1, label, params: {} as EditState["stack"][0]["params"] }],
  currentIndex: 0,
});

const temps: string[] = [];

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `safelight-${name}-`));
  temps.push(dir);
  return dir;
}

function put(root: string, rel: string, body: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

/** A folder link: a junction on Windows (no admin rights needed), a symlink elsewhere. */
const linkFolder = (target: string, link: string) =>
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

/** Open the folder at `root` the way the app does, then write and let go. */
async function openAndClose(root: string, work?: (opened: OpenedProject) => Promise<void>) {
  const opened = await ProjectStorage.open(nativeDirectoryHandle(root), deps);
  await work?.(opened);
  await opened.storage.flush();
  const edits = new Map<string, string | undefined>();
  for (const photo of opened.photos)
    edits.set(photo.id, (await opened.storage.getEditState(photo.id))?.stack[0].label);
  opened.storage.close();
  return { ...opened, edits };
}

const byRel = (photos: CatalogPhoto[], relPath: string) => photos.find((p) => p.relPath === relPath);

beforeEach(() => {
  built = 0;
  h.settings.catalogLocation = "in-folder";
  h.bridge = bridgeOver(tempDir("userdata"));
  vi.stubGlobal("BroadcastChannel", class {
    postMessage(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of temps.splice(0).reverse()) fs.rmSync(dir, { recursive: true, force: true });
});

describe("smoke: folder layouts on a real disk", () => {
  const NFC = "Zürich".normalize("NFC");
  const NFD = "Zürich".normalize("NFD");

  it("finds photos through a linked folder, keeps a broken link's and an NFD folder's", async () => {
    const root = tempDir("shoot");
    const elsewhere = tempDir("elsewhere");
    const later = tempDir("later");
    put(root, "a.jpg", "A");
    put(root, `${NFC}/d.jpg`, "D");
    put(elsewhere, "b.jpg", "BB");
    put(later, "c.jpg", "CCC");
    linkFolder(elsewhere, path.join(root, "linked"));
    linkFolder(later, path.join(root, "gone"));

    const first = await openAndClose(root, async ({ photos, storage }) => {
      for (const photo of photos) await storage.putEditState(edit(photo.id, `look of ${photo.filename}`));
    });
    expect(first.photos.map((p) => p.relPath).sort()).toEqual(
      ["a.jpg", "gone/c.jpg", "linked/b.jpg", `${NFC}/d.jpg`].sort(),
    );

    fs.rmSync(later, { recursive: true });
    fs.renameSync(path.join(root, NFC), path.join(root, NFD));
    const second = await openAndClose(root);

    expect(second.newPhotos).toEqual([]);
    expect(second.unreadable).toEqual(["gone"]);
    expect(second.tree.children.find((c) => c.name === "gone")?.unreadable).toBe(true);
    for (const photo of first.photos) {
      expect(second.edits.get(photo.id)).toBe(`look of ${photo.filename}`);
    }
    expect(byRel(second.photos, "linked/b.jpg")?.fileHandle).not.toBeNull();
    expect(byRel(second.photos, `${NFD}/d.jpg`)?.id).toBe(byRel(first.photos, `${NFC}/d.jpg`)?.id);
    expect(byRel(second.photos, "gone/c.jpg")).toMatchObject({ fileHandle: null });
  });
});

/** A RAW whose EXIF says it was taken at second `n` of a minute, padded by `pad`
 *  bytes as a geotagging tool leaves it. */
function shot(n: number, pad = 0): Uint8Array {
  const at = `2024:05:01 10:00:${String(n).padStart(2, "0")}`;
  return new Uint8Array([...buildTiff({ le: true, exif: [[0x9003, ascii(at)]] }), ...new Uint8Array(pad)]);
}

describe("smoke: the same card, changed while the app was closed", () => {
  const IMG = (n: number) => `DCIM/100CANON/IMG_${String(n).padStart(4, "0")}.CR3`;

  function write(mount: string, rel: string, data: Uint8Array): void {
    fs.mkdirSync(path.dirname(path.join(mount, rel)), { recursive: true });
    fs.writeFileSync(path.join(mount, rel), data);
  }

  it("keeps its catalogue when every photo on it was geotagged in place", async () => {
    h.settings.catalogLocation = "external";
    const mount = tempDir("EOS_DIGITAL");
    for (const n of [1, 2, 3]) write(mount, IMG(n), shot(n));
    const first = await openAndClose(mount, async ({ photos, storage }) => {
      await storage.putEditState(edit(byRel(photos, IMG(1))!.id, "Look"));
    });

    for (const n of [1, 2, 3]) write(mount, IMG(n), shot(n, 512));
    const again = await openAndClose(mount);

    expect(again.externalPath).toBe(first.externalPath);
    expect(again.newPhotos).toEqual([]);
    expect(again.edits.get(byRel(first.photos, IMG(1))!.id)).toBe("Look");
    expect(byRel(again.photos, IMG(2))?.fileSize).toBe(shot(2, 512).length);
  });

  it("keeps its catalogue when most of its photos were erased in camera", async () => {
    h.settings.catalogLocation = "external";
    const mount = tempDir("EOS_DIGITAL");
    for (let n = 1; n <= 20; n++) write(mount, IMG(n), shot(n));
    const first = await openAndClose(mount, async ({ photos, storage }) => {
      await storage.putEditState(edit(byRel(photos, IMG(20))!.id, "Keeper"));
    });

    for (let n = 1; n <= 19; n++) fs.rmSync(path.join(mount, IMG(n)));
    for (const n of [21, 22]) write(mount, IMG(n), shot(n));
    const again = await openAndClose(mount);

    expect(again.externalPath).toBe(first.externalPath);
    expect(again.newPhotos.map((p) => p.relPath).sort()).toEqual([IMG(21), IMG(22)]);
    expect(again.edits.get(byRel(first.photos, IMG(20))!.id)).toBe("Keeper");
  });
});

describe("smoke: cards swapped at one mount point", () => {
  // Every card a camera formats names its photos alike and mounts at one path.
  // Real cards are told apart by what their photos say: a capture time and a size.
  const CARD_A = { "DCIM/100CANON/IMG_0001.CR3": shot(1), "DCIM/100CANON/IMG_0002.CR3": shot(2) };
  const CARD_B = { "DCIM/100CANON/IMG_0001.CR3": shot(41, 7), "DCIM/100CANON/IMG_0002.CR3": shot(42, 9) };

  function insert(mount: string, card: Record<string, Uint8Array>): void {
    for (const entry of fs.readdirSync(mount)) fs.rmSync(path.join(mount, entry), { recursive: true });
    for (const [rel, body] of Object.entries(card)) put(mount, rel, body);
  }

  it("keeps each card's catalogue and edits apart, and finds card A's again", async () => {
    h.settings.catalogLocation = "external";
    const mount = tempDir("EOS_DIGITAL");
    const IMG_0001 = "DCIM/100CANON/IMG_0001.CR3";

    insert(mount, CARD_A);
    const a = await openAndClose(mount, async ({ photos, storage }) => {
      await storage.putEditState(edit(byRel(photos, IMG_0001)!.id, "Card A look"));
    });

    insert(mount, CARD_B);
    const b = await openAndClose(mount);

    expect(b.externalPath).not.toBe(a.externalPath);
    expect(b.newPhotos).toHaveLength(2);
    expect(b.photos.map((p) => p.id)).not.toContain(byRel(a.photos, IMG_0001)!.id);
    expect(b.edits.get(byRel(b.photos, IMG_0001)!.id)).toBeUndefined();

    insert(mount, CARD_A);
    const again = await openAndClose(mount);

    expect(again.externalPath).toBe(a.externalPath);
    expect(again.newPhotos).toEqual([]);
    expect(again.photos.map((p) => p.id).sort()).toEqual(a.photos.map((p) => p.id).sort());
    expect(again.edits.get(byRel(a.photos, IMG_0001)!.id)).toBe("Card A look");
  });
});
