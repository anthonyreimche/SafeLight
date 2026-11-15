// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `safelight` end to end: main() with the real services, ProjectStorage and the Node
// shims, on a temp project and a temp userData.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditState, StoredPhoto } from "@/catalog/types";
import { acquireLock, releaseLock } from "../../electron/file-lock.cjs";
import { main, type MainIO } from "./main";
import { setCommand } from "./commands/set";
import { buildSelectRequest } from "./select";
import type { EngineRequest } from "@/engine/protocol";
import type { EngineClient, RequestOptions } from "./engine-client";
import { forgetCommand } from "./commands/forget";
import { importCommand } from "./commands/import";
import type { CommandSpec } from "./types";

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

const record = (id: string, relPath: string, rating = 0): StoredPhoto => ({
  id,
  filename: path.posix.basename(relPath),
  relPath,
  folder: path.posix.dirname(relPath) === "." ? "" : path.posix.dirname(relPath),
  width: 6000,
  height: 4000,
  fileSize: 1,
  mimeType: "image/x-sony-arw",
  rating,
  colorLabel: "none",
  flag: "none",
  rotation: 0,
  keywords: [],
  dateCreated: 1,
  dateImported: 2,
  exif: { colorTemperature: 5200 },
});

/** A project of a.ARW (never edited) and day1/b.ARW, in `root`. */
function seedProject(root: string): void {
  fs.mkdirSync(path.join(root, "day1"), { recursive: true });
  fs.writeFileSync(path.join(root, "a.ARW"), "A");
  fs.writeFileSync(path.join(root, "day1", "b.ARW"), "B");
  fs.mkdirSync(path.join(root, ".safelight"));
  const catalog = { version: 2, id: "cat-1", photos: [record("a", "a.ARW"), record("b", "day1/b.ARW", 2)], edits: [], removed: [] };
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

async function slu(argv: string[], cwd = project, extra: Partial<MainIO> = {}): Promise<{ code: number; out: string; err: string }> {
  const stdout = sink();
  const stderr = sink();
  const io: MainIO = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
    env: { SLU_USER_DATA: userData, NO_COLOR: "1" },
    cwd,
    platform: process.platform,
    home: temp,
    moduleFile: path.join(temp, "safelight.mjs"),
    onInterrupt: () => () => {},
    ...extra,
  };
  const code = await main(argv, io);
  return { code, out: stdout.text(), err: stderr.text() };
}

const catalogOf = (root = project) =>
  JSON.parse(fs.readFileSync(path.join(root, ".safelight", "catalog.json"), "utf8")) as {
    photos: StoredPhoto[];
    edits: EditState[];
  };
const editOf = (id: string) => catalogOf().edits.find((e) => e.photoId === id);

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "slu-e2e-"));
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

