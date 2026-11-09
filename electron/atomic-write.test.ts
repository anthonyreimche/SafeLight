// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Every renderer file write (catalog.json, previews) lands through one writer in
// the main process: a write is either fully on disk or not there at all, writes
// to one file land in order with the newest winning, and quitting can wait for
// what is still in flight. Runs against a temp folder.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAtomicWriter, writeAtomicSync } from "./atomic-write.cjs";
import { retry } from "./plugin-files.cjs";

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-atomic-write-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(dir, { recursive: true, force: true });
});

const randomId = () => crypto.randomBytes(8).toString("hex");
const fastRetry = (op: () => Promise<unknown>) => retry(op, { delayMs: 1 });
const bytes = (text: string) => new TextEncoder().encode(text);
const read = (p: string) => fsp.readFile(p, "utf8");
const leftovers = async () => (await fsp.readdir(dir)).filter((n) => n.includes(".tmp-"));

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function busy(): NodeJS.ErrnoException {
  return Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" });
}

// Not a code retry() waits out, so the write fails at once.
function ioError(): NodeJS.ErrnoException {
  return Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
}

/** fs/promises with every rename recorded, and optionally held or failed first. */
function renames(before?: (to: string, n: number) => Promise<void> | void) {
  const calls: string[] = [];
  const counted = {
    ...fsp,
    async rename(from: string, to: string) {
      calls.push(to);
      if (before) await before(to, calls.length);
      return fsp.rename(from, to);
    },
  };
  return { fsp: counted, calls };
}

