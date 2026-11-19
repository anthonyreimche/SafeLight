// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `ls` end to end: main() with the real services on a temp project and userData.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredPhoto } from "@/catalog/types";
import type { EngineRequest } from "@/engine/protocol";
import type { EngineClient } from "../engine-client";
import { main, type MainIO } from "../main";
import { CliError } from "../types";
import { lsCommand } from "./ls";
import { setCommand } from "./set";

const unstyled = (text: string): string => text.replace(/\x1b\[[\d;:]*m/g, "");

const noEngine: EngineClient = {
  request: () => { throw new Error("no engine here"); },
  shutdown: async () => {},
};

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

const record = (id: string, relPath: string, extra: Partial<StoredPhoto> = {}): StoredPhoto => ({
  id,
  filename: path.posix.basename(relPath),
  relPath,
  folder: path.posix.dirname(relPath) === "." ? "" : path.posix.dirname(relPath),
  width: 6000,
  height: 4000,
  fileSize: 24_000_000,
  mimeType: "image/x-sony-arw",
  rating: 0,
  colorLabel: "none",
  flag: "none",
  rotation: 0,
  keywords: [],
  dateCreated: 1,
  dateImported: 2,
  exif: { colorTemperature: 5200 },
  ...extra,
});

const touch = (root: string, rel: string): void => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
};

/** a.ARW imported (5 stars, pick, red); b.ARW new; c.ARW removed; day1/d.ARW record with no file;
 *  day1/e.ARW imported; day1/f.ARW new; notes.txt. */
function seedProject(root: string): void {
  for (const rel of ["a.ARW", "b.ARW", "c.ARW", "notes.txt", "day1/e.ARW", "day1/f.ARW"]) touch(root, rel);
  fs.mkdirSync(path.join(root, ".safelight"));
  const catalog = {
    version: 2,
    id: "cat-1",
    photos: [
      record("a", "a.ARW", { rating: 5, flag: "pick", colorLabel: "red" }),
      record("d", "day1/d.ARW"),
      record("e", "day1/e.ARW", { rating: 2 }),
    ],
    edits: [],
    removed: ["c.ARW"],
  };
  fs.writeFileSync(path.join(root, ".safelight", "catalog.json"), JSON.stringify(catalog));
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

async function slu(
  argv: string[],
  cwd = project,
  terminal = false,
  extra: { env?: Record<string, string>; engine?: EngineClient } = {},
): Promise<{ code: number; out: string; err: string }> {
  const stdout = sink();
  if (terminal) Object.assign(stdout.stream, { isTTY: true });
  const stderr = sink();
  const io: MainIO = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
    env: extra.env
      ? { SLU_USER_DATA: userData, ...extra.env }
      : { SLU_USER_DATA: userData, NO_COLOR: "1", ...(terminal ? { TERM: "xterm-256color" } : {}) },
    services: { engine: () => extra.engine ?? noEngine },
    cwd,
    platform: process.platform,
    home: temp,
    moduleFile: path.join(temp, "safelight.mjs"),
    onInterrupt: () => () => {},
    commands: [lsCommand, setCommand],
  };
  const code = await main(argv, io);
  return { code, out: stdout.text(), err: stderr.text() };
}