describe("safelight end to end", () => {
  it("lists the core tools without a photo", async () => {
    const r = await slu(["tools", "--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as { slu: number; tools: { id: string; kind: string; settable: boolean }[] };
    expect(doc.slu).toBe(1);
    expect(doc.tools).toEqual(expect.arrayContaining([expect.objectContaining({ id: "safelight.basic", kind: "core", settable: true })]));
  });

  it("sets values as one step, and get, tools and history read it back", async () => {
    const set = await slu(["set", "a.ARW", "exposure=1", "contrast=10", "--json"]);
    expect(set.err).toBe("");
    expect(set.code).toBe(0);
    expect(JSON.parse(set.out)).toEqual({
      slu: 1,
      photos: [{
        photo: "a.ARW", ok: true, changed: true, step: 1,
        changes: [{ key: "exposure", before: 0, after: 1 }, { key: "contrast", before: 0, after: 10 }],
      }],
    });
    expect(editOf("a")?.stack.map((s) => s.label)).toEqual(["Original", "Exposure, Contrast"]);
    expect(fs.existsSync(path.join(project, ".safelight", "writer.lock"))).toBe(false);

    const get = JSON.parse((await slu(["get", "a.ARW", "exposure", "temperature", "--json"])).out);
    expect(get).toEqual({ slu: 1, photo: "a.ARW", values: { exposure: 1, temperature: 5200 } });

    const tools = JSON.parse((await slu(["tools", "a.ARW", "--json"])).out) as { edited: boolean; tools: { values: { key: string; value: unknown; changed: boolean }[] }[] };
    expect(tools.edited).toBe(true);
    expect(tools.tools.flatMap((t) => t.values).find((v) => v.key === "exposure")).toMatchObject({ value: 1, changed: true });

    const history = JSON.parse((await slu(["history", "a.ARW", "--json"])).out);
    expect(history).toMatchObject({ slu: 1, photo: "a.ARW", steps: [{ index: 0, label: "Original" }, { index: 1, label: "Exposure, Contrast", current: true }] });

    const text = await slu(["get", "a.ARW", "exposure"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("+1.00 EV");
  });

  it("undoes a step, and a set after it drops the redo tail", async () => {
    await slu(["set", "a.ARW", "exposure=1"]);
    await slu(["set", "a.ARW", "exposure=2"]);
    const undo = await slu(["undo", "a.ARW", "--json"]);
    expect(undo.code).toBe(0);
    expect(JSON.parse(undo.out)).toEqual({ slu: 1, photos: [{ photo: "a.ARW", ok: true, changed: true, step: 1 }] });
    expect(editOf("a")?.currentIndex).toBe(1);
    expect(editOf("a")?.stack).toHaveLength(3);

    await slu(["set", "a.ARW", "contrast=5"]);
    const edit = editOf("a");
    expect(edit?.stack.map((s) => s.label)).toEqual(["Original", "Exposure", "Contrast"]);
    expect(edit?.currentIndex).toBe(2);
    const get = JSON.parse((await slu(["get", "a.ARW", "exposure", "contrast", "--json"])).out);
    expect(get.values).toEqual({ exposure: 1, contrast: 5 });
  });

  it("rates without a history step", async () => {
    const r = await slu(["rate", "a.ARW", "4", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ slu: 1, photos: [{ photo: "a.ARW", ok: true, rating: 4, changed: true }] });
    expect(catalogOf().photos.find((p) => p.id === "a")?.rating).toBe(4);
    expect(editOf("a")).toBeUndefined();
  });

  it("finds a subfolder photo's project in the folder above", async () => {
    const r = await slu(["set", "b.ARW", "exposure=0.5"], path.join(project, "day1"));
    expect(r.code).toBe(0);
    expect(editOf("b")?.stack.map((s) => s.label)).toEqual(["Original", "Exposure"]);
    const get = JSON.parse((await slu(["get", "day1/b.ARW", "exposure", "--json"])).out);
    expect(get.values).toEqual({ exposure: 0.5 });
    expect(fs.existsSync(path.join(project, "day1", ".safelight"))).toBe(false);
  });

  it("lists photos as {safelight, photos} under --json", async () => {
    const r = await slu(["photos", "--recursive", "--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as { slu: number; photos: { relPath: string; path: string }[] };
    expect(doc.slu).toBe(1);
    expect(doc.photos.map((p) => p.relPath).sort()).toEqual(["a.ARW", "day1/b.ARW"]);
    expect(doc.photos.find((p) => p.relPath === "a.ARW")?.path).toBe(path.join(project, "a.ARW"));
  });

  it("refuses to write with exit 4 while Safelight holds the project, and still reads", async () => {
    const lockFile = path.join(project, ".safelight", "writer.lock");
    const held = await acquireLock(lockFile, "safelight");
    if (!held.ok) throw new Error("lock not taken");
    try {
      const before = fs.readFileSync(path.join(project, ".safelight", "catalog.json"), "utf8");
      const set = await slu(["set", "a.ARW", "exposure=1", "--json"]);
      expect(set.code).toBe(4);
      expect(JSON.parse(set.out)).toMatchObject({ slu: 1, ok: false, error: { code: 4 } });
      expect(set.err).toContain("Safelight has");
      expect(fs.readFileSync(path.join(project, ".safelight", "catalog.json"), "utf8")).toBe(before);

      const get = await slu(["get", "a.ARW", "exposure", "--json"]);
      expect(get.code).toBe(0);
      expect(JSON.parse(get.out)).toMatchObject({ values: { exposure: 0 } });
    } finally {
      await releaseLock(lockFile, held.token);
    }
  });

  it("on Ctrl+C keeps what was stored, writes it whole, lets go of the lock and exits 130", async () => {
    let interrupt = () => {};
    let stored = () => {};
    const storedOnce = new Promise<void>((resolve) => (stored = resolve));
    const stuck: CommandSpec = {
      ...setCommand,
      async run(ctx, args) {
        const selection = await ctx.select.write(buildSelectRequest(args, args.positionals, []), null);
        const [photo] = selection.groups[0].photos;
        await selection.groups[0].session.putPhotos([{ ...photo, rating: 5 }]);
        stored();
        return new Promise(() => {});
      },
    };
    const run = slu(["set", "a.ARW"], project, {
      commands: [stuck],
      onInterrupt: (handler) => {
        interrupt = handler;
        return () => {};
      },
    });
    await storedOnce;
    interrupt();
    const r = await run;
    expect(r.code).toBe(130);
    expect(catalogOf().photos.find((p) => p.id === "a")?.rating).toBe(5);
    expect(fs.existsSync(path.join(project, ".safelight", "writer.lock"))).toBe(false);
  });

  it("takes a forgotten photo back only when it is named to import", async () => {
    expect((await slu(["forget", "a.ARW"], project, { commands: [forgetCommand] })).code).toBe(0);
    const dry = async (argv: string[]) => JSON.parse((await slu(["import", ...argv, "--dry-run", "--json"], project, { commands: [importCommand] })).out) as { new: string[] };
    expect((await dry([])).new).toEqual([]);
    expect((await dry(["a.ARW"])).new).toEqual([path.join(project, "a.ARW")]);
    const requests: EngineRequest[] = [];
    const engine: EngineClient = {
      async *request(req) {
        requests.push(req);
        yield { id: req.id, type: "done" };
      },
      shutdown: async () => {},
    };
    await slu(["import", "a.ARW"], project, { commands: [importCommand], services: { engine: () => engine } });
    expect(requests).toMatchObject([{ type: "import", scope: { kind: "some", files: ["a.ARW"], folders: [] } }]);
  });

  describe("Ctrl+C on an import", () => {
    /** An engine that imports a.ARW, then waits for the cancel and answers as the engine does: done, stopped. */
    function stoppingEngine(seen: { options: RequestOptions[]; shutdowns: number }, gotFirst: () => void): EngineClient {
      return {
        async *request(req, options = {}) {
          seen.options.push(options);
          if (req.type !== "import") return;
          fs.writeFileSync(path.join(project, "c.ARW"), "C");
          yield { id: req.id, type: "import-plan", workingDir: path.join(project, ".safelight"), location: "in-folder", created: false, newFiles: 2 };
          yield { id: req.id, type: "import-file", relPath: "c.ARW", photoId: "c", state: "ok" };
          gotFirst();
          await new Promise((resolve) => options.signal?.addEventListener("abort", resolve, { once: true }));
          if (options.force?.aborted) return;
          yield { id: req.id, type: "import-done", moved: [], dropped: [], pending: 0, stopped: "interrupted" };
          yield { id: req.id, type: "done" };
        },
        shutdown: async () => { seen.shutdowns++; },
      };
    }

    async function importWithPresses(presses: number) {
      const seen = { options: [] as RequestOptions[], shutdowns: 0 };
      let interrupt = () => {};
      let gotFirst = () => {};
      const first = new Promise<void>((resolve) => (gotFirst = resolve));
      const run = slu(["import", "--json"], project, {
        commands: [importCommand],
        services: { engine: () => stoppingEngine(seen, gotFirst) },
        onInterrupt: (handler) => {
          interrupt = handler;
          return () => {};
        },
      });
      await first;
      for (let i = 0; i < presses; i++) interrupt();
      return { r: await run, seen };
    }

    it("asks the engine to stop, waits for the files in flight, says what was imported and exits 130", async () => {
      const { r, seen } = await importWithPresses(1);
      expect(r.code).toBe(130);
      expect(seen.options[0].signal?.aborted).toBe(true);
      expect(seen.options[0].force?.aborted).toBe(false);
      expect(seen.shutdowns).toBe(1);
      expect(JSON.parse(r.out)).toMatchObject({ imported: [{ relPath: "c.ARW", id: "c" }], stopped: "interrupted" });
    });

    it("stops the engine at once on a second Ctrl+C", async () => {
      const { r, seen } = await importWithPresses(2);
      expect(r.code).toBe(130);
      expect(seen.options[0].force?.aborted).toBe(true);
    });
  });

  it("previews --try values through the engine without storing them", async () => {
    const requests: EngineRequest[] = [];
    const engine: EngineClient = {
      async *request(req) {
        requests.push(req);
        yield { id: req.id, type: "frame", frame: 1, width: 2, height: 2, encoding: "rgba" };
        yield { frame: 1, bytes: new Uint8Array(16) };
        yield { id: req.id, type: "done" };
      },
      shutdown: async () => {},
    };
    const before = fs.readFileSync(path.join(project, ".safelight", "catalog.json"), "utf8");
    const r = await slu(["preview", "a.ARW", "exposure=1.5", "--try", "--graphics", "blocks", "--width", "4"], project, {
      services: { engine: () => engine },
    });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(requests[0]).toMatchObject({ type: "preview", photoId: "a", encoding: "rgba", overrides: { params: { exposure: 1.5 } } });
    expect(fs.readFileSync(path.join(project, ".safelight", "catalog.json"), "utf8")).toBe(before);
  });

  it("refuses a photo outside any catalogue with exit 2", async () => {
    const loose = path.join(temp, "loose");
    fs.mkdirSync(loose);
    fs.writeFileSync(path.join(loose, "c.ARW"), "C");
    const r = await slu(["set", "c.ARW", "exposure=1"], loose);
    expect(r.code).toBe(2);
    expect(r.err).toContain("c.ARW isn't imported");
    expect(r.err).toContain("safelight import c.ARW");
  });

  it("suggests a key for a misspelt reset key, not a missing photo", async () => {
    const r = await slu(["reset", "a.ARW", "exposre"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Did you mean "exposure"?');
  });
});