describe("createAtomicWriter", () => {
  it("lands only the newest of 50 overlapping writes, renaming at most twice", async () => {
    const target = path.join(dir, "catalog.json");
    const { fsp: counted, calls } = renames();
    const writer = createAtomicWriter({ fsp: counted, randomId, retry: fastRetry });

    const writes = Array.from({ length: 50 }, (_, i) => writer.write(target, bytes(`{"v":${i}}`)));
    // A superseded caller resolves once the write that replaced it is on disk.
    const seen = await Promise.all(writes.slice(1).map((w) => w.then(() => read(target))));
    await writes[0];

    expect(await read(target)).toBe('{"v":49}');
    expect(seen).toEqual(Array(49).fill('{"v":49}'));
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(await leftovers()).toEqual([]);
  });

  it("gives two same-millisecond writes their own temp files", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
    const target = path.join(dir, "catalog.json");
    const opened: string[] = [];
    const tracked = {
      ...fsp,
      open(p: string, flags: string) {
        opened.push(p);
        return fsp.open(p, flags);
      },
    };
    // Two writers, so one writer's per-path queue can't hide a shared temp name.
    const a = createAtomicWriter({ fsp: tracked, randomId, retry: fastRetry });
    const b = createAtomicWriter({ fsp: tracked, randomId, retry: fastRetry });

    await Promise.all([a.write(target, bytes("A")), b.write(target, bytes("B"))]);

    expect(new Set(opened).size).toBe(2);
    expect(["A", "B"]).toContain(await read(target));
    expect(await leftovers()).toEqual([]);
  });

  it("lands a write whose rename is busy twice before it goes through", async () => {
    const target = path.join(dir, "catalog.json");
    const { fsp: flaky, calls } = renames((_to, n) => {
      if (n <= 2) throw busy();
    });
    const writer = createAtomicWriter({ fsp: flaky, randomId, retry: fastRetry });

    await writer.write(target, bytes("saved"));

    expect(await read(target)).toBe("saved");
    expect(calls.length).toBe(3);
    expect(await leftovers()).toEqual([]);
  });

  it("rejects, keeps the old file and removes its temp file when every rename fails", async () => {
    const target = path.join(dir, "catalog.json");
    await fsp.writeFile(target, "before");
    const { fsp: stuck } = renames(() => {
      throw busy();
    });
    const writer = createAtomicWriter({ fsp: stuck, randomId, retry: fastRetry });

    await expect(writer.write(target, bytes("after"))).rejects.toMatchObject({ code: "EBUSY" });

    expect(await read(target)).toBe("before");
    expect(await leftovers()).toEqual([]);
    expect(writer.activePaths()).toBe(0);
  });

  it("drain() waits for a write still in flight", async () => {
    const target = path.join(dir, "catalog.json");
    const held = gate();
    const { fsp: holding, calls } = renames(() => held.opened);
    const writer = createAtomicWriter({ fsp: holding, randomId, retry: fastRetry });
    await writer.drain();

    const write = writer.write(target, bytes("last"));
    let drained = false;
    const drain = writer.drain().then(() => {
      drained = true;
    });
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(drained).toBe(false);

    held.open();
    await drain;
    expect(await read(target)).toBe("last");
    await write;
  });

  it("drain() with one write in flight and one waiting waits for both", async () => {
    const target = path.join(dir, "catalog.json");
    const first = gate();
    const second = gate();
    const { fsp: holding, calls } = renames((_to, n) => (n === 1 ? first.opened : second.opened));
    const writer = createAtomicWriter({ fsp: holding, randomId, retry: fastRetry });

    const writes = [writer.write(target, bytes("1")), writer.write(target, bytes("2"))];
    let drained = false;
    const drain = writer.drain().then(() => {
      drained = true;
    });
    await vi.waitFor(() => expect(calls.length).toBe(1));
    first.open();
    await writes[0];
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(drained).toBe(false);

    second.open();
    await drain;
    expect(await read(target)).toBe("2");
    await writes[1];
  });

  it("rejects superseded callers with the replacing write's error when it fails", async () => {
    const target = path.join(dir, "catalog.json");
    const failure = ioError();
    const { fsp: failing } = renames((_to, n) => {
      if (n === 2) throw failure;
    });
    const writer = createAtomicWriter({ fsp: failing, randomId, retry: fastRetry });

    const first = writer.write(target, bytes("1"));
    const superseded = writer.write(target, bytes("2"));
    const replacing = writer.write(target, bytes("3"));

    await expect(first).resolves.toBeUndefined();
    await expect(superseded).rejects.toBe(failure);
    await expect(replacing).rejects.toBe(failure);
    expect(await read(target)).toBe("1");
    expect(await leftovers()).toEqual([]);
    expect(writer.activePaths()).toBe(0);
  });

  it("lands the waiting write after the one in flight fails", async () => {
    const target = path.join(dir, "catalog.json");
    const failure = ioError();
    const { fsp: failing } = renames((_to, n) => {
      if (n === 1) throw failure;
    });
    const writer = createAtomicWriter({ fsp: failing, randomId, retry: fastRetry });

    const failed = writer.write(target, bytes("1"));
    const waiting = writer.write(target, bytes("2"));

    await expect(failed).rejects.toBe(failure);
    await expect(waiting).resolves.toBeUndefined();
    expect(await read(target)).toBe("2");
    expect(await leftovers()).toEqual([]);
  });

  it("runs writes to different paths side by side", async () => {
    const slow = path.join(dir, "catalog.json");
    const fast = path.join(dir, "previews", "a.jpg");
    const held = gate();
    const { fsp: holding } = renames((to) => (to === slow ? held.opened : undefined));
    const writer = createAtomicWriter({ fsp: holding, randomId, retry: fastRetry });

    const slowWrite = writer.write(slow, bytes("slow"));
    await writer.write(fast, bytes("fast"));

    expect(await read(fast)).toBe("fast");
    expect(fs.existsSync(slow)).toBe(false);
    held.open();
    await slowWrite;
    expect(await read(slow)).toBe("slow");
  });

  it("forgets every path once its writes are done", async () => {
    const writer = createAtomicWriter({ fsp, randomId, retry: fastRetry });
    const paths = Array.from({ length: 20 }, (_, i) => path.join(dir, "previews", `${i}.jpg`));

    const writes = paths.map((p, i) => writer.write(p, bytes(String(i))));
    expect(writer.activePaths()).toBe(20);
    await Promise.all(writes);

    expect(writer.activePaths()).toBe(0);
  });

  describe("orphaned temp files", () => {
    const MINUTE = 60_000;
    const orphan = async (name: string, ageMs: number) => {
      const p = path.join(dir, name);
      await fsp.writeFile(p, "x");
      const when = new Date(Date.now() - ageMs);
      await fsp.utimes(p, when, when);
      return p;
    };

    it("sweeps temp files older than ten minutes from a directory on its first write", async () => {
      const stale = await orphan("catalog.json.tmp-0123456789abcdef", 11 * MINUTE);
      const fresh = await orphan("catalog.json.tmp-fedcba9876543210", MINUTE);
      const other = await orphan("notes.txt", 60 * MINUTE);
      const writer = createAtomicWriter({ fsp, randomId, retry: fastRetry });

      await writer.write(path.join(dir, "catalog.json"), bytes("{}"));

      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      expect(fs.existsSync(other)).toBe(true);
    });

    it("sweeps a directory once per writer, not on every write", async () => {
      const writer = createAtomicWriter({ fsp, randomId, retry: fastRetry });
      await writer.write(path.join(dir, "catalog.json"), bytes("1"));
      const late = await orphan("catalog.json.tmp-0123456789abcdef", 30 * MINUTE);

      await writer.write(path.join(dir, "catalog.json"), bytes("2"));

      expect(fs.existsSync(late)).toBe(true);
    });

    it("never deletes the temp file of a write still in flight, however old it looks", async () => {
      const target = path.join(dir, "catalog.json");
      const held = gate();
      const opened: string[] = [];
      const tracked = {
        ...fsp,
        async open(p: string, flags: string) {
          opened.push(p);
          return fsp.open(p, flags);
        },
        async rename(from: string, to: string) {
          await held.opened;
          return fsp.rename(from, to);
        },
      };
      const writer = createAtomicWriter({ fsp: tracked, randomId, retry: fastRetry });

      const first = writer.write(target, bytes("big"));
      await vi.waitFor(() => expect(opened.length).toBe(1));
      const old = new Date(Date.now() - 60 * MINUTE);
      await fsp.utimes(opened[0], old, old);
      // A second writer in the same process sweeps the same directory.
      const second = createAtomicWriter({ fsp: tracked, randomId, retry: fastRetry });
      const sweeping = second.write(path.join(dir, "other.json"), bytes("o"));
      held.open();
      await Promise.all([first, sweeping]);

      expect(await read(target)).toBe("big");
    });

    it("keeps writing when the sweep itself fails", async () => {
      const broken = { ...fsp, readdir: () => Promise.reject(new Error("EPERM")) };
      const writer = createAtomicWriter({ fsp: broken, randomId, retry: fastRetry });

      await writer.write(path.join(dir, "catalog.json"), bytes("ok"));

      expect(await read(path.join(dir, "catalog.json"))).toBe("ok");
    });
  });

  it.runIf(process.platform === "win32")("treats two spellings of one path as one file", async () => {
    const writer = createAtomicWriter({ fsp, randomId, retry: fastRetry });

    const first = writer.write(path.join(dir, "catalog.json"), bytes("1"));
    const second = writer.write(path.join(dir, ".", "CATALOG.JSON"), bytes("2"));
    expect(writer.activePaths()).toBe(1);
    await Promise.all([first, second]);

    expect(await read(path.join(dir, "catalog.json"))).toBe("2");
  });
});

describe("writeAtomicSync", () => {
  it("writes the text to a new file and creates the directory", () => {
    const file = path.join(dir, "nested", "state.json");
    writeAtomicSync(file, "one");
    expect(fs.readFileSync(file, "utf8")).toBe("one");
  });

  it("replaces an existing file's content and leaves no temp sibling", async () => {
    const file = path.join(dir, "state.json");
    fs.writeFileSync(file, "old");
    writeAtomicSync(file, "new");
    expect(fs.readFileSync(file, "utf8")).toBe("new");
    expect(await leftovers()).toEqual([]);
  });

  it("keeps the old content and removes the temp file when the rename fails", async () => {
    const file = path.join(dir, "state.json");
    fs.writeFileSync(file, "old");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    });
    expect(() => writeAtomicSync(file, "new")).toThrow("busy");
    expect(fs.readFileSync(file, "utf8")).toBe("old");
    expect(await leftovers()).toEqual([]);
  });
});
