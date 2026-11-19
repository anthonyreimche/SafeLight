// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// rotate, keywords and forget through main() with the real services, ProjectStorage
// and the Node shims, on a temp project and a temp userData.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshParams, type EditState, type StoredPhoto } from "@/catalog/types";
import { acquireLock, releaseLock } from "../../../electron/file-lock.cjs";
import { main, type MainIO } from "../main";
import { previewFileFor } from "../project";
import { forgetCommand } from "./forget";
import { keywordsCommand } from "./keywords";
import { rotateCommand } from "./rotate";

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
let userData: string;

const record = (id: string, relPath: string, over: Partial<StoredPhoto> = {}): StoredPhoto => ({
  id,
  filename: path.posix.basename(relPath),
  relPath,
  folder: path.posix.dirname(relPath) === "." ? "" : path.posix.dirname(relPath),
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
  ...over,
});

const editFor = (photoId: string): EditState => ({
  photoId,
  currentIndex: 1,
  stack: [
    { timestamp: 0, label: "Original", params: freshParams(5200), paramBag: {} },
    { timestamp: 1, label: "Exposure", params: { ...freshParams(5200), exposure: 1 }, paramBag: {} },
  ],
});

function seed(photos: StoredPhoto[], edits: EditState[] = []): void {
  fs.mkdirSync(path.join(project, "day1"), { recursive: true });
  for (const p of photos) if (!p.copyOf) fs.writeFileSync(path.join(project, p.relPath), "x");
  fs.mkdirSync(path.join(project, ".safelight"));
  fs.writeFileSync(
    path.join(project, ".safelight", "catalog.json"),
    JSON.stringify({ version: 2, id: "cat-1", photos, edits, removed: [] }),
  );
}

function sink() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return { stream: Object.assign(stream, { isTTY: false, columns: 100 }) as unknown as NodeJS.WriteStream, text: () => chunks.join("") };
}

async function slu(argv: string[], extra: Partial<MainIO> = {}): Promise<{ code: number; out: string; err: string }> {
  const stdout = sink();
  const stderr = sink();
  const io: MainIO = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
    env: { SLU_USER_DATA: userData, NO_COLOR: "1" },
    cwd: project,
    platform: process.platform,
    home: temp,
    moduleFile: path.join(temp, "safelight.mjs"),
    onInterrupt: () => () => {},
    commands: [rotateCommand, keywordsCommand, forgetCommand],
    ...extra,
  };
  const code = await main(argv, io);
  return { code, out: stdout.text(), err: stderr.text() };
}

const catalogOf = () =>
  JSON.parse(fs.readFileSync(path.join(project, ".safelight", "catalog.json"), "utf8")) as {
    photos: StoredPhoto[];
    edits: EditState[];
    removed: string[];
  };
const photoOf = (id: string) => catalogOf().photos.find((p) => p.id === id);

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "slu-organize-"));
  project = path.join(temp, "shoot");
  userData = path.join(temp, "userData");
  fs.mkdirSync(userData);
  vi.stubGlobal("BroadcastChannel", FakeChannel);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(temp, { recursive: true, force: true });
});

async function whileSafelightHolds<T>(body: () => Promise<T>): Promise<T> {
  const lockFile = path.join(project, ".safelight", "writer.lock");
  const held = await acquireLock(lockFile, "safelight");
  if (!held.ok) throw new Error("lock not taken");
  try {
    return await body();
  } finally {
    await releaseLock(lockFile, held.token);
  }
}

