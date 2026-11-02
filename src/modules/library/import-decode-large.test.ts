// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// TIFF and Netpbm thumbnails go to the import worker, and whole-file decodes
// of big non-RAW images run two at a time however many files the import reads
// at once. Files are stand-ins carrying a name and a size.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThumbTaskInput, ThumbTaskResult } from "./import-thumb-task";

const h = vi.hoisted(() => ({
  /** Names handed to the worker pool, in order. */
  toWorker: [] as string[],
  /** Decodes under way at once, and the most there ever were. */
  running: 0,
  peak: 0,
  /** Lets every decode that has started finish. */
  release: [] as (() => void)[],
}));

async function decoding<T>(result: T): Promise<T> {
  h.running++;
  h.peak = Math.max(h.peak, h.running);
  await new Promise<void>((resolve) => h.release.push(resolve));
  h.running--;
  return result;
}

const bitmap = { width: 4, height: 3, close() {} } as unknown as ImageBitmap;

vi.mock("./import-thumb-pool", () => ({
  processThumb: (input: ThumbTaskInput): Promise<ThumbTaskResult> => {
    h.toWorker.push(input.name);
    return decoding({ ok: true, thumb: new Blob(["thumb"]), width: 4, height: 3 });
  },
}));

vi.mock("@/raw/tiff-image", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/raw/tiff-image")>()),
  decodeTiff: () => decoding(bitmap),
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ previewSource: "auto", thumbMaxEdge: 640 }),
}));

import { decodeImportBitmap, workerThumb } from "./import-decode";

const MIB = 2 ** 20;

function fileOf(name: string, size: number): File {
  return {
    name,
    size,
    type: "",
    lastModified: 0,
    arrayBuffer: async () => new ArrayBuffer(8),
  } as unknown as File;
}

// Lets every decode started so far finish, until all of `pending` settle.
async function drain<T>(pending: Promise<T>[]): Promise<T[]> {
  let settled = false;
  const all = Promise.all(pending).finally(() => {
    settled = true;
  });
  while (!settled) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const release of h.release.splice(0)) release();
  }
  return all;
}

beforeEach(() => {
  h.toWorker = [];
  h.running = 0;
  h.peak = 0;
  h.release = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workerThumb", () => {
  it("hands TIFF and Netpbm files to the import worker", async () => {
    const results = await drain([
      workerThumb(fileOf("scan.tif", MIB), undefined),
      workerThumb(fileOf("frame.ppm", MIB), undefined),
    ]);

    expect(h.toWorker).toEqual(["scan.tif", "frame.ppm"]);
    expect(results.every((r) => r?.ok)).toBe(true);
  });

  it("hands over big non-RAW files two at a time", async () => {
    const files = Array.from({ length: 8 }, (_, i) => fileOf(`scan-${i}.tif`, 200 * MIB));

    const results = await drain(files.map((f) => workerThumb(f, undefined)));

    expect(h.peak).toBe(2);
    expect(results.every((r) => r?.ok)).toBe(true);
  });

  it("leaves small files unthrottled", async () => {
    const files = Array.from({ length: 4 }, (_, i) => fileOf(`small-${i}.tif`, MIB));

    await drain(files.map((f) => workerThumb(f, undefined)));

    expect(h.peak).toBe(4);
  });
});

describe("decodeImportBitmap", () => {
  it("decodes big non-RAW files inline two at a time", async () => {
    const files = Array.from({ length: 8 }, (_, i) => fileOf(`scan-${i}.tif`, 200 * MIB));

    const results = await drain(files.map((f) => decodeImportBitmap(f, undefined)));

    expect(h.peak).toBe(2);
    expect(results).toEqual(files.map(() => ({ bitmap, oriented: false })));
  });
});