interface LsJson {
  slu: number;
  folder: string;
  project: { root: string; workingDir: string; location: string } | null;
  folders: { path: string; relPath: string; photos: number; imported: number; edited: number; picks: number; new: number }[];
  photos: Record<string, unknown>[];
  otherFiles: number;
}

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "slu-ls-cmd-"));
  project = path.join(temp, "shoot");
  userData = path.join(temp, "userData");
  fs.mkdirSync(userData);
  seedProject(project);
  vi.stubGlobal("BroadcastChannel", FakeChannel);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("safelight ls", () => {
  it("prints one tab-separated line per entry when it isn't a terminal, folders first", async () => {
    const r = await slu(["ls"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "folder\t3\tday1/",
        "imported\t5\tpick\tred\t\ta.ARW",
        "new\t\t\t\t\tb.ARW",
        "removed\t\t\t\t\tc.ARW",
        "",
      ].join("\n"),
    );
  });

  it("marks an edited photo in its line", async () => {
    await slu(["set", "a.ARW", "exposure=1"]);
    const r = await slu(["ls", "a.ARW"]);
    expect(r.out).toBe("imported\t5\tpick\tred\tedited\ta.ARW\n");
  });

  it("lists a subfolder with -r and shows a missing file", async () => {
    const r = await slu(["ls", "day1", "-r"]);
    expect(r.out).toBe(["missing\t0\tnone\tnone\t\td.ARW", "imported\t2\tnone\tnone\t\te.ARW", "new\t\t\t\t\tf.ARW", ""].join("\n"));
  });

  it("gives the folders alone, nested, for --tree", async () => {
    const r = await slu(["ls", "--tree"]);
    expect(r.out).toBe(["folder\t5\tshoot/", "folder\t3\tday1/", ""].join("\n"));
  });

  it("narrows by state and by catalogue filter", async () => {
    expect((await slu(["ls", "-r", "--new"])).out).toBe("new\t\t\t\t\tb.ARW\nnew\t\t\t\t\tday1/f.ARW\n");
    expect((await slu(["ls", "-r", "--removed"])).out).toBe("removed\t\t\t\t\tc.ARW\n");
    expect((await slu(["ls", "-r", "--missing"])).out).toBe("missing\t0\tnone\tnone\t\tday1/d.ARW\n");
    expect((await slu(["ls", "-r", "--rating", "4+"])).out).toBe("imported\t5\tpick\tred\t\ta.ARW\n");
    expect((await slu(["ls", "-r", "--flag", "pick", "--imported"])).out).toBe("imported\t5\tpick\tred\t\ta.ARW\n");
  });

  it("sorts, and reverses", async () => {
    expect((await slu(["ls", "-r", "--imported", "--sort", "rating", "--reverse"])).out.split("\n").map((l) => l.split("\t").at(-1))).toEqual(["a.ARW", "day1/e.ARW", ""]);
    const bad = await slu(["ls", "--sort", "colour"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("--sort colour");
  });

  it("matches a glob against files the catalogue doesn't hold", async () => {
    const r = await slu(["ls", "*.ARW"]);
    expect(r.out.split("\n").filter(Boolean).map((l) => l.split("\t")[0])).toEqual(["imported", "new", "removed"]);
  });

  it("says what wasn't found, exit 2, or 6 when something was listed", async () => {
    const none = await slu(["ls", "nope.ARW"]);
    expect(none.code).toBe(2);
    expect(none.err).toContain("nope.ARW wasn't found.");
    const some = await slu(["ls", "nope.ARW", "a.ARW"]);
    expect(some.code).toBe(6);
    expect(some.out).toBe("imported\t5\tpick\tred\t\ta.ARW\n");
  });

  it("lists photos outside a project as not imported", async () => {
    const loose = path.join(temp, "loose");
    touch(loose, "x.ARW");
    const r = await slu(["ls"], loose);
    expect(r.code).toBe(0);
    expect(r.out).toBe("new\t\t\t\t\tx.ARW\n");
    expect(fs.existsSync(path.join(loose, ".safelight"))).toBe(false);
  });

  it("draws the terminal look with the states and the fix", async () => {
    const r = await slu(["ls"], project, true);
    expect(r.code).toBe(0);
    const out = unstyled(r.out);
    expect(out).toContain("shoot · 2 photos · 1 not imported · 1 other file");
    expect(out).toContain("day1/");
    expect(out).toContain("not imported");
    expect(out).toContain("removed from the catalogue");
    expect(out).toContain("safelight import . imports the 1 new photo.");
    expect(r.out).not.toContain("	");
  });

  it("draws --tree nested on a terminal, with the counts", async () => {
    const r = await slu(["ls", "--tree"], project, true);
    expect(r.code).toBe(0);
    const lines = unstyled(r.out).split("\n");
    expect(lines.some((l) => /shoot\s+5/.test(l))).toBe(true);
    expect(lines.some((l) => /(└─|\\--) day1\s+3/.test(l))).toBe(true);
  });

  it("takes --depth only with --tree", async () => {
    const r = await slu(["ls", "--depth", "1"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--depth");
  });

  it("writes the JSON document", async () => {
    await slu(["set", "a.ARW", "exposure=1"]);
    const r = await slu(["ls", "-r", "--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as LsJson;
    expect(doc.slu).toBe(1);
    expect(doc.folder).toBe(project);
    expect(doc.project).toEqual({ root: project, workingDir: path.join(project, ".safelight"), location: "in-folder" });
    expect(doc.otherFiles).toBe(1);
    expect(doc.folders).toEqual([]);
    expect(doc.photos.map((p) => [p.relPath, p.state])).toEqual([
      ["a.ARW", "imported"], ["b.ARW", "new"], ["c.ARW", "removed"],
      ["day1/d.ARW", "missing"], ["day1/e.ARW", "imported"], ["day1/f.ARW", "new"],
    ]);
    expect(doc.photos[0]).toEqual({
      path: path.join(project, "a.ARW"), relPath: "a.ARW", state: "imported", id: "a",
      rating: 5, flag: "pick", label: "red", edited: true, step: 1, keywords: [],
      width: 6000, height: 4000, fileSize: 1, dateCreated: 1, pending: false,
    });
    expect(doc.photos[1]).toEqual({ path: path.join(project, "b.ARW"), relPath: "b.ARW", state: "new", fileSize: 1 });
  });

  it("counts folders in the JSON", async () => {
    const doc = JSON.parse((await slu(["ls", "--json"])).out) as LsJson;
    expect(doc.folders).toEqual([
      { path: path.join(project, "day1"), relPath: "day1", photos: 3, imported: 2, edited: 0, picks: 0, new: 1 },
    ]);
  });

  describe("--grid", () => {
    const colour = { TERM: "xterm-256color", COLORTERM: "truecolor" };

    it("is the plain list off a terminal, with no engine", async () => {
      const r = await slu(["ls", "--grid"]);
      expect(r.code).toBe(0);
      expect(r.out).toBe((await slu(["ls"])).out);
    });

    it("draws each imported photo's stored preview through the engine as blocks, the rest as cells without one", async () => {
      const requests: EngineRequest[] = [];
      let shutdowns = 0;
      const engine: EngineClient = {
        async *request(req) {
          requests.push(req);
          if (req.type !== "thumbs") return;
          yield { id: req.id, type: "frame", frame: 1, width: 4, height: 2, encoding: "rgba", photoId: "a" };
          yield { frame: 1, bytes: new Uint8Array(4 * 2 * 4).fill(200) };
          yield { id: req.id, type: "done" };
        },
        shutdown: async () => { shutdowns++; },
      };
      const r = await slu(["ls", "--grid"], project, true, { env: colour, engine });
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(requests).toMatchObject([{ type: "thumbs", photoIds: ["a"], encoding: "rgba", project: { root: project } }]);
      expect(shutdowns).toBe(1);
      expect(r.out).toContain("▀");
      for (const name of ["a", "b", "c"]) expect(r.out).toMatch(new RegExp(`\\b${name}\\b`));
    });

    it("shows the stored JPEG as it is on iTerm2, without starting the engine", async () => {
      fs.mkdirSync(path.join(project, ".safelight", "previews"));
      fs.writeFileSync(path.join(project, ".safelight", "previews", "a.jpg"), "jpeg");
      const r = await slu(["ls", "--grid"], project, true, { env: { ...colour, TERM_PROGRAM: "iTerm.app" } });
      expect(r.err).toBe("");
      expect(r.out).toContain("\x1b]1337;File=inline=1;size=4;");
    });

    it("still draws the sheet when the engine can't start", async () => {
      const broken: EngineClient = {
        request: () => { throw new CliError(3, "The engine didn't start."); },
        shutdown: async () => {},
      };
      const r = await slu(["ls", "--grid"], project, true, { env: colour, engine: broken });
      expect(r.code).toBe(0);
      expect(r.err).toContain("The engine didn't start.");
      expect(r.out).toMatch(/\bb\b/);
    });
  });

  it("reads and writes nothing in the project", async () => {
    const before = fs.readFileSync(path.join(project, ".safelight", "catalog.json"));
    await slu(["ls", "-r"]);
    expect(fs.readFileSync(path.join(project, ".safelight", "catalog.json")).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(project, ".safelight", "writer.lock"))).toBe(false);
  });
});