describe("rotate", () => {
  beforeEach(() => seed([record("a", "a.ARW"), record("b", "day1/b.ARW", { rotation: 270 })]));

  it("turns right, swaps width and height and reports the new rotation", async () => {
    const r = await slu(["rotate", "a.ARW", "right", "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      slu: 1,
      photos: [{ photo: "a.ARW", ok: true, changed: true, changes: [{ key: "rotation", before: 0, after: 90 }] }],
    });
    expect(photoOf("a")).toMatchObject({ rotation: 90, width: 4000, height: 6000 });
  });

  it("turns left from where the photo already is", async () => {
    await slu(["rotate", "day1/b.ARW", "left"]);
    expect(photoOf("b")).toMatchObject({ rotation: 180, width: 4000, height: 6000 });
  });

  it("turns 180 without swapping", async () => {
    await slu(["rotate", "a.ARW", "180"]);
    expect(photoOf("a")).toMatchObject({ rotation: 180, width: 6000, height: 4000 });
  });

  it("takes cw, ccw, 90 and 270 for the same turns", async () => {
    await slu(["rotate", "a.ARW", "cw"]);
    expect(photoOf("a")?.rotation).toBe(90);
    await slu(["rotate", "a.ARW", "ccw"]);
    expect(photoOf("a")?.rotation).toBe(0);
    await slu(["rotate", "a.ARW", "270"]);
    expect(photoOf("a")?.rotation).toBe(270);
    await slu(["rotate", "a.ARW", "90"]);
    expect(photoOf("a")?.rotation).toBe(0);
    expect((await slu(["rotate", "a.ARW", "-90"])).code).toBe(0);
    expect(photoOf("a")?.rotation).toBe(270);
  });

  it("refuses a turn it doesn't know, writing nothing", async () => {
    const r = await slu(["rotate", "a.ARW", "sideways"]);
    expect(r.code).toBe(1);
    expect(photoOf("a")?.rotation).toBe(0);
  });

  it("turns every photo named", async () => {
    const r = await slu(["rotate", "a.ARW", "day1/b.ARW", "right"]);
    expect(r.code).toBe(0);
    expect(photoOf("a")?.rotation).toBe(90);
    expect(photoOf("b")?.rotation).toBe(0);
  });

  it("leaves the stored preview unusable until the app rebuilds it", async () => {
    const working = path.join(project, ".safelight");
    fs.mkdirSync(path.join(working, "previews"));
    fs.writeFileSync(path.join(working, "previews", "a.jpg"), "jpeg");
    const catalog = catalogOf();
    catalog.photos[0] = { ...catalog.photos[0], previewRotation: 0 };
    fs.writeFileSync(path.join(working, "catalog.json"), JSON.stringify(catalog));

    await slu(["rotate", "a.ARW", "right"]);
    const turned = photoOf("a");
    expect(turned).toBeDefined();
    expect(previewFileFor(working, turned as StoredPhoto)).toBeNull();
  });

  it("is refused with exit 4 while Safelight has the project, and writes nothing", async () => {
    await whileSafelightHolds(async () => {
      const before = fs.readFileSync(path.join(project, ".safelight", "catalog.json"), "utf8");
      const r = await slu(["rotate", "a.ARW", "right", "--json"]);
      expect(r.code).toBe(4);
      expect(JSON.parse(r.out)).toMatchObject({ slu: 1, ok: false, error: { code: 4 } });
      expect(fs.readFileSync(path.join(project, ".safelight", "catalog.json"), "utf8")).toBe(before);
    });
  });
});

