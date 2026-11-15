// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freshParams, type CatalogPhoto, type EditState } from "@/catalog/types";
import type { EngineEvent, EngineRequest } from "@/engine/protocol";
import type { EngineClient, EngineFrame } from "../engine-client";
import { createOutput } from "../output";
import { sink } from "../output/fixtures";
import type { CliEnv, ProjectRef, ReadSession } from "../types";
import { createValueService } from "../values";
import { startLiveView, type LiveView, type LiveViewDeps, type LiveViewOptions } from "./view";

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const ASSETS = { html: "<!doctype html>", js: "", css: "" };

function photo(id: string, over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
    id, filename: `${id}.ARW`, relPath: `day1/${id}.ARW`, folder: "day1", directoryHandle: null, fileHandle: null,
    thumbnailBlob: null, thumbnailUrl: null, width: 6000, height: 4000, fileSize: 8, mimeType: "image/x-sony-arw",
    rating: 3, colorLabel: "blue", flag: "pick", rotation: 0, keywords: [], dateCreated: 0, dateImported: 0,
    exif: { colorTemperature: 5200 }, ...over,
  };
}

function edited(id: string, exposure: number): EditState {
  const original = freshParams(5200);
  return {
    photoId: id,
    stack: [
      { timestamp: 1, label: "Original", params: original, paramBag: {} },
      { timestamp: 2, label: "Exposure", params: { ...original, exposure }, paramBag: {} },
    ],
    currentIndex: 1,
  };
}

/** A catalogue in memory, read through sessions as the CLI reads one. */
function fakeCatalogue(project: ProjectRef) {
  const photos = [photo("a"), photo("b")];
  const edits = new Map<string, EditState>([["a", edited("a", 0.5)]]);
  const projects = {
    async openRead(): Promise<ReadSession> {
      const held = photos.map((p) => ({ ...p }));
      return {
        project,
        photos: () => held,
        photoByRelPath: (rel) => held.find((p) => p.relPath === rel),
        previewFile: () => null,
        edit: async (id) => edits.get(id),
        close: async () => {},
      };
    },
  };
  return { photos, edits, projects };
}

/** An engine that answers each preview with one frame, and can hold its renders back. */
function fakeEngine() {
  const requests: Extract<EngineRequest, { type: "preview" }>[] = [];
  let hold: Promise<void> | null = null;
  let release = () => {};
  let frames = 0;
  const client: EngineClient = {
    async *request(req): AsyncGenerator<EngineEvent | EngineFrame> {
      if (req.type !== "preview") return;
      requests.push(req);
      if (hold) await hold;
      const frame = ++frames;
      yield { id: req.id, type: "frame", frame, width: req.width, height: req.height, encoding: req.encoding };
      yield { frame, bytes: req.encoding === "rgba" ? new Uint8Array(req.width * req.height * 4).fill(128) : PNG };
      yield { id: req.id, type: "done" };
    },
    shutdown: async () => {},
  };
  return {
    client,
    requests,
    holdRenders() {
      hold = new Promise<void>((resolve) => { release = resolve; });
    },
    release() {
      hold = null;
      release();
    },
  };
}

function env(): CliEnv {
  return {
    cwd: "/w", userData: "/u", appRoot: "/app", electronBinary: "/electron", appVersion: "3.3.0", platform: "linux",
    isTTY: { stdin: true, stdout: true, stderr: true }, env: { COLORTERM: "truecolor" },
  };
}

