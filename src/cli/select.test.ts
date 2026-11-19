import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import { parseArgs } from "./args";
import { applyWorkingSet, buildSelectRequest, createPhotoSelector, isEdited, missingError, parseRating, stdinPhotoPaths } from "./select";
import {
  CliError,
  type CliEnv,
  type PhotoFilters,
  type ProjectRef,
  type ProjectService,
  type SelectRequest,
  type WorkingSet,
  type WriteSession,
} from "./types";

function photo(relPath: string, extra: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
    id: relPath,
    filename: relPath.split("/").pop(),
    relPath,
    folder: relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "",
    rating: 0,
    flag: "none",
    colorLabel: "none",
    ...extra,
  } as unknown as CatalogPhoto;
}

interface FakeProject { root: string; photos: CatalogPhoto[]; edits?: Record<string, EditState> }

const isOutside = (rel: string): boolean => rel === ".." || rel.startsWith(`..${sep}`);

function fakeProjects(projects: FakeProject[]) {
  const closed: string[] = [];
  const opened: { root: string; mode: "read" | "write" }[] = [];
  const refOf = (p: FakeProject): ProjectRef => ({ root: p.root, workingDir: join(p.root, ".safelight"), location: "in-folder" });
  const session = (p: FakeProject) => ({
    project: refOf(p),
    photos: () => p.photos,
    photoByRelPath: (r: string) => p.photos.find((x) => x.relPath === r),
    previewFile: () => null,
    edit: async (id: string) => p.edits?.[id],
    putEdits: async () => {},
    putPhotos: async () => {},
    removePhotos: async () => {},
    close: async () => { closed.push(p.root); },
  });
  const service: ProjectService = {
    async find(abs) {
      const owner = projects
        .filter((p) => !isOutside(relative(p.root, abs)) && relative(p.root, abs) !== abs)
        .sort((a, b) => b.root.length - a.root.length)[0];
      return owner ? refOf(owner) : null;
    },
    async openRead(ref) {
      opened.push({ root: ref.root, mode: "read" });
      return session(projects.find((p) => p.root === ref.root)!);
    },
    async openWrite(ref) {
      opened.push({ root: ref.root, mode: "write" });
      return session(projects.find((p) => p.root === ref.root)!) as WriteSession;
    },
  };
  return { service, closed, opened };
}

const request = (over: Partial<SelectRequest> = {}): SelectRequest => ({
  specs: [], recursive: false, all: false, projectOverride: null, filters: {}, stdinPaths: [], ...over,
});