describe("keywords", () => {
  beforeEach(() => seed([record("a", "a.ARW", { keywords: ["iceland", "draft"] }), record("b", "day1/b.ARW", { keywords: ["iceland"] })]));

  it("lists each photo's keywords, then the project's with counts when several are named", async () => {
    const r = await slu(["keywords", "a.ARW", "day1/b.ARW"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("a.ARW\ticeland, draft\nday1/b.ARW\ticeland\n\niceland\t2\ndraft\t1\n");
  });

  it("lists one photo's keywords alone", async () => {
    expect((await slu(["keywords", "a.ARW"])).out).toBe("a.ARW\ticeland, draft\n");
  });

  it("lists as JSON with the project's counts", async () => {
    const r = await slu(["keywords", "a.ARW", "day1/b.ARW", "--json"]);
    expect(JSON.parse(r.out)).toEqual({
      slu: 1,
      photos: [
        { photo: "a.ARW", ok: true, keywords: ["iceland", "draft"] },
        { photo: "day1/b.ARW", ok: true, keywords: ["iceland"] },
      ],
      keywords: [{ keyword: "iceland", count: 2 }, { keyword: "draft", count: 1 }],
    });
  });

  it("adds in order, once, and a second run changes nothing", async () => {
    const first = await slu(["keywords", "a.ARW", "--add", "black sand", "--add", "iceland,coast", "--json"]);
    expect(first.code).toBe(0);
    expect(photoOf("a")?.keywords).toEqual(["iceland", "draft", "black sand", "coast"]);
    expect(JSON.parse(first.out)).toEqual({
      slu: 1,
      photos: [{
        photo: "a.ARW", ok: true, changed: true,
        keywords: ["iceland", "draft", "black sand", "coast"], added: ["black sand", "coast"], removed: [],
        changes: [{ key: "keywords", before: ["iceland", "draft"], after: ["iceland", "draft", "black sand", "coast"] }],
      }],
    });
    const again = await slu(["keywords", "a.ARW", "--add", "black sand", "--json"]);
    expect(JSON.parse(again.out).photos[0]).toMatchObject({ changed: false, added: [], removed: [] });
    expect(photoOf("a")?.keywords).toEqual(["iceland", "draft", "black sand", "coast"]);
  });

  it("removes, keeps the rest in order, and ignores a keyword the photo lacks", async () => {
    const r = await slu(["keywords", "a.ARW", "day1/b.ARW", "--remove", "draft,missing", "--json"]);
    expect(r.code).toBe(0);
    expect(photoOf("a")?.keywords).toEqual(["iceland"]);
    expect(photoOf("b")?.keywords).toEqual(["iceland"]);
    const docs = JSON.parse(r.out).photos;
    expect(docs[0]).toMatchObject({ changed: true, removed: ["draft"] });
    expect(docs[1]).toMatchObject({ changed: false, removed: [] });
  });

  it("does the removals before the additions in one run", async () => {
    await slu(["keywords", "a.ARW", "--remove", "draft", "--add", "draft"]);
    expect(photoOf("a")?.keywords).toEqual(["iceland", "draft"]);
  });

  it("never takes a misspelt file name for a keyword", async () => {
    const r = await slu(["keywords", "nope.ARW", "--add", "x"]);
    expect(r.code).toBe(2);
    expect(photoOf("a")?.keywords).toEqual(["iceland", "draft"]);
  });

  it("is refused with exit 4 while Safelight has the project, but still lists", async () => {
    await whileSafelightHolds(async () => {
      const add = await slu(["keywords", "a.ARW", "--add", "x", "--json"]);
      expect(add.code).toBe(4);
      expect(photoOf("a")?.keywords).toEqual(["iceland", "draft"]);
      expect((await slu(["keywords", "a.ARW"])).code).toBe(0);
    });
  });
});

describe("forget", () => {
  beforeEach(() =>
    seed(
      [
        record("a", "a.ARW"),
        record("b", "day1/b.ARW"),
        record("v", "day1/b.ARW", { copyOf: "b", copyName: "Copy" }),
      ],
      [editFor("b")],
    ),
  );

  it("removes an unedited photo without asking, leaves its file and tombstones it", async () => {
    const r = await slu(["forget", "a.ARW", "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      slu: 1,
      photos: [{ photo: "a.ARW", ok: true, changed: true, changes: [], removed: true }],
    });
    const catalog = catalogOf();
    expect(catalog.photos.map((p) => p.id)).not.toContain("a");
    expect(catalog.removed).toContain("a.ARW");
    expect(fs.existsSync(path.join(project, "a.ARW"))).toBe(true);
  });

  it("refuses a photo with edits without --yes, exit 1, changing nothing", async () => {
    const before = fs.readFileSync(path.join(project, ".safelight", "catalog.json"), "utf8");
    const r = await slu(["forget", "a.ARW", "day1/b.ARW"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe("safelight: 1 of these 2 have edits that would be lost.\n           Add --yes to remove them anyway.\n");
    expect(fs.readFileSync(path.join(project, ".safelight", "catalog.json"), "utf8")).toBe(before);
  });

  it("gives the prompt the line that goes ahead as its fix", async () => {
    const problems: unknown[] = [];
    await slu(["forget", "a.ARW", "day1/b.ARW", "-r"], { onProblem: (p) => problems.push(p) });
    expect(problems).toEqual([expect.objectContaining({ fix: "safelight forget a.ARW day1/b.ARW --recursive --yes" })]);
  });

  it("asks at the prompt under the card, and goes ahead on yes", async () => {
    const asked: string[] = [];
    const r = await slu(["forget", "day1/b.ARW"], { ask: async (q) => { asked.push(q); return "y"; } });
    expect(r.code).toBe(0);
    expect(asked).toEqual(["Forget it? [y/N] "]);
    expect(catalogOf().photos.map((p) => p.id)).toEqual(["a"]);
  });

  it("changes nothing when the answer at the prompt is no", async () => {
    const before = fs.readFileSync(path.join(project, ".safelight", "catalog.json"), "utf8");
    const r = await slu(["forget", "a.ARW", "day1/b.ARW"], { ask: async () => "" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Nothing was removed.");
    expect(fs.readFileSync(path.join(project, ".safelight", "catalog.json"), "utf8")).toBe(before);
  });

  it("takes a photo with edits and its virtual copies with --yes", async () => {
    const r = await slu(["forget", "day1/b.ARW", "--yes"]);
    expect(r.code).toBe(0);
    const catalog = catalogOf();
    expect(catalog.photos.map((p) => p.id)).toEqual(["a"]);
    expect(catalog.edits.map((e) => e.photoId)).toEqual([]);
    expect(catalog.removed).toContain("day1/b.ARW");
    expect(fs.existsSync(path.join(project, "day1", "b.ARW"))).toBe(true);
  });

  it("counts a master's virtual copies' edits when deciding whether to ask", async () => {
    seedAgain([record("m", "m.ARW"), record("c", "m.ARW", { copyOf: "m" })], [editFor("c")]);
    const r = await slu(["forget", "m.ARW"]);
    expect(r.code).toBe(1);
    expect(catalogOf().photos).toHaveLength(2);
  });

  it("is refused with exit 4 while Safelight has the project, and writes nothing", async () => {
    await whileSafelightHolds(async () => {
      const before = fs.readFileSync(path.join(project, ".safelight", "catalog.json"), "utf8");
      const r = await slu(["forget", "a.ARW", "--json"]);
      expect(r.code).toBe(4);
      expect(fs.readFileSync(path.join(project, ".safelight", "catalog.json"), "utf8")).toBe(before);
    });
  });
});

function seedAgain(photos: StoredPhoto[], edits: EditState[]): void {
  fs.rmSync(path.join(project, ".safelight"), { recursive: true, force: true });
  seed(photos, edits);
}
