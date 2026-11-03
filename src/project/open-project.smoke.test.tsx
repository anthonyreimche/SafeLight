// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Smoke: the app boots and opens folders end to end, with the real App, project
// store, ProjectStorage, scan, importer and catalogue store over an in-memory
// folder in the browser build's handles. Only the pixel decoders are stand-ins
// (jsdom has no image decoder or libraw): a file whose bytes start like a JPEG
// or PNG decodes, anything else doesn't.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { App } from "@/App";
import { useProjectStore } from "@/project/project-store";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { useExternalPluginsSettled } from "@/extensions/loader";
import { useRegistry } from "@/extensions/registry";
import { resetSetupForTests } from "@/modules/welcome/setup/setup-store";
import { writeSetupRecord } from "@/modules/welcome/setup/first-run";
import {
  registerEssentialModules,
  unregisterEssentialModules,
} from "@/test/essential-modules.test-support";
import { FsError, MemoryFs, fsaDirectoryHandle } from "./memory-fs.test-support";

vi.mock("libraw-wasm", () => ({ default: class {} }));

vi.mock("@/raw/decode-pool", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/raw/decode-pool")>()),
  warmDecodePool: async () => {},
}));

// The RAW cache lives in its own worker, which jsdom can't start.
vi.mock("@/raw/raw-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/raw/raw-cache")>()),
  setRawCacheDir: () => {},
  hasDecodeMarker: async () => false,
  deleteCachedPreview: async () => {},
}));

// The Cache all pre-decode is RAW pixel work in the background, not the open.
vi.mock("@/modules/library/cache-pass", () => ({
  EAGER_CACHE_LIMIT: 0,
  preDecodeRawsForCache: async () => {},
}));

vi.mock("@/modules/library/import-decode", () => {
  const decodes = async (file: Blob): Promise<boolean> => {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    return jpeg || png;
  };
  return {
    rawBytesOf: async () => undefined,
    readRawMetadata: async () => undefined,
    workerThumb: async (file: Blob) =>
      (await decodes(file))
        ? { ok: true, thumb: new Blob(["thumb"], { type: "image/jpeg" }), width: 640, height: 480 }
        : null,
    decodeImportBitmap: async () => ({ failure: "unsupported", reason: "not an image" }),
    catalogSize: (_frame: unknown, _rotation: number, decoded: { bitmap: { width: number; height: number } }) => ({
      width: decoded.bitmap.width,
      height: decoded.bitmap.height,
    }),
    storable: () => null,
    turned: (size: { width: number; height: number }) => size,
  };
});

/** A MemoryFs whose listing of chosen folders is refused, as an ACL does. */
class LockedFs extends MemoryFs {
  private readonly locked = new Set<string>();

  lock(path: string): this {
    this.locked.add(path);
    return this;
  }

  override async list(path: string): Promise<{ name: string; kind: "file" | "directory" }[]> {
    if (this.locked.has(path)) throw new FsError("EACCES", "scandir", path);
    return super.list(path);
  }
}

const ROOT = "/home/u/shoot";
const SL = `${ROOT}/.safelight`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const TRUNCATED_RAW = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x10, 0x00]);
const LONG_NAME = `Ünïcødé 写真 ${"長".repeat(120)}.jpg`;

const says = (text: string) => document.body.textContent?.includes(text) ?? false;

async function openFolder(fs: MemoryFs): Promise<void> {
  await act(async () => {
    await useProjectStore.getState().openProject(fsaDirectoryHandle(fs, ROOT));
  });
}

const photo = (filename: string) =>
  useCatalogStore.getState().photos.find((p) => p.filename === filename);

let createObjectURL: PropertyDescriptor | undefined;

