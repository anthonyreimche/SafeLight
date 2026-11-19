// `open` from a shell, and the set it finds, through main() with the real
// services on a temp project and a temp userData. The engine is a fake that
// imports by writing the record itself.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredPhoto } from "@/catalog/types";
import type { EngineEvent, EngineRequest } from "@/engine/protocol";
import type { EngineClient, EngineFrame } from "../engine-client";
import { main, type MainIO } from "../main";
import type { CommandSpec } from "../types";
import { findOpenSet, openCommand } from "./open";

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

const catalogFile = () => path.join(project, ".safelight", "catalog.json");

function seed(photos: StoredPhoto[], loose: string[] = []): void {
  fs.mkdirSync(path.join(project, "day1"), { recursive: true });
  for (const rel of [...photos.map((p) => p.relPath), ...loose]) fs.writeFileSync(path.join(project, rel), "x");
  fs.mkdirSync(path.join(project, ".safelight"));
  fs.writeFileSync(catalogFile(), JSON.stringify({ version: 2, id: "cat-1", photos, edits: [], removed: [] }));
}

function sink(tty: boolean) {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return { stream: Object.assign(stream, { isTTY: tty, columns: 100 }) as unknown as NodeJS.WriteStream, text: () => chunks.join("") };
}

/** Prints the set `open` would hold, so the tests see what findOpenSet found. */
const probe: CommandSpec = {
  ...openCommand,
  verb: "probe",
  async run(ctx, args) {
    const set = await findOpenSet(ctx, args);
    ctx.out.print(JSON.stringify({ ...set, paths: set.paths.map((p) => path.relative(project, p).split(path.sep).join("/")) }));
    return { code: 0 };
  },
};

/** An engine that answers an import by adding the records itself, or by saying Safelight holds the lock. */
function fakeEngine(seen: EngineRequest[], answer: "import" | "locked" = "import"): EngineClient {
  return {
    async *request(req): AsyncGenerator<EngineEvent | EngineFrame> {
      seen.push(req);
      if (req.type !== "import") throw new Error(`unexpected ${req.type}`);
      if (answer === "locked") {
        yield { id: req.id, type: "error", code: "locked", message: "held", heldBy: { app: "safelight", pid: 1, host: "h", since: 0, refreshedAt: 0 } };
        return;
      }
      const files = req.scope.kind === "some" ? req.scope.files : [];
      const catalog = JSON.parse(fs.readFileSync(catalogFile(), "utf8")) as { photos: StoredPhoto[] };
      catalog.photos.push(...files.map((rel, i) => record(`new-${i}`, rel)));
      fs.writeFileSync(catalogFile(), JSON.stringify(catalog));
      for (const relPath of files) yield { id: req.id, type: "import-file", relPath, state: "ok" };
      yield { id: req.id, type: "import-done", moved: [], dropped: [], pending: 0, stopped: null };
      yield { id: req.id, type: "done" };
    },
    shutdown: async () => {},
  };
}

async function slu(argv: string[], opts: { tty?: boolean; engine?: EngineClient } = {}) {
  const tty = opts.tty ?? false;
  const stdout = sink(tty);
  const stderr = sink(tty);
  const stdin = Object.assign(Readable.from([]), { isTTY: tty }) as unknown as NodeJS.ReadStream;
  const io: MainIO = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin,
    env: { SLU_USER_DATA: userData, NO_COLOR: "1" },
    cwd: project,
    platform: process.platform,
    home: temp,
    moduleFile: path.join(temp, "safelight.mjs"),
    onInterrupt: () => () => {},
    commands: [openCommand, probe],
    ...(opts.engine && { services: { engine: () => opts.engine as EngineClient } }),
  };
  const code = await main(argv, io);
  return { code, out: stdout.text(), err: stderr.text() };
}

const setOf = (out: string) => JSON.parse(out.trim().split("\n").pop() ?? "{}") as { paths: string[]; index: number; root: string };

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "slu-open-"));
  project = path.join(temp, "shoot");
  userData = path.join(temp, "userData");
  fs.mkdirSync(userData);
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  seed([record("a", "a.ARW", { rating: 2 }), record("b", "b10.ARW", { rating: 5 }), record("b2", "b9.ARW", { rating: 1 }), record("c", "day1/c.ARW")], ["d.ARW"]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("open from a shell", () => {
  it("is refused when it isn't a terminal, or with --json", async () => {
    const piped = await slu(["open", "a.ARW"]);
    expect(piped.code).toBe(1);
    expect(piped.err).toContain("open works in a terminal. In scripts, use tools, preview or export.");
    const json = await slu(["open", "a.ARW", "--json"], { tty: true });
    expect(json.code).toBe(1);
  });

  it("says next, prev and close work at the prompt", async () => {
    for (const verb of ["next", "prev", "close"]) {
      const r = await slu([verb]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`${verb} works at the prompt: safelight open <photos>`);
    }
  });
});

describe("the set open finds", () => {
  it("holds absolute paths in name order, numbers counted as numbers, on the first photo", async () => {
    const r = await slu(["probe", "*.ARW"]);
    expect(r.err).toBe("");
    expect(setOf(r.out)).toEqual({ paths: ["a.ARW", "b9.ARW", "b10.ARW"], index: 0, root: project });
  });

  it("takes folders, -r and filters, and orders by --sort and --reverse", async () => {
    expect(setOf((await slu(["probe", "-r"])).out).paths).toEqual(["a.ARW", "b9.ARW", "b10.ARW", "day1/c.ARW"]);
    expect(setOf((await slu(["probe", "--rating", "2+"])).out).paths).toEqual(["a.ARW", "b10.ARW"]);
    expect(setOf((await slu(["probe", "*.ARW", "--sort", "rating", "--reverse"])).out).paths).toEqual(["b10.ARW", "a.ARW", "b9.ARW"]);
    expect((await slu(["probe", "--sort", "size"])).code).toBe(1);
  });

  it("imports a photo of the project that isn't imported yet, alone, then opens it", async () => {
    const seen: EngineRequest[] = [];
    const r = await slu(["probe", "d.ARW", "a.ARW"], { engine: fakeEngine(seen) });
    expect(r.err).toBe("");
    expect(seen).toMatchObject([{ type: "import", project: { root: project }, scope: { kind: "some", files: ["d.ARW"], folders: [] }, metadata: true }]);
    expect(r.out).toContain("Imported d.ARW.");
    expect(setOf(r.out).paths).toEqual(["a.ARW", "d.ARW"]);
  });

  it("refuses that import with exit 4 while Safelight has the project", async () => {
    const r = await slu(["probe", "d.ARW"], { engine: fakeEngine([], "locked") });
    expect(r.code).toBe(4);
    expect(r.err).toContain("Safelight has");
  });

  it("refuses a photo outside any catalogue with the import fix", async () => {
    const outside = path.join(temp, "loose.ARW");
    fs.writeFileSync(outside, "x");
    const r = await slu(["probe", outside]);
    expect(r.code).toBe(2);
    // A long temp path (macOS) wraps the message at the terminal's width.
    const said = r.err.replace(/\s+/g, " ");
    expect(said).toContain("isn't imported");
    expect(said).toContain("safelight import");
  });
});