const dirs: string[] = [];
const views: LiveView[] = [];
afterEach(async () => {
  await Promise.all(views.splice(0).map((v) => v.stop()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(options: Partial<LiveViewOptions> = {}, over: Partial<LiveViewDeps> = {}) {
  const workingDir = await mkdtemp(path.join(tmpdir(), "slu-view-"));
  dirs.push(workingDir);
  await writeFile(path.join(workingDir, "catalog.json"), "{}");
  const project: ProjectRef = { root: path.dirname(workingDir), workingDir, location: "external" };
  const catalogue = fakeCatalogue(project);
  const engine = fakeEngine();
  const stdout = sink(true, 80);
  const out = createOutput({ stdout: stdout.stream, stderr: sink(false).stream }, {
    colour: { stdout: false, stderr: false }, unicode: true, width: 80, verbosity: "normal",
  });
  const opened: string[] = [];
  const view = await startLiveView(
    {
      env: env(), out, engine: () => engine.client, projects: catalogue.projects,
      values: createValueService(new Map(), [], []), assets: ASSETS, debounceMs: 20,
      openBrowser: (url) => opened.push(url),
      detect: async () => ({ mode: "blocks", reason: "" }),
      ...over,
    },
    { mode: "browser", port: 0, open: true, ...options },
    { project, relPath: "day1/a.ARW" },
  );
  views.push(view);
  const port = Number(new URL(view.url ?? "http://x:0").port);
  const get = async (route: string) => {
    const reply = await fetch(`${view.url}${route}`);
    return { status: reply.status, type: reply.headers.get("content-type"), body: Buffer.from(await reply.arrayBuffer()) };
  };
  return { view, catalogue, engine, stdout, opened, get, port, workingDir, project };
}

/** Collects the revs an event stream sends until `stop` says enough. */
function revs(url: string, enough: (got: number[]) => boolean): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const target = new URL(`${url}events`);
    const req = httpRequest({ host: target.hostname, port: target.port, path: target.pathname, headers: { host: target.host } }, (res) => {
      let text = "";
      res.on("data", (c: Buffer) => {
        text += c.toString("utf8");
        const got = [...text.matchAll(/data: \{"rev":(\d+)\}/g)].map((m) => Number(m[1]));
        if (enough(got)) {
          req.destroy();
          resolve(got);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the live view in the browser", () => {
  it("opens the browser on its URL and answers /state for the photo it follows, steps counted from 1", async () => {
    const { view, opened, get } = await setup();
    expect(opened).toEqual([view.url]);
    const state = JSON.parse((await get("state")).body.toString());
    expect(state).toMatchObject({
      slu: 1,
      photo: { name: "a.ARW", relPath: "day1/a.ARW", width: 6000, height: 4000, step: { at: 2, of: 2 }, rating: 3, flag: "pick", label: "blue" },
      history: [{ index: 0, label: "Original", current: false }, { index: 1, label: "Exposure", current: true }],
      working: null,
      engine: "warming",
      before: false,
    });
    expect(state.values).toContainEqual(expect.objectContaining({ key: "exposure", value: 0.5, changed: true, min: expect.any(Number), max: expect.any(Number) }));
  });

  it("doesn't open the browser with --no-open", async () => {
    const { opened } = await setup({ open: false });
    expect(opened).toEqual([]);
  });

  it("sends a rev when this process changed the photo, and none for a change to another photo", async () => {
    const { view, catalogue } = await setup();
    const first = view.model.rev;
    const seen = revs(view.url ?? "", (got) => got.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    catalogue.edits.set("b", edited("b", 1));
    await view.changed();
    expect(view.model.rev).toBe(first);
    catalogue.edits.set("a", edited("a", 1.5));
    await view.changed();
    expect(await seen).toEqual([first, first + 1]);
  });

  it("sends a rev when the catalogue file changes under it", async () => {
    const { view, catalogue, workingDir } = await setup();
    const first = view.model.rev;
    const seen = revs(view.url ?? "", (got) => got.includes(first + 1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    catalogue.photos[0].rating = 5;
    await writeFile(path.join(workingDir, "catalog.json"), '{"changed":true}');
    expect(await seen).toContain(first + 1);
    expect(view.model.state().photo?.rating).toBe(5);
  });

  it("renders the region and size the page asks for, with the catalogue's stamp", async () => {
    const { engine, get } = await setup();
    const reply = await get("frame?rev=2&w=640&h=480&x=0.25&y=0.5&zw=0.5&zh=0.25&before=0");
    expect(reply.status).toBe(200);
    expect(reply.type).toBe("image/png");
    expect(engine.requests).toHaveLength(1);
    expect(engine.requests[0]).toMatchObject({
      type: "preview", photoId: "a", width: 640, height: 480, encoding: "png", region: { x: 0.25, y: 0.5, w: 0.5, h: 0.25 },
      catalogue: expect.stringMatching(/^\d+(\.\d+)?:2$/),
    });
    expect(engine.requests[0].overrides).toBeUndefined();
  });

  it("renders the first step for before, and a repeat of the same frame from what it kept", async () => {
    const { engine, get } = await setup();
    await get("frame?w=100&h=100&before=1");
    await get("frame?w=100&h=100&before=1");
    expect(engine.requests).toHaveLength(1);
    expect(engine.requests[0].overrides?.params?.exposure).toBe(0);
  });

  it("renders a burst of asks once at the end, one render at a time", async () => {
    const { engine, get } = await setup();
    engine.holdRenders();
    const first = get("frame?w=100&h=100");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const burst = [0.1, 0.2, 0.3].map((x) => get(`frame?w=100&h=100&x=${x}&y=0&zw=0.5&zh=0.5`));
    await new Promise((resolve) => setTimeout(resolve, 30));
    engine.release();
    expect((await first).status).toBe(200);
    expect((await Promise.all(burst)).map((r) => r.status)).toEqual([204, 204, 200]);
    expect(engine.requests.map((r) => r.region?.x ?? null)).toEqual([null, 0.3]);
  });

  it("stops serving and watching when stopped", async () => {
    const { view, get, port } = await setup();
    expect((await get("state")).status).toBe(200);
    await view.stop();
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });
});

describe("the live view in the terminal", () => {
  it("draws the photo, then redraws it in place on the same rows when it changes", async () => {
    const { view, catalogue, stdout } = await setup({ mode: "terminal", widthCols: 30 });
    await view.settled();
    const first = stdout.text();
    // 30 columns of a 3:2 photo: 20 pixel rows, 10 text rows, and the caption.
    expect(first.split("\n")).toHaveLength(12);
    expect(first).toMatch(/blocks · 24-bit · \d+\.\d s · step 2 of 2\n$/);
    expect(first).not.toContain("\x1b[11A");

    stdout.chunks.length = 0;
    catalogue.edits.set("a", edited("a", 2));
    await view.changed();
    await view.settled();
    const second = stdout.text();
    expect(second.startsWith("\x1b[11A\r")).toBe(true);
    expect(second.split("\n")).toHaveLength(12);
  });

  it("prints the next picture anew once something else came below it", async () => {
    const { view, catalogue, stdout } = await setup({ mode: "terminal", widthCols: 30 });
    await view.settled();
    view.moved();
    stdout.chunks.length = 0;
    catalogue.edits.set("a", edited("a", 2));
    await view.changed();
    await view.settled();
    expect(stdout.text()).not.toContain("\x1b[11A");
    expect(stdout.text()).toContain("step 2 of 2");
  });
});