beforeEach(() => {
  localStorage.clear();
  resetSetupForTests();
  // A returning user's launch: the welcome setup has been seen.
  writeSetupRecord(localStorage, "finished", "0.0.0");
  vi.stubGlobal("BroadcastChannel", class {
    postMessage(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {}
  });
  createObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:smoke" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  useRegistry.setState({ modules: {} });
  registerEssentialModules();
  useExternalPluginsSettled.setState({ settled: true });
  useUIStore.setState({ activeModule: "library", detached: new Set() });
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  act(() => useProjectStore.getState().closeProject());
  unregisterEssentialModules();
  useExternalPluginsSettled.setState({ settled: false });
  if (createObjectURL) Object.defineProperty(URL, "createObjectURL", createObjectURL);
  else Reflect.deleteProperty(URL, "createObjectURL");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("smoke: app boot", () => {
  it("boots with no project onto the welcome grid", async () => {
    render(<App />);
    expect(await screen.findByText("Recent projects")).toBeTruthy();
    expect(screen.getByText("Open Folder…")).toBeTruthy();
  });

  it("opens an empty folder into the Library shell", async () => {
    const fs = new MemoryFs(ROOT);
    render(<App />);

    await openFolder(fs);

    expect(useProjectStore.getState()).toMatchObject({ openError: null, storageNotice: null, opening: false });
    expect(screen.getByRole("navigation", { name: "Views" })).toBeTruthy();
    expect(screen.getByText("library view")).toBeTruthy();
    expect(screen.getByText("0 photos in catalogue")).toBeTruthy();
    expect(fs.has(SL)).toBe(true);
  });

  it("opens a project whose catalogue was cut off mid-write, keeping the damaged copy", async () => {
    const truncated = '{"version":1,"photos":[{"id":"p1:a.jpg"';
    const fs = new MemoryFs(ROOT).putBytes(`${ROOT}/a.jpg`, JPEG).put(`${SL}/catalog.json`, truncated);
    render(<App />);

    await openFolder(fs);

    const kept = fs.tree(SL).filter((p) => /\/catalog\.corrupt-[^/]+\.json$/.test(p));
    expect(kept).toHaveLength(1);
    expect(fs.text(kept[0])).toBe(truncated);
    const keptName = kept[0].slice(kept[0].lastIndexOf("/") + 1);
    const notice = useProjectStore.getState().storageNotice ?? "";
    expect(notice).toContain("imported the folder again");
    expect(notice).toContain(keptName);
    expect(says(notice)).toBe(true);
    expect(useProjectStore.getState().openError).toBeNull();
    expect(screen.getByText("library view")).toBeTruthy();
    expect(screen.getByText("1 photo in catalogue")).toBeTruthy();
    expect(JSON.parse(fs.text(`${SL}/catalog.json`) ?? "null").photos).toHaveLength(1);
  });
});

describe("smoke: opening a folder of mixed files", () => {
  function mixedFolder(): LockedFs {
    return new LockedFs(ROOT)
      .putBytes(`${ROOT}/good.jpg`, JPEG)
      .putBytes(`${ROOT}/good.png`, PNG)
      .putBytes(`${ROOT}/empty.jpg`, new Uint8Array())
      .putBytes(`${ROOT}/IMG_0001.CR2`, TRUNCATED_RAW)
      .putBytes(`${ROOT}/phone.heic`, new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]))
      .put(`${ROOT}/notes.txt`, "not a photo")
      .putBytes(`${ROOT}/trip/${LONG_NAME}`, JPEG)
      .putBytes(`${ROOT}/locked/hidden.jpg`, JPEG)
      .lock(`${ROOT}/locked`);
  }

  it("imports what it can, marks what it couldn't decode, and says what it skipped", async () => {
    const fs = mixedFolder();
    render(<App />);

    await openFolder(fs);

    const state = useProjectStore.getState();
    expect(state.openError).toBeNull();
    expect(state.opening).toBe(false);
    const names = useCatalogStore.getState().photos.map((p) => p.filename).sort();
    expect(names).toEqual(["IMG_0001.CR2", LONG_NAME, "empty.jpg", "good.jpg", "good.png"].sort());

    expect(photo("good.jpg")?.decodeError).toBeUndefined();
    expect(photo("good.png")?.decodeError).toBeUndefined();
    expect(photo(LONG_NAME)).toMatchObject({ relPath: `trip/${LONG_NAME}`, width: 640 });
    expect(photo("empty.jpg")).toMatchObject({ width: 0, decodeError: "No decoder could read this file." });
    expect(photo("IMG_0001.CR2")).toMatchObject({ width: 0, decodeError: "This RAW file can't be decoded." });

    const notice = state.storageNotice ?? "";
    expect(notice).toContain("The folder “locked” couldn't be read, so it was skipped.");
    expect(notice).toContain("1 HEIC file was skipped — HEIC isn't supported yet.");
    expect(notice).not.toMatch(/txt/i);
    expect(says(notice)).toBe(true);
    expect(screen.getByText("5 photos in catalogue")).toBeTruthy();
    expect(state.tree?.children.find((c) => c.name === "locked")).toMatchObject({ unreadable: true });

    const saved = JSON.parse(fs.text(`${SL}/catalog.json`) ?? "null") as { photos: { filename: string }[] };
    expect(saved.photos.map((p) => p.filename).sort()).toEqual(names);
  });

  it("opens the same folder again without importing anything twice", async () => {
    const fs = mixedFolder();
    render(<App />);
    await openFolder(fs);
    const first = useCatalogStore.getState().photos.map((p) => p.id).sort();
    act(() => useProjectStore.getState().closeProject());

    await openFolder(fs);

    expect(useCatalogStore.getState().photos.map((p) => p.id).sort()).toEqual(first);
  });
});
