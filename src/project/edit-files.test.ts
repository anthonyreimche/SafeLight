// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Each photo's edit history in a file of its own under .safelight/edits/. What
// the file is named, what a read of it can find, and how writes to it land.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditState } from "@/catalog/types";
import type { NativeFsBridge } from "@/extensions/types";
import type { ChangeStamp } from "./change-stamps";
import { FsError, MemoryFs, fsaDirectoryHandle } from "./memory-fs.test-support";

const h = vi.hoisted(() => ({ fs: null as NativeFsBridge | null }));

vi.mock("@/native/privileged", () => ({ privilegedFs: () => h.fs }));

import {
  EditDamagedError,
  EditFiles,
  EditNameClashError,
  EditTooNewError,
  EditUnreadableError,
  fileOf,
  isEditState,
  openableEdit,
  parse,
  type EditRecovery,
} from "./edit-files";
import { nativeDirectoryHandle } from "./native-fs";

const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value));

const UUID = "3f2b8c1e-9d4a-4e6b-8f1a-2c3d4e5f6a7b";

function edit(photoId: string, ...labels: string[]): EditState {
  return {
    photoId,
    stack: labels.map((label, i) => ({
      timestamp: i,
      label,
      params: {} as EditState["stack"][0]["params"],
    })),
    currentIndex: labels.length - 1,
  };
}

function body(state: EditState, stamp?: ChangeStamp, format = 1) {
  return { format, photoId: state.photoId, stamp, stack: state.stack, currentIndex: state.currentIndex };
}