describe("photo selection", () => {
  let dir: string;
  let env: CliEnv;
  const rels = (g: { photos: CatalogPhoto[] }) => g.photos.map((p) => p.relPath);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "slu-select-"));
    for (const f of ["shoot/a.ARW", "shoot/b.arw", "shoot/day1/c.ARW", "other/z.RAF", "loose/q.ARW"]) {
      await mkdir(join(dir, f, ".."), { recursive: true });
      await writeFile(join(dir, f), "x");
    }
    env = { cwd: join(dir, "shoot"), userData: dir, appRoot: dir, electronBinary: null, appVersion: "0", platform: "linux", isTTY: { stdin: false, stdout: false, stderr: false }, env: {} };
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const shoot = (extra: Partial<FakeProject> = {}): FakeProject => ({
    root: join(dir, "shoot"),
    photos: [photo("a.ARW", { rating: 3, flag: "pick" }), photo("b.arw", { rating: 5, colorLabel: "red" }), photo("day1/c.ARW", { rating: 1 })],
    ...extra,
  });
  const other = (): FakeProject => ({ root: join(dir, "other"), photos: [photo("z.RAF")] });

  it("treats a folder named ..foo inside the project as inside it", async () => {
    await mkdir(join(dir, "shoot", "..foo"));
    await writeFile(join(dir, "shoot", "..foo", "d.ARW"), "x");
    const { service } = fakeProjects([shoot({ photos: [photo("..foo/d.ARW")] })]);
    for (const spec of ["..foo/d.ARW", "..foo"]) {
      const sel = await createPhotoSelector(service, env).read(request({ specs: [spec] }));
      expect(sel.missing).toEqual([]);
      expect(sel.groups.map(rels)).toEqual([["..foo/d.ARW"]]);
    }
  });

  it("selects a file", async () => {
    const { service } = fakeProjects([shoot()]);
    const sel = await createPhotoSelector(service, env).read(request({ specs: ["a.ARW"] }));
    expect(sel.groups.map(rels)).toEqual([["a.ARW"]]);
    expect(sel.missing).toEqual([]);
    await sel.close();
  });

  it("expands globs itself, without regard to case on Windows and macOS", async () => {
    const { service } = fakeProjects([shoot()]);
    const sel = await createPhotoSelector(service, env).read(request({ specs: ["*.ARW"] }));
    expect(sel.groups.map(rels)).toEqual([["a.ARW"]]);
    const win = await createPhotoSelector(service, { ...env, platform: "win32" }).read(request({ specs: ["*.ARW"] }));
    expect(win.groups.map(rels)).toEqual([["a.ARW", "b.arw"]]);
    const deep = await createPhotoSelector(service, { ...env, platform: "win32" }).read(request({ specs: ["**/*.arw"] }));
    expect(deep.groups.map(rels)).toEqual([["a.ARW", "b.arw", "day1/c.ARW"]]);
  });

  it("takes a folder's own photos, and its subfolders with recursive", async () => {
    const { service } = fakeProjects([shoot()]);
    const flat = await createPhotoSelector(service, env).read(request({ specs: ["."] }));
    expect(flat.groups.map(rels)).toEqual([["a.ARW", "b.arw"]]);
    const deep = await createPhotoSelector(service, env).read(request({ specs: ["."], recursive: true }));
    expect(deep.groups.map(rels)).toEqual([["a.ARW", "b.arw", "day1/c.ARW"]]);
    const sub = await createPhotoSelector(service, env).read(request({ specs: ["day1"] }));
    expect(sub.groups.map(rels)).toEqual([["day1/c.ARW"]]);
  });

  it("uses the current folder when nothing is named, and every photo with --all", async () => {
    const { service } = fakeProjects([shoot()]);
    const here = await createPhotoSelector(service, { ...env, cwd: join(dir, "shoot", "day1") }).read(request());
    expect(here.groups.map(rels)).toEqual([["day1/c.ARW"]]);
    const all = await createPhotoSelector(service, { ...env, cwd: join(dir, "shoot", "day1") }).read(request({ all: true }));
    expect(all.groups.map(rels)).toEqual([["a.ARW", "b.arw", "day1/c.ARW"]]);
  });

  it("filters by rating, flag, label and edited", async () => {
    const edit = { photoId: "a.ARW", stack: [{}, {}], currentIndex: 1 } as unknown as EditState;
    const { service } = fakeProjects([shoot({ edits: { "a.ARW": edit } })]);
    const run = async (filters: PhotoFilters) =>
      (await createPhotoSelector(service, env).read(request({ all: true, filters }))).groups.flatMap(rels);
    expect(await run({ rating: { min: 3, max: 5 } })).toEqual(["a.ARW", "b.arw"]);
    expect(await run({ rating: { min: 5, max: 5 } })).toEqual(["b.arw"]);
    expect(await run({ flag: "pick" })).toEqual(["a.ARW"]);
    expect(await run({ label: "red" })).toEqual(["b.arw"]);
    expect(await run({ edited: true })).toEqual(["a.ARW"]);
    expect(await run({ edited: false })).toEqual(["b.arw", "day1/c.ARW"]);
  });

  it("gives one group per project, each session opened once", async () => {
    const { service, opened } = fakeProjects([shoot(), other()]);
    const sel = await createPhotoSelector(service, env).read(request({ specs: ["a.ARW", "b.arw", "../other/z.RAF", "day1/c.ARW"] }));
    expect(sel.groups.map(rels)).toEqual([["a.ARW", "b.arw", "day1/c.ARW"], ["z.RAF"]]);
    expect(opened).toHaveLength(2);
  });

  it("reports what isn't found, outside a catalogue, or matches nothing", async () => {
    const { service } = fakeProjects([shoot()]);
    const sel = await createPhotoSelector(service, env).read(
      request({ specs: ["nope.ARW", "../loose/q.ARW", "*.xyz", "../loose", "a.ARW"], filters: {} }),
    );
    expect(sel.missing).toEqual([
      { spec: "nope.ARW", reason: "not-found" },
      { spec: "../loose/q.ARW", reason: "not-in-catalogue" },
      { spec: "*.xyz", reason: "no-match" },
      { spec: "../loose", reason: "not-in-catalogue" },
    ]);
    expect(sel.groups.map(rels)).toEqual([["a.ARW"]]);
  });

  it("reports a file on disk the catalogue doesn't hold, in write mode too, and creates nothing", async () => {
    await writeFile(join(dir, "shoot", "new.ARW"), "x");
    const { service, opened } = fakeProjects([shoot()]);
    const sel = await createPhotoSelector(service, env).write(request({ specs: ["new.ARW"] }), null);
    expect(sel.groups).toEqual([]);
    expect(sel.missing).toEqual([{ spec: "new.ARW", reason: "not-in-catalogue" }]);
    expect(opened.every((o) => o.mode === "write")).toBe(true);
  });

  it("reports a glob that matched only uncatalogued files, and none of the others", async () => {
    const { service } = fakeProjects([shoot()]);
    const sel = await createPhotoSelector(service, { ...env, cwd: join(dir, "loose") }).read(request({ specs: ["*.ARW"] }));
    expect(sel.missing).toEqual([{ spec: "*.ARW", reason: "not-in-catalogue" }]);
    await writeFile(join(dir, "shoot", "extra.ARW"), "x");
    const some = await createPhotoSelector(service, env).read(request({ specs: ["*.ARW"] }));
    expect(some.groups.map(rels)).toEqual([["a.ARW"]]);
    expect(some.missing).toEqual([]);
  });

  it("closes a session that selects nothing, and every session on close()", async () => {
    const { service, closed } = fakeProjects([shoot(), other()]);
    const sel = await createPhotoSelector(service, env).read(request({ specs: ["a.ARW", "../other/z.RAF"], filters: { flag: "pick" } }));
    expect(closed).toEqual([join(dir, "other")]);
    await sel.close();
    expect(closed).toContain(join(dir, "shoot"));
  });

  it("closes opened sessions when a later open fails", async () => {
    const { service, closed } = fakeProjects([shoot(), other()]);
    const failing: ProjectService = {
      ...service,
      openRead: async (ref) => {
        if (ref.root === join(dir, "other")) throw new CliError(4, "busy");
        return service.openRead(ref);
      },
    };
    await expect(createPhotoSelector(failing, env).read(request({ specs: ["a.ARW", "../other/z.RAF"] }))).rejects.toMatchObject({ code: 4 });
    expect(closed).toEqual([join(dir, "shoot")]);
  });

  it("takes stdin paths as photos", async () => {
    const { service } = fakeProjects([shoot()]);
    const sel = await createPhotoSelector(service, env).read(request({ stdinPaths: [resolve(dir, "shoot", "b.arw")] }));
    expect(sel.groups.map(rels)).toEqual([["b.arw"]]);
  });

  it("matches relPath without regard to case on Windows and macOS", async () => {
    const { service } = fakeProjects([shoot()]);
    const sel = await createPhotoSelector(service, { ...env, platform: "darwin" }).read(request({ specs: ["B.ARW"] }));
    if (process.platform === "linux") return; // the temp tree has no B.ARW to stat on a case-sensitive disk
    expect(sel.groups.map(rels)).toEqual([["b.arw"]]);
  });

  it("uses --project in place of the photo's own project", async () => {
    const { service } = fakeProjects([shoot(), other()]);
    const sel = await createPhotoSelector(service, env).read(request({ projectOverride: join(dir, "other"), all: true }));
    expect(sel.groups.map(rels)).toEqual([["z.RAF"]]);
    const away = await createPhotoSelector(service, env).read(request({ projectOverride: join(dir, "other"), specs: ["a.ARW"] }));
    expect(away.missing).toEqual([{ spec: "a.ARW", reason: "not-in-catalogue" }]);
  });

  it("keeps a name containing = as a photo after --", async () => {
    await writeFile(join(dir, "shoot", "a=b.ARW"), "x");
    const { service } = fakeProjects([{ ...shoot(), photos: [photo("a=b.ARW")] }]);
    const args = parseArgs(["photos", "--", "a=b.ARW"], null);
    const sel = await createPhotoSelector(service, env).read(buildSelectRequest(args, args.positionals, []));
    expect(sel.groups.map(rels)).toEqual([["a=b.ARW"]]);
  });

  it("selects a virtual copy's master for its file, and every record for a folder", async () => {
    const photos = [photo("a.ARW", { id: "m" }), photo("a.ARW", { id: "c", copyOf: "m" })];
    const { service } = fakeProjects([{ root: join(dir, "shoot"), photos }]);
    const file = await createPhotoSelector(service, env).read(request({ specs: ["a.ARW"] }));
    expect(file.groups[0].photos.map((p) => p.id)).toEqual(["m"]);
    const folder = await createPhotoSelector(service, env).read(request({ specs: ["."] }));
    expect(folder.groups[0].photos.map((p) => p.id)).toEqual(["m", "c"]);
  });
});

