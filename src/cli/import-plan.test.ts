import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyIn, dryRun, heldLock, planImport, type PlanInput } from "./import-plan";
import type { ProjectRef } from "./types";

let base: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "slu-import-plan-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function touch(rel: string, text = rel): string {
  const file = path.join(base, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function catalogue(rel: string, doc: unknown = { version: 1, photos: [], edits: [] }): void {
  touch(path.join(rel, ".safelight", "catalog.json"), JSON.stringify(doc));
}

/** The nearest folder up from `abs` holding .safelight/catalog.json, as ProjectService.find. */
async function find(abs: string): Promise<ProjectRef | null> {
  let dir = abs;
  for (;;) {
    if (existsSync(path.join(dir, ".safelight", "catalog.json"))) return { root: dir, workingDir: path.join(dir, ".safelight"), location: "in-folder" };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function input(over: Partial<PlanInput> = {}): PlanInput {
  return { cwd: base, platform: process.platform, specs: [], recursive: false, copy: false, into: null, project: null, ...over };
}

describe("planImport: scope", () => {
  beforeEach(() => catalogue("."));

  it("takes the whole project when nothing is named", async () => {
    const plan = await planImport(input({ cwd: path.join(base, "Day2") }), find);
    expect(plan.root).toBe(base);
    expect(plan.existing?.root).toBe(base);
    expect(plan.scope).toEqual({ kind: "all" });
  });

  it("takes a folder's own photos, and its subfolders with -r", async () => {
    touch("Day2/a.jpg");
    expect((await planImport(input({ specs: ["Day2"] }), find)).scope).toEqual({ kind: "some", files: [], folders: [{ relPath: "Day2", recursive: false }] });
    expect((await planImport(input({ specs: ["Day2/"], recursive: true }), find)).scope).toEqual({ kind: "some", files: [], folders: [{ relPath: "Day2", recursive: true }] });
  });

  it("takes named files and glob matches, as paths from the root", async () => {
    touch("Day2/a.NEF");
    touch("Day2/b.jpg");
    touch("Day2/notes.txt");
    const plan = await planImport(input({ cwd: path.join(base, "Day2"), specs: ["a.NEF", "*.jpg"] }), find);
    expect(plan.scope).toEqual({ kind: "some", files: ["Day2/a.NEF", "Day2/b.jpg"], folders: [] });
    expect(plan.refused).toEqual([]);
  });

  it("refuses, one by one, what isn't there and what isn't a photo", async () => {
    touch("notes.txt");
    touch("a.jpg");
    const plan = await planImport(input({ specs: ["a.jpg", "gone.jpg", "notes.txt", "*.png"] }), find);
    expect(plan.scope).toEqual({ kind: "some", files: ["a.jpg"], folders: [] });
    expect(plan.refused.map((r) => r.spec)).toEqual(["gone.jpg", "notes.txt", "*.png"]);
  });

  it("refuses a file outside the project with exit 2 and the --copy fix", async () => {
    mkdirSync(path.join(base, "p"));
    catalogue("p");
    touch("elsewhere/IMG_1.ARW");
    const error = await planImport(input({ cwd: path.join(base, "p"), specs: ["../elsewhere/IMG_1.ARW"] }), find).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 2, hint: expect.stringContaining("import --copy ../elsewhere/IMG_1.ARW") });
  });
});

describe("planImport: starting a catalogue", () => {
  it("starts one in the current folder when it holds every file named", async () => {
    touch("a.jpg");
    const plan = await planImport(input({ specs: ["a.jpg"] }), find);
    expect(plan.existing).toBeNull();
    expect(plan.root).toBe(base);
  });

  it("starts one where --project says", async () => {
    touch("shoot/a.jpg");
    const plan = await planImport(input({ project: "shoot" }), find);
    expect(plan.root).toBe(path.join(base, "shoot"));
    expect(plan.existing).toBeNull();
    expect(plan.scope).toEqual({ kind: "all" });
  });

  it("asks for --project when the files are outside the current folder", async () => {
    touch("other/a.jpg");
    mkdirSync(path.join(base, "here"));
    const error = await planImport(input({ cwd: path.join(base, "here"), specs: ["../other/a.jpg"] }), find).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 2, message: "Name the project folder with --project." });
  });

  it("never starts one at a drive root", async () => {
    const root = path.parse(base).root;
    const error = await planImport(input({ cwd: root }), async () => null).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 2, message: expect.stringContaining("is a whole drive") });
  });

  it("warns about a subfolder with a catalogue of its own", async () => {
    touch("a.jpg");
    catalogue("Day 3");
    const plan = await planImport(input(), find);
    expect(plan.existing).toBeNull();
    expect(plan.nested).toEqual(["Day 3"]);
  });
});

