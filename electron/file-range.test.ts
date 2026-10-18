// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The import reads a RAW's head and camera preview, not the whole file: the
// desktop bridge serves a byte range of a file, with the whole file's size and
// mtime. Runs against a temp folder.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileRange } from "./file-range.cjs";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-file-range-"));
  file = path.join(dir, "a.NEF");
  await fsp.writeFile(file, Uint8Array.from({ length: 100 }, (_, i) => i));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const numbers = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe("readFileRange", () => {
  it("reads the bytes from start up to end, and reports the whole file's size", async () => {
    const { data, size } = await readFileRange(file, 10, 20);
    expect([...data]).toEqual(numbers(10, 20));
    expect(size).toBe(100);
  });

  it("reports the file's modification time", async () => {
    const when = new Date("2024-05-06T07:08:09Z");
    await fsp.utimes(file, when, when);
    const { mtimeMs } = await readFileRange(file, 0, 4);
    expect(mtimeMs).toBe(when.getTime());
  });

  it("stops at the end of the file", async () => {
    const { data, size } = await readFileRange(file, 90, 4096);
    expect([...data]).toEqual(numbers(90, 100));
    expect(size).toBe(100);
  });

  it("reads nothing from past the end", async () => {
    const { data } = await readFileRange(file, 150, 200);
    expect(data.length).toBe(0);
  });

  it.each([
    [-1, 10],
    [10, 5],
    [0, Number.POSITIVE_INFINITY],
    [Number.NaN, 10],
    [0.5, 10],
  ])("refuses the range %s to %s", async (start, end) => {
    await expect(readFileRange(file, start, end)).rejects.toThrow(RangeError);
  });

  it("rejects a missing file the way a whole-file read does", async () => {
    await expect(readFileRange(path.join(dir, "gone.NEF"), 0, 10)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