describe("request building", () => {
  it("reads rating forms", () => {
    expect(parseRating("3")).toEqual({ min: 3, max: 3 });
    expect(parseRating("3+")).toEqual({ min: 3, max: 5 });
    expect(parseRating("2-4")).toEqual({ min: 2, max: 4 });
    expect(() => parseRating("4-2")).toThrow(CliError);
    expect(() => parseRating("9")).toThrow(CliError);
  });

  it("builds a request from the parsed options", () => {
    const args = parseArgs(["photos", "a.ARW", "-r", "--rating", "3+", "--flag", "pick", "--label", "red", "--unedited", "--project", "p", "--", "x=y"], null);
    expect(buildSelectRequest(args, args.positionals, ["s.ARW"])).toEqual({
      specs: ["a.ARW", "x=y"],
      recursive: true,
      all: false,
      projectOverride: "p",
      filters: { rating: { min: 3, max: 5 }, flag: "pick", label: "red", edited: false },
      stdinPaths: ["s.ARW"],
    });
  });

  it("refuses an unknown flag or label and both edited options", () => {
    const bad = (argv: string[]) => () => {
      const args = parseArgs(argv, null);
      buildSelectRequest(args, [], []);
    };
    expect(bad(["photos", "--flag", "star"])).toThrow(CliError);
    expect(bad(["photos", "--label", "pink"])).toThrow(CliError);
    expect(bad(["photos", "--edited", "--unedited"])).toThrow(CliError);
  });

  describe("the working set", () => {
    const working: WorkingSet = { paths: ["/p/a.ARW", "/p/b.ARW", "/p/c.ARW"], index: 1, root: "/p" };
    const base = (over: Partial<SelectRequest> = {}): SelectRequest => ({
      specs: [], recursive: false, all: false, projectOverride: null, filters: {}, stdinPaths: [], ...over,
    });

    it("takes @ as the current photo and @all as every open one", () => {
      expect(applyWorkingSet(base({ specs: ["@"] }), working).specs).toEqual(["/p/b.ARW"]);
      expect(applyWorkingSet(base({ specs: ["@all"] }), working).specs).toEqual(working.paths);
      expect(applyWorkingSet(base({ specs: ["x.ARW", "@"] }), working).specs).toEqual(["x.ARW", "/p/b.ARW"]);
    });

    it("gives the current photo when nothing is named", () => {
      expect(applyWorkingSet(base(), working).specs).toEqual(["/p/b.ARW"]);
      expect(applyWorkingSet(base({ filters: { flag: "pick" } }), working).specs).toEqual(["/p/b.ARW"]);
    });

    it("leaves a request alone that names photos, reads stdin, or says --all", () => {
      expect(applyWorkingSet(base({ specs: ["x.ARW"] }), working).specs).toEqual(["x.ARW"]);
      expect(applyWorkingSet(base({ stdinPaths: ["s.ARW"] }), working).specs).toEqual([]);
      expect(applyWorkingSet(base({ all: true }), working).specs).toEqual([]);
    });

    it("changes nothing with no set open, except that @ has no photo to mean", () => {
      const plain = base({ specs: ["a.ARW"] });
      expect(applyWorkingSet(plain, undefined)).toBe(plain);
      expect(applyWorkingSet(base(), undefined).specs).toEqual([]);
      expect(() => applyWorkingSet(base({ specs: ["@"] }), undefined)).toThrow(CliError);
      expect(() => applyWorkingSet(base({ specs: ["@all"] }), { paths: [], index: 0, root: "/p" })).toThrow(CliError);
    });

    it("leaves @ alone in the request the photos and ls verbs build", () => {
      const args = parseArgs(["photos", "@"], null);
      expect(buildSelectRequest(args, args.positionals, []).specs).toEqual(["@"]);
    });
  });

  describe("a photo that isn't imported", () => {
    it("says so, and names the command that fixes it", () => {
      const error = missingError({ spec: "DSC_0500.NEF", reason: "not-in-catalogue" });
      expect(error.code).toBe(2);
      expect(error.message).toBe("DSC_0500.NEF isn't imported.");
      expect(error.hint).toBe("safelight import DSC_0500.NEF");
    });

    it("quotes a name with spaces in the fix", () => {
      expect(missingError({ spec: "my photo.NEF", reason: "not-in-catalogue" }).hint).toBe('safelight import "my photo.NEF"');
    });
  });

  it("splits stdin into trimmed non-empty lines", () => {
    expect(stdinPhotoPaths("a.ARW\r\n\n  b.ARW \n")).toEqual(["a.ARW", "b.ARW"]);
  });

  it("counts a photo as edited once its cursor leaves the first step", () => {
    expect(isEdited(undefined)).toBe(false);
    expect(isEdited({ photoId: "p", stack: [], currentIndex: 0 })).toBe(false);
    expect(isEdited({ photoId: "p", stack: [], currentIndex: 2 })).toBe(true);
  });
});