describe("planImport: --copy", () => {
  beforeEach(() => {
    mkdirSync(path.join(base, "p"));
    catalogue("p");
  });
  const inP = (over: Partial<PlanInput>) => input({ cwd: path.join(base, "p"), ...over });

  it("is usage error 1 without files, and --into is one without --copy", async () => {
    await expect(planImport(inP({ copy: true }), find)).rejects.toMatchObject({ code: 1 });
    await expect(planImport(inP({ into: "Day2", specs: ["a.jpg"] }), find)).rejects.toMatchObject({ code: 1 });
  });

  it("copies outside files to the root, or --into a folder of it", async () => {
    const from = touch("card/IMG_1.ARW");
    const plan = await planImport(inP({ copy: true, specs: ["../card/IMG_1.ARW"] }), find);
    expect(plan.copies).toEqual([{ from, to: path.join(base, "p", "IMG_1.ARW"), relPath: "IMG_1.ARW" }]);
    const into = await planImport(inP({ copy: true, into: "Day2", specs: ["../card/IMG_1.ARW"] }), find);
    expect(into.copies[0]).toMatchObject({ to: path.join(base, "p", "Day2", "IMG_1.ARW"), relPath: "Day2/IMG_1.ARW" });
  });

  it("refuses a name already taken, a name the project can't keep, and a folder", async () => {
    touch("card/IMG_1.ARW");
    touch("p/IMG_1.ARW");
    touch("card/.hidden.jpg");
    mkdirSync(path.join(base, "card", "sub"));
    const plan = await planImport(inP({ copy: true, specs: ["../card/IMG_1.ARW", "../card/.hidden.jpg", "../card/sub"] }), find);
    expect(plan.copies).toEqual([]);
    expect(plan.refused.map((r) => r.spec)).toEqual(["../card/IMG_1.ARW", "../card/.hidden.jpg", "../card/sub"]);
  });

  it("refuses an --into outside the project", async () => {
    touch("card/IMG_1.ARW");
    await expect(planImport(inP({ copy: true, into: "../card", specs: ["../card/IMG_1.ARW"] }), find)).rejects.toMatchObject({ code: 2 });
  });
});

describe("copyIn", () => {
  it("copies the file and its sidecar, leaving no temporary file", async () => {
    const from = touch("card/IMG_1.ARW", "raw bytes");
    touch("card/IMG_1.ARW.safelight.json", "{\"rating\":3}");
    mkdirSync(path.join(base, "p"));
    const to = path.join(base, "p", "Day2", "IMG_1.ARW");
    await copyIn({ from, to, relPath: "Day2/IMG_1.ARW" });
    expect(readFileSync(to, "utf8")).toBe("raw bytes");
    expect(readFileSync(`${to}.safelight.json`, "utf8")).toBe("{\"rating\":3}");
    expect(readdirSync(path.dirname(to)).sort()).toEqual(["IMG_1.ARW", "IMG_1.ARW.safelight.json"]);
    expect(existsSync(from)).toBe(true);
  });

  it("never overwrites a file that appeared since the plan", async () => {
    const from = touch("card/IMG_1.ARW", "new");
    const to = touch("p/IMG_1.ARW", "already here");
    await expect(copyIn({ from, to, relPath: "IMG_1.ARW" })).rejects.toThrow(/already/);
    expect(readFileSync(to, "utf8")).toBe("already here");
    expect(readdirSync(path.dirname(to))).toEqual(["IMG_1.ARW"]);
  });
});

describe("dryRun", () => {
  it("counts new photos in scope, records whose file is gone, and other files", async () => {
    touch("a.jpg");
    touch("b.jpg");
    touch("removed.jpg");
    touch("Day2/c.NEF");
    touch("notes.txt");
    touch("a.jpg.safelight.json");
    catalogue(".", { version: 1, photos: [{ id: "1", relPath: "a.jpg" }, { id: "2", relPath: "old.jpg" }], edits: [], removed: ["removed.jpg"] });
    const plan = await planImport(input(), find);
    const report = await dryRun(plan, process.platform);
    expect(report.new).toEqual([path.join(base, "Day2", "c.NEF"), path.join(base, "b.jpg")]);
    expect(report.gone).toEqual(["old.jpg"]);
    expect(report.otherFiles).toBe(1);
  });

  it("counts a removed photo that is named as new again", async () => {
    touch("removed.jpg");
    catalogue(".", { version: 1, photos: [], edits: [], removed: ["removed.jpg"] });
    const report = await dryRun(await planImport(input({ specs: ["removed.jpg"] }), find), process.platform);
    expect(report.new).toEqual([path.join(base, "removed.jpg")]);
  });
});

describe("heldLock", () => {
  const lock = (doc: object) => touch(".safelight/writer.lock", JSON.stringify(doc));
  const now = Date.now();

  it("is null with no lock", async () => {
    expect(await heldLock(path.join(base, ".safelight"))).toBeNull();
  });

  it("names a live holder", async () => {
    lock({ app: "safelight", pid: process.pid, host: hostname(), since: now, refreshedAt: now, token: "t" });
    expect(await heldLock(path.join(base, ".safelight"))).toMatchObject({ app: "safelight" });
  });

  it("lets a stale lock, or one whose holder here has exited, go", async () => {
    lock({ app: "safelight", pid: process.pid, host: hostname(), since: 0, refreshedAt: now - 60 * 60_000, token: "t" });
    expect(await heldLock(path.join(base, ".safelight"))).toBeNull();
    lock({ app: "slu", pid: 2 ** 22 + 12345, host: hostname(), since: now, refreshedAt: now, token: "t" });
    expect(await heldLock(path.join(base, ".safelight"))).toBeNull();
  });
});