describe("fileOf", () => {
  it("names a file after an id that is a safe file name, in a shard of its hash", () => {
    // 64-bit FNV-1a("foobar") = 0x85944171f73967e8
    expect(fileOf("foobar")).toEqual({ shard: "e8", name: "foobar" });
    expect(fileOf(UUID).name).toBe(UUID);
    expect(fileOf(UUID).shard).toMatch(/^[0-9a-f]{2}$/);
  });

  it("names a file after the hash and a readable hint for any other id", () => {
    const { shard, name } = fileOf("id:trip/IMG_0001.NEF");
    expect(name).toMatch(/^x-[0-9a-f]{16}-id-trip-img-0001-nef$/);
    expect(name.slice(16, 18)).toBe(shard);
  });

  it("takes the hint from the end of a long id, where a path names its file", () => {
    const id = "D:/Photos/2026/Holidays/Summer in the mountains/Day 3 morning/IMG_0001.NEF";
    expect(fileOf(id).name).toMatch(/^x-[0-9a-f]{16}-[a-z0-9-]*day-3-morning-img-0001-nef$/);
    expect(fileOf(id).name.length).toBeLessThanOrEqual(64);
  });

  it("gives each of 50,000 ids that share a long prefix a name of its own", () => {
    const prefix = "D:/Photos/2026/Holidays/Summer in the mountains/Day 3 morning/";
    const names = new Set(Array.from({ length: 50_000 }, (_, i) => fileOf(`${prefix}${i}`).name));
    expect(names.size).toBe(50_000);
    const hashes = new Set(
      Array.from({ length: 50_000 }, (_, i) => fileOf(`${prefix}IMG.NEF#${i}`).name.slice(0, 18)),
    );
    expect(hashes.size).toBe(50_000);
  });

  it("gives ids that one sanitizer would collapse together names of their own", () => {
    const names = ["a:b", "a/b", "a_b", "a.b", "a b", "A-B", "a-B"].map((id) => fileOf(id).name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("a-b");
  });

  it("hashes ids that differ from another only in case, for a file system that ignores it", () => {
    expect(fileOf("ABC").name).not.toBe(fileOf("abc").name);
    expect(fileOf("abc").name).toBe("abc");
  });

  it("hashes ids Windows reserves as device names, and ids shaped like a hashed name", () => {
    for (const id of ["con", "nul", "aux", "prn", "com1", "lpt9"])
      expect(fileOf(id).name).toMatch(/^x-[0-9a-f]{16}-/);
    expect(fileOf("x-12345678-foo").name).not.toBe("x-12345678-foo");
  });

  it("keeps a name short, and its prefix a name, for a long or empty id", () => {
    expect(fileOf("a".repeat(64)).name).toBe("a".repeat(64));
    const long = fileOf("a".repeat(65)).name;
    expect(long).toMatch(/^x-[0-9a-f]{16}-a+$/);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(fileOf("").name).toMatch(/^x-[0-9a-f]{16}$/);
    expect(fileOf("::/").name).toMatch(/^x-[0-9a-f]{16}$/);
  });

  it("spreads ids over the 256 shards", () => {
    const shards = new Set(Array.from({ length: 2000 }, (_, i) => fileOf(`photo-${i}`).shard));
    expect(shards.size).toBeGreaterThan(240);
    for (const shard of shards) expect(shard).toMatch(/^[0-9a-f]{2}$/);
  });
});

describe("parse", () => {
  it("reads an edit file's history and stamp", () => {
    const state = edit("p1", "Original", "Exposure");
    expect(parse(bytes(body(state, [5, "w1"])))).toEqual({
      kind: "ok",
      edit: state,
      stamp: [5, "w1"],
      partial: false,
    });
  });

  it("reads a file without a stamp, or with one it can't read, as unstamped", () => {
    const state = edit("p1", "Original");
    expect(parse(bytes(body(state)))).toMatchObject({ kind: "ok", stamp: undefined });
    expect(parse(bytes({ ...body(state), stamp: ["late", 1] }))).toMatchObject({
      kind: "ok",
      edit: state,
      stamp: undefined,
    });
  });

  it("finds a file damaged when it holds no edit history", () => {
    const state = edit("p1", "Original");
    for (const damaged of [
      new Uint8Array(),
      encoder.encode('{"format":1,"photoId":"p1","st'),
      encoder.encode("not json"),
      bytes([body(state)]),
      bytes({ ...body(state), stack: undefined }),
      bytes({ ...body(state), photoId: 7 }),
      bytes({ ...body(state), format: undefined }),
      bytes({ ...body(state), format: 0 }),
      bytes({ ...body(state), stack: [null, "x"] }),
    ])
      expect(parse(damaged)).toEqual({ kind: "damaged" });
  });

  it("tells a file of a newer format apart from a damaged one", () => {
    expect(parse(bytes(body(edit("p1", "Original"), undefined, 2)))).toEqual({
      kind: "too-new",
      format: 2,
    });
  });

  it("leaves out the snapshots it can't open, keeping the cursor on its snapshot", () => {
    const state = edit("p1", "Original", "A", "B");
    const stored = { ...body(state), stack: [state.stack[0], 42, state.stack[1], state.stack[2]], currentIndex: 2 };
    expect(parse(bytes(stored))).toEqual({
      kind: "ok",
      edit: { ...state, currentIndex: 1 },
      stamp: undefined,
      partial: true,
    });
  });
});

describe("the edit validators", () => {
  it("accept a history every reader can open, and nothing else", () => {
    expect(isEditState(edit("p1", "Original"))).toBe(true);
    expect(isEditState({ photoId: "p1", stack: [{ params: null }], currentIndex: 0 })).toBe(true);
    expect(isEditState({ photoId: "p1", stack: [{ params: 3 }], currentIndex: 0 })).toBe(false);
    expect(isEditState({ photoId: "p1", stack: [], currentIndex: "0" })).toBe(false);
    expect(isEditState(null)).toBe(false);
  });

  it("open a history by leaving out what can't be opened", () => {
    const state = edit("p1", "Original", "A");
    expect(openableEdit(state)).toBe(state);
    const broken = { ...state, stack: [state.stack[0], "x" as never, state.stack[1]], currentIndex: 1 };
    expect(openableEdit(broken)).toEqual({ ...state, currentIndex: 0 });
    expect(openableEdit({ ...state, stack: ["x" as never] })).toBeNull();
  });
});

/** A MemoryFs whose reads or writes of chosen files fail with an errno, as they
 *  do while a sync or antivirus program holds the file. */
class FlakyFs extends MemoryFs {
  private failingReads: { path: RegExp; code: string; left: number } | null = null;
  private failingWrites: { path: RegExp; code: string; left: number } | null = null;

  failReads(path: RegExp, code: string, times = Infinity): void {
    this.failingReads = { path, code, left: times };
  }

  failWrites(path: RegExp, code: string, times = Infinity): void {
    this.failingWrites = { path, code, left: times };
  }

  stopFailingWrites(): void {
    this.failingWrites = null;
  }

  override async read(path: string): Promise<{ data: Uint8Array; mtimeMs: number; size: number }> {
    const failing = this.failingReads;
    if (failing && failing.left > 0 && failing.path.test(path)) {
      failing.left--;
      throw new FsError(failing.code, "open", path);
    }
    return super.read(path);
  }

  override async write(path: string, data: Uint8Array): Promise<void> {
    const failing = this.failingWrites;
    if (failing && failing.left > 0 && failing.path.test(path)) {
      failing.left--;
      throw new FsError(failing.code, "open", path);
    }
    return super.write(path, data);
  }
}

type WriteSpy = { mock: { calls: [path: string, data: Uint8Array][] } };

/** What the writes `write` saw from call `from` on carried, as text. */
const writtenText = (write: WriteSpy, from = 0) =>
  write.mock.calls.slice(from).map(([, data]) => new TextDecoder().decode(data)).join("\n");

/** How many photos' files the writes `write` saw went to. */
const photosWritten = (write: WriteSpy) =>
  new Set(write.mock.calls.map(([path]) => path.replace(/\\/g, "/"))).size;

const BUILDS = [
  { label: "electron · windows", slPath: "D:/DCIM/.safelight", native: true },
  { label: "browser · FSA", slPath: "/home/u/photos/.safelight", native: false },
] as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(BUILDS)("EditFiles ($label)", (cfg) => {
  let fs: FlakyFs;
  let recoveries: EditRecovery[];

  beforeEach(() => {
    fs = new FlakyFs(cfg.slPath);
    h.fs = cfg.native ? fs : null;
    recoveries = [];
  });

  const sl = () => (cfg.native ? nativeDirectoryHandle(cfg.slPath) : fsaDirectoryHandle(fs, cfg.slPath));
  const files = (options: { keepBackups?: boolean } = {}) =>
    new EditFiles(sl(), { ...options, onRecovered: (recovery) => recoveries.push(recovery) });

  const pathOf = (id: string, suffix = ".json") => {
    const { shard, name } = fileOf(id);
    return `${cfg.slPath}/edits/${shard}/${name}${suffix}`;
  };
  const onDisk = (id: string, suffix?: string): unknown => {
    const text = fs.text(pathOf(id, suffix));
    return text === null ? null : JSON.parse(text);
  };
  const keptAside = (id: string) => {
    const { shard, name } = fileOf(id);
    return fs
      .tree(`${cfg.slPath}/edits/${shard}`)
      .filter((path) => path.includes(`/${name}.corrupt-`));
  };

  describe("read", () => {
    it("finds no edit for a photo without a file, with or without an edits folder", async () => {
      await expect(files().read(UUID)).resolves.toBeUndefined();
      fs.put(pathOf("other"), JSON.stringify(body(edit("other", "Original"))));
      await expect(files().read(UUID)).resolves.toBeUndefined();
    });

    it("reads back what write stored, with its stamp", async () => {
      const store = files();
      const state = edit("id:trip/IMG.NEF", "Original", "Exposure");
      await store.write(state, [7, "w1"]);
      expect(onDisk(state.photoId)).toEqual({
        format: 1,
        photoId: state.photoId,
        stamp: [7, "w1"],
        stack: state.stack,
        currentIndex: 1,
      });
      await expect(files().read(state.photoId)).resolves.toEqual({ edit: state, stamp: [7, "w1"] });
    });

    it("reads a file once for reads that overlap", async () => {
      const state = edit(UUID, "Original");
      fs.put(pathOf(UUID), JSON.stringify(body(state)));
      const store = files();
      const [a, b] = await Promise.all([store.read(UUID), store.read(UUID)]);
      expect(a).toEqual({ edit: state, stamp: undefined });
      expect(b).toBe(a);
      expect(fs.bytesRead(pathOf(UUID))).toBe(fs.bytes(pathOf(UUID))?.length);
      await store.read(UUID);
      expect(fs.bytesRead(pathOf(UUID))).toBe(2 * (fs.bytes(pathOf(UUID))?.length ?? 0));
    });

    it("waits for a file another program holds", async () => {
      const state = edit(UUID, "Original");
      fs.put(pathOf(UUID), JSON.stringify(body(state)));
      fs.failReads(/\.json$/, "EBUSY", 3);
      const read = files().read(UUID);
      await vi.advanceTimersByTimeAsync(250 + 500 + 1000);
      await expect(read).resolves.toEqual({ edit: state, stamp: undefined });
    });

    it("rejects, and never finds no edit, for a file that stays unreadable", async () => {
      fs.put(pathOf(UUID), JSON.stringify(body(edit(UUID, "Original"))));
      fs.failReads(/\.json$/, "EBUSY");
      const read = files().read(UUID);
      const settled = read.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(250 + 500 + 1000 + 2000 - 1);
      let done = false;
      void settled.then(() => (done = true));
      await Promise.resolve();
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await settled;
      expect(outcome).toEqual({ error: expect.any(EditUnreadableError) });
      expect((outcome as { error: EditUnreadableError }).error.reason).toBe("EBUSY");
      expect(onDisk(UUID)).toEqual(body(edit(UUID, "Original")));
    });

    it("rejects a file saved in a newer format, leaving it as it is", async () => {
      const stored = JSON.stringify(body(edit(UUID, "Original"), undefined, 2));
      fs.put(pathOf(UUID), stored);
      await expect(files().read(UUID)).rejects.toBeInstanceOf(EditTooNewError);
      expect(fs.text(pathOf(UUID))).toBe(stored);
      expect(keptAside(UUID)).toEqual([]);
    });

    it("rejects a file that holds another photo's edit", async () => {
      fs.put(pathOf(UUID), JSON.stringify(body(edit("someone-else", "Original"))));
      await expect(files().read(UUID)).rejects.toBeInstanceOf(EditUnreadableError);
    });

    it("keeps a damaged file aside and restores the edit from its backup", async () => {
      const backup = edit(UUID, "Original", "Backed up");
      fs.put(pathOf(UUID), '{"format":1,"photoId":"');
      fs.put(pathOf(UUID, ".bak.json"), JSON.stringify(body(backup, [3, "w0"])));

      await expect(files().read(UUID)).resolves.toEqual({ edit: backup, stamp: [3, "w0"] });
      await vi.advanceTimersByTimeAsync(0);

      const kept = keptAside(UUID);
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatch(/\.corrupt-[0-9T-]+Z\.json$/);
      expect(fs.text(kept[0])).toBe('{"format":1,"photoId":"');
      expect(onDisk(UUID)).toEqual(body(backup, [3, "w0"]));
      expect(recoveries).toEqual([
        { photoId: UUID, from: "backup", kept: kept[0].slice(kept[0].lastIndexOf("/") + 1) },
      ]);
    });

    it("doesn't restore the backup over a write asked for while the read ran", async () => {
      const backup = edit(UUID, "Original", "Backed up");
      fs.put(pathOf(UUID), "garbage");
      fs.put(pathOf(UUID, ".bak.json"), JSON.stringify(body(backup)));
      const store = files();
      const held = fs.holdWrites();
      const read = store.read(UUID);
      await vi.advanceTimersByTimeAsync(0);
      const written = store.write(edit(UUID, "Original", "Newer"), [9, "w"]);
      held.landAll();
      await expect(read).resolves.toEqual({ edit: backup, stamp: undefined });
      await written;
      await vi.advanceTimersByTimeAsync(0);
      expect(onDisk(UUID)).toEqual(body(edit(UUID, "Original", "Newer"), [9, "w"]));
    });

    it("doesn't restore the backup over a write still running", async () => {
      const backup = edit(UUID, "Original", "Backed up");
      fs.put(pathOf(UUID), "garbage");
      fs.put(pathOf(UUID, ".bak.json"), JSON.stringify(body(backup)));
      const store = files();
      const held = fs.holdWrites();
      const written = store.write(edit(UUID, "Original", "Newer"), [9, "w"]);
      const read = store.read(UUID);
      await vi.advanceTimersByTimeAsync(0);
      held.landAll();
      await Promise.all([read, written]);
      await vi.advanceTimersByTimeAsync(0);
      expect(onDisk(UUID)).toEqual(body(edit(UUID, "Original", "Newer"), [9, "w"]));
    });

    it("keeps one copy of a damaged file a session reads again, and says so once", async () => {
      fs.put(pathOf(UUID), "garbage");
      const store = files();
      await store.read(UUID);
      await vi.advanceTimersByTimeAsync(1000);
      await store.read(UUID);
      expect(keptAside(UUID)).toHaveLength(1);
      expect(recoveries).toHaveLength(1);
    });

    it("keeps only the newest 3 copies of a photo's damaged file", async () => {
      const { name } = fileOf(UUID);
      const copy = (day: number) => `${pathOf(UUID, "").slice(0, -name.length)}${name}.corrupt-2020-01-0${day}T00-00-00-000Z.json`;
      for (const day of [1, 2, 3, 4]) fs.put(copy(day), `old ${day}`);
      fs.put(pathOf("other-photo"), "x");
      fs.put(pathOf(UUID), "garbage");
      await files().read(UUID);
      const kept = keptAside(UUID);
      expect(kept).toHaveLength(3);
      expect(kept).toEqual(expect.arrayContaining([copy(3), copy(4)]));
      expect(kept.map((path) => fs.text(path))).toContain("garbage");
    });

    it("finds no edit for a damaged file without a usable backup, and says so", async () => {
      fs.put(pathOf(UUID), "garbage");
      await expect(files().read(UUID)).resolves.toBeUndefined();
      expect(keptAside(UUID)).toHaveLength(1);
      expect(recoveries).toEqual([{ photoId: UUID, from: "none", kept: expect.any(String) }]);

      fs.put(pathOf("p2"), "garbage");
      fs.put(pathOf("p2", ".bak.json"), "also garbage");
      await expect(files().read("p2")).resolves.toBeUndefined();
      expect(recoveries[1]).toMatchObject({ photoId: "p2", from: "none" });
    });

    it("keeps no copy of an empty file, a write that never landed", async () => {
      fs.put(pathOf(UUID), "");
      await expect(files().read(UUID)).resolves.toBeUndefined();
      expect(keptAside(UUID)).toEqual([]);
      expect(recoveries).toEqual([{ photoId: UUID, from: "none", kept: null }]);
    });

    it("rejects a damaged file it can't keep a copy of", async () => {
      fs.put(pathOf(UUID), "garbage");
      fs.failWrites(/\.corrupt-/, "ENOSPC");
      await expect(files().read(UUID)).rejects.toBeInstanceOf(EditDamagedError);
      expect(fs.text(pathOf(UUID))).toBe("garbage");
    });

    it("opens the snapshots of a file it can, keeping the file as it was aside once", async () => {
      const state = edit(UUID, "Original", "A");
      const stored = JSON.stringify({ ...body(state), stack: [state.stack[0], 1, state.stack[1]], currentIndex: 2 });
      fs.put(pathOf(UUID), stored);
      const store = files();
      await expect(store.read(UUID)).resolves.toEqual({ edit: state, stamp: undefined });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(store.read(UUID)).resolves.toEqual({ edit: state, stamp: undefined });
      const kept = keptAside(UUID);
      expect(kept.map((path) => fs.text(path))).toEqual([stored]);
      expect(recoveries).toEqual([{ photoId: UUID, from: "openable", kept: expect.any(String) }]);
    });
  });

  describe("write", () => {
    it("writes one file per photo, in its shard", async () => {
      const store = files();
      await store.write(edit("a", "Original"), [1, "w"]);
      await store.write(edit("b", "Original"), [1, "w"]);
      expect(fs.tree(`${cfg.slPath}/edits`)).toEqual([pathOf("a"), pathOf("b")].sort());
    });

    it("refuses, without trying again, to write over another photo's file", async () => {
      const theirs = JSON.stringify(body(edit("someone-else", "Original")));
      fs.put(pathOf(UUID), theirs);
      const store = files();
      const write = vi.spyOn(fs, "write");
      const written = store.write(edit(UUID, "Original", "Mine"), [1, "w"]);
      await expect(written).rejects.toBeInstanceOf(EditNameClashError);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(write).not.toHaveBeenCalled();
      expect(fs.text(pathOf(UUID))).toBe(theirs);
    });

    it("keeps one write per photo running, and of those waiting only the newest", async () => {
      const store = files();
      const write = vi.spyOn(fs, "write");
      const held = fs.holdWrites();
      const first = store.write(edit(UUID, "Original", "1"), [1, "w"]);
      await vi.advanceTimersByTimeAsync(0);
      const second = store.write(edit(UUID, "Original", "2"), [2, "w"]);
      const third = store.write(edit(UUID, "Original", "3"), [3, "w"]);
      held.landAll();
      await Promise.all([first, second, third]);
      expect(writtenText(write)).not.toContain('"label":"2"');
      expect(fs.mostConcurrentWrites(pathOf(UUID))).toBe(1);
      expect(onDisk(UUID)).toEqual(body(edit(UUID, "Original", "3"), [3, "w"]));
    });

    it("writes at most 8 photos at once", async () => {
      const store = files();
      const write = vi.spyOn(fs, "write");
      const held = fs.holdWrites();
      const ids = Array.from({ length: 12 }, (_, i) => `photo-${i}`);
      const writes = Promise.all(ids.map((id) => store.write(edit(id, "Original"), [1, "w"])));
      await vi.advanceTimersByTimeAsync(0);
      expect(photosWritten(write)).toBe(8);
      held.landAll();
      await writes;
      expect(photosWritten(write)).toBe(12);
      for (const id of ids) expect(onDisk(id)).toEqual(body(edit(id, "Original"), [1, "w"]));
    });

    it("tries a failing write again after 2, 5, 15, 30 and 60 seconds, then rejects", async () => {
      const store = files();
      const write = vi.spyOn(fs, "write");
      fs.failWrites(/\.json$/, "EBUSY");
      const settled = store.write(edit(UUID, "Original"), [1, "w"]).then(
        () => "resolved",
        (error: unknown) => error,
      );
      const tries: number[] = [];
      for (const wait of [2000, 5000, 15_000, 30_000, 60_000]) {
        await vi.advanceTimersByTimeAsync(wait - 1);
        tries.push(write.mock.calls.length);
        await vi.advanceTimersByTimeAsync(1);
        tries.push(write.mock.calls.length);
      }
      expect(tries).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 6]);
      expect(await settled).toBeInstanceOf(FsError);
    });

    it("lands a write once the file is let go", async () => {
      const store = files();
      fs.failWrites(/\.json$/, "EPERM", 2);
      const written = store.write(edit(UUID, "Original"), [1, "w"]);
      await vi.advanceTimersByTimeAsync(2000 + 5000);
      await expect(written).resolves.toBeUndefined();
      expect(onDisk(UUID)).toEqual(body(edit(UUID, "Original"), [1, "w"]));
    });

    it("writes the newer edit in place of a failed one it waited behind", async () => {
      const store = files();
      const write = vi.spyOn(fs, "write");
      fs.failWrites(/\.json$/, "EBUSY", 1);
      const older = store.write(edit(UUID, "Original", "old"), [1, "w"]);
      await vi.advanceTimersByTimeAsync(0);
      const newer = store.write(edit(UUID, "Original", "new"), [2, "w"]);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(Promise.all([older, newer])).resolves.toEqual([undefined, undefined]);
      expect(writtenText(write, 1)).not.toContain('"label":"old"');
      expect(onDisk(UUID)).toEqual(body(edit(UUID, "Original", "new"), [2, "w"]));
    });

    it("leaves other photos' writes running while one waits to try again", async () => {
      const store = files();
      fs.failWrites(new RegExp(`${fileOf("stuck").name}\\.json$`), "EBUSY");
      void store.write(edit("stuck", "Original"), [1, "w"]).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      await store.write(edit("free", "Original"), [1, "w"]);
      expect(onDisk("free")).toEqual(body(edit("free", "Original"), [1, "w"]));
    });
  });

  describe("backups", () => {
    it("keeps the file as the session found it before its first write", async () => {
      const before = edit(UUID, "Original", "Before");
      fs.put(pathOf(UUID), JSON.stringify(body(before, [1, "w0"])));
      const store = files({ keepBackups: true });
      await store.write(edit(UUID, "Original", "1"), [2, "w"]);
      await store.write(edit(UUID, "Original", "2"), [3, "w"]);
      expect(onDisk(UUID, ".bak.json")).toEqual(body(before, [1, "w0"]));
      expect(onDisk(UUID)).toEqual(body(edit(UUID, "Original", "2"), [3, "w"]));

      await files({ keepBackups: true }).write(edit(UUID, "Original", "3"), [4, "w"]);
      expect(onDisk(UUID, ".bak.json")).toEqual(body(edit(UUID, "Original", "2"), [3, "w"]));
    });

    it("keeps none for a photo without a file, nor for a pop-out's writes", async () => {
      await files({ keepBackups: true }).write(edit("new", "Original"), [1, "w"]);
      expect(onDisk("new", ".bak.json")).toBeNull();

      fs.put(pathOf(UUID), JSON.stringify(body(edit(UUID, "Original"))));
      await files().write(edit(UUID, "Original", "1"), [2, "w"]);
      expect(onDisk(UUID, ".bak.json")).toBeNull();
    });

    it("doesn't replace a backup with a damaged file", async () => {
      const good = edit(UUID, "Original", "Good");
      fs.put(pathOf(UUID), "garbage");
      fs.put(pathOf(UUID, ".bak.json"), JSON.stringify(body(good)));
      await files({ keepBackups: true }).write(edit(UUID, "Original", "1"), [2, "w"]);
      expect(onDisk(UUID, ".bak.json")).toEqual(body(good));
    });

    it("doesn't write the edit until the backup is kept", async () => {
      fs.put(pathOf(UUID), JSON.stringify(body(edit(UUID, "Original"))));
      fs.failWrites(/\.bak\.json$/, "EBUSY", 1);
      const written = files({ keepBackups: true }).write(edit(UUID, "Original", "1"), [2, "w"]);
      await vi.advanceTimersByTimeAsync(0);
      expect(onDisk(UUID)).toEqual(body(edit(UUID, "Original")));
      await vi.advanceTimersByTimeAsync(2000);
      await written;
      expect(onDisk(UUID, ".bak.json")).toEqual(body(edit(UUID, "Original")));
      expect(onDisk(UUID)).toEqual(body(edit(UUID, "Original", "1"), [2, "w"]));
    });
  });

  describe("remove", () => {
    it("removes a photo's file and its backup", async () => {
      fs.put(pathOf(UUID), JSON.stringify(body(edit(UUID, "Original"))));
      const store = files({ keepBackups: true });
      await store.write(edit(UUID, "Original", "1"), [2, "w"]);
      await store.remove(UUID);
      expect(onDisk(UUID)).toBeNull();
      expect(onDisk(UUID, ".bak.json")).toBeNull();
      await expect(store.read(UUID)).resolves.toBeUndefined();
    });

    it("refuses to remove another photo's file", async () => {
      const theirs = JSON.stringify(body(edit("someone-else", "Original")));
      fs.put(pathOf(UUID), theirs);
      await expect(files().remove(UUID)).rejects.toBeInstanceOf(EditNameClashError);
      expect(fs.text(pathOf(UUID))).toBe(theirs);
    });

    it("removes nothing, and fails nothing, for a photo without a file", async () => {
      await expect(files().remove(UUID)).resolves.toBeUndefined();
    });

    it("removes the file after a write still running lands, skipping one waiting", async () => {
      const store = files();
      const write = vi.spyOn(fs, "write");
      const held = fs.holdWrites();
      const running = store.write(edit(UUID, "Original", "1"), [1, "w"]);
      await vi.advanceTimersByTimeAsync(0);
      const waiting = store.write(edit(UUID, "Original", "2"), [2, "w"]);
      const removed = store.remove(UUID);
      held.landAll();
      await Promise.all([running, waiting, removed]);
      expect(writtenText(write)).not.toContain('"label":"2"');
      expect(onDisk(UUID)).toBeNull();
    });
  });
});
