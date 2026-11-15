import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshParams, type CatalogPhoto } from "@/catalog/types";
import type { EngineRequest } from "@/engine/protocol";
import type { EngineClient } from "./engine-client";
import type { Output } from "./output/types";
import { cachedPicture, createExportTracker, createPreviewService, lookAtStep, previewFrameSize, withLamp } from "./preview";
import { createPreviewCache, frameKey, lookKey } from "./preview-cache";
import { CliError, type CliEnv } from "./types";

describe("withLamp", () => {
  async function* events(): AsyncGenerator<number> {
    yield 1;
    yield 2;
    yield 3;
  }

  it("puts the wait for the first event under the lamp and passes every event on", async () => {
    const labels: string[] = [];
    const out = { working: async <T,>(label: string, task: Promise<T>) => { labels.push(label); return task; } } as Pick<Output, "working">;
    const seen: number[] = [];
    for await (const n of withLamp(out, "Starting the engine…", events())) seen.push(n);
    expect(seen).toEqual([1, 2, 3]);
    expect(labels).toEqual(["Starting the engine…"]);
  });

  it("lets the source's failure through and closes it when the reader stops early", async () => {
    const out = { working: <T,>(_label: string, task: Promise<T>) => task } as Pick<Output, "working">;
    const closed = vi.fn();
    async function* source(): AsyncGenerator<number> {
      try { yield 1; yield 2; } finally { closed(); }
    }
    for await (const n of withLamp(out, "x", source())) { expect(n).toBe(1); break; }
    expect(closed).toHaveBeenCalled();
    async function* broken(): AsyncGenerator<number> { throw new Error("engine gone"); }
    await expect((async () => { for await (const _ of withLamp(out, "x", broken())) { /* none */ } })()).rejects.toThrow("engine gone");
  });
});

describe("export tracker", () => {
  const photos = [
    { id: "a", name: "a.NEF" },
    { id: "b", name: "b.NEF" },
    { id: "c", name: "c.NEF" },
  ];

  function tracker() {
    let now = 1000;
    const t = createExportTracker(photos, "/out", () => now);
    return { t, tick: (ms: number) => { now += ms; } };
  }

  it("starts with every photo waiting, the folder and the start time", () => {
    const { t } = tracker();
    expect(t.snapshot("Exporting")).toEqual({
      label: "Exporting", done: 0, total: 3, folder: "/out", startedAt: 1000,
      items: [
        { name: "a.NEF", state: "waiting" },
        { name: "b.NEF", state: "waiting" },
        { name: "c.NEF", state: "waiting" },
      ],
    });
  });

  it("marks the first photo working once the engine is up, then each next one as one finishes", () => {
    const { t, tick } = tracker();
    tick(2000);
    t.begin();
    expect(t.snapshot("x").items?.map((i) => i.state)).toEqual(["working", "waiting", "waiting"]);
    tick(900);
    t.exported("a", { path: "/out/a.jpg", bytes: 1400 });
    const items = t.snapshot("x").items;
    expect(items?.[0]).toEqual({ name: "a.jpg", state: "done", ms: 900, bytes: 1400 });
    expect(items?.[1].state).toBe("working");
    expect(t.snapshot("x").done).toBe(1);
  });

  it("records a failure with its reason and carries on", () => {
    const { t, tick } = tracker();
    t.begin();
    tick(300);
    t.failed("a", "can't be decoded");
    tick(500);
    t.exported("b", { path: "/out/b.jpg", bytes: 10 });
    const snap = t.snapshot("x");
    expect(snap.items?.[0]).toEqual({ name: "a.NEF", state: "failed", ms: 300, error: "can't be decoded" });
    expect(snap.items?.[1]).toMatchObject({ state: "done", ms: 500 });
    expect(snap.items?.[2].state).toBe("working");
    expect(snap.done).toBe(2);
  });

  it("keeps the photo's name when a file went to stdout and ignores unknown ids", () => {
    const { t } = tracker();
    t.begin();
    t.exported("a", { bytes: 5 });
    t.exported("zzz", { bytes: 1 });
    expect(t.snapshot("x").items?.[0]).toMatchObject({ name: "a.NEF", state: "done", bytes: 5 });
    expect(t.snapshot("x").done).toBe(1);
  });
});

describe("lookAtStep", () => {
  const state = {
    photoId: "p",
    currentIndex: 2,
    stack: [0, 0.5, 1].map((exposure, i) => ({ timestamp: i, label: `s${i}`, params: { ...freshParams(5000), exposure }, paramBag: { tool: { n: i } } })),
  };

  it("is the look stored at that step, counted from 1, with how many steps there are", () => {
    const got = lookAtStep(state, 2, 5000);
    expect(got.overrides.params?.exposure).toBe(0.5);
    expect(got.overrides.paramBag).toEqual({ tool: { n: 1 } });
    expect([got.step, got.of]).toEqual([2, 3]);
  });

  it("is the fresh look for a photo with no history", () => {
    const got = lookAtStep(undefined, 1, 4200);
    expect(got.overrides.params).toEqual(freshParams(4200));
    expect([got.step, got.of]).toEqual([1, 1]);
  });

  it("refuses a step that isn't there", () => {
    expect(() => lookAtStep(state, 4, 5000)).toThrow("3 steps");
    expect(() => lookAtStep(state, 0, 5000)).toThrow(CliError);
    expect(() => lookAtStep(state, 1.5, 5000)).toThrow(CliError);
  });
});

describe("the preview service", () => {
  it("renders with the look it was given when there is no --try", async () => {
    const requests: EngineRequest[] = [];
    const engine = {
      request: async function* (req: EngineRequest) {
        requests.push(req);
        yield { id: 1, type: "frame" as const, frame: 1, width: 2, height: 2, encoding: "rgba" as const };
        yield { frame: 1, bytes: new Uint8Array(16) };
        yield { id: 1, type: "done" as const };
      },
      shutdown: async () => undefined,
    } as unknown as EngineClient;
    const out = {
      options: { width: 2 },
      working: async <T,>(_l: string, task: Promise<T>) => task,
      writeRaw: () => undefined,
      print: () => undefined,
      previewCaption: () => "caption",
      warn: () => undefined,
    } as unknown as Output;
    const env: CliEnv = { cwd: "/w", userData: "/u", appRoot: "/a", electronBinary: null, appVersion: "3", platform: "linux", isTTY: { stdin: false, stdout: false, stderr: false }, env: {} };
    const project = { root: "/p", workingDir: "/p/.safelight", location: "in-folder" as const };
    const overrides = { params: { exposure: 0.25 } };
    await createPreviewService(env, out, () => engine).show(project, { id: "a", exif: {}, rotation: 0, width: 2, height: 2 } as unknown as CatalogPhoto, { mode: "blocks", overrides });
    expect(requests[0]).toMatchObject({ type: "preview", photoId: "a", overrides });
  });

  describe("with the prompt's cache", () => {
    const env: CliEnv = { cwd: "/w", userData: "/u", appRoot: "/a", electronBinary: null, appVersion: "3", platform: "linux", isTTY: { stdin: false, stdout: true, stderr: false }, env: {} };
    const project = { root: "/p", workingDir: "/p/.safelight", location: "in-folder" as const };
    const photo = { id: "a", exif: {}, rotation: 0, width: 4, height: 2 } as unknown as CatalogPhoto;

    function harness() {
      const requests: EngineRequest[] = [];
      const raw: Uint8Array[] = [];
      const engine = {
        request: async function* (req: Extract<EngineRequest, { type: "preview" }>) {
          requests.push(req);
          yield { id: req.id, type: "frame" as const, frame: 1, width: req.width, height: req.height, encoding: req.encoding };
          yield { frame: 1, bytes: new Uint8Array(req.width * req.height * 4).fill(requests.length) };
          yield { id: req.id, type: "done" as const };
        },
        shutdown: async () => undefined,
      } as unknown as EngineClient;
      const out = {
        options: { width: 80 },
        working: async <T,>(_l: string, task: Promise<T>) => task,
        writeRaw: (b: Uint8Array) => raw.push(b),
        print: () => undefined,
        previewCaption: () => "caption",
        warn: () => undefined,
      } as unknown as Output;
      const cache = createPreviewCache();
      return { requests, raw, cache, service: createPreviewService(env, out, () => engine, undefined, undefined, cache) };
    }

    it("shows a look it has rendered at that size without the engine, and remembers how it drew", async () => {
      const h = harness();
      await h.service.show(project, photo, { mode: "blocks", widthCols: 8, look: "a@1" });
      await h.service.show(project, photo, { mode: "blocks", widthCols: 8, look: "a@1" });
      expect(h.requests).toHaveLength(1);
      expect(h.raw[1]).toEqual(h.raw[0]);
      expect(h.cache.drawnAs).toEqual({ mode: "blocks" });
      await h.service.show(project, photo, { mode: "blocks", widthCols: 8, look: "a@2" });
      await h.service.show(project, photo, { mode: "blocks", widthCols: 10, look: "a@2" });
      expect(h.requests).toHaveLength(3);
    });

    it("never keeps a look given for one showing", async () => {
      const h = harness();
      const overrides = { params: { exposure: 1 } };
      await h.service.show(project, photo, { mode: "blocks", widthCols: 8, look: "a@1", overrides });
      await h.service.show(project, photo, { mode: "blocks", widthCols: 8, look: "a@1" });
      expect(h.requests).toHaveLength(2);
    });

    it("renders afresh once the catalogue was saved between two previews, and tells the engine which catalogue to read", async () => {
      const dir = mkdtempSync(join(tmpdir(), "slu-preview-"));
      try {
        writeFileSync(join(dir, "catalog.json"), "{}");
        const saved = { root: dir, workingDir: dir, location: "external" as const };
        const h = harness();
        await h.service.show(saved, photo, { mode: "blocks", widthCols: 8, look: "a@1" });
        await h.service.show(saved, photo, { mode: "blocks", widthCols: 8, look: "a@1" });
        writeFileSync(join(dir, "catalog.json"), '{"edits":["set exposure=+1"]}');
        await h.service.show(saved, photo, { mode: "blocks", widthCols: 8, look: "a@1" });

        expect(h.requests).toHaveLength(2);
        const [first, second] = h.requests as Extract<EngineRequest, { type: "preview" }>[];
        expect(first.catalogue).toMatch(/:2$/);
        expect(second.catalogue).toMatch(/:29$/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("finds what the prefetch rendered under the same key", async () => {
      const h = harness();
      const size = previewFrameSize("blocks", undefined, 8, photo);
      h.cache.put(frameKey("a@1", size), { ...size, bytes: new Uint8Array(size.width * size.height * 4) });
      await h.service.show(project, photo, { mode: "blocks", widthCols: 8, look: "a@1" });
      expect(h.requests).toHaveLength(0);
    });
  });
});

describe("lookKey", () => {
  const photo = { id: "a", rotation: 0 } as CatalogPhoto;
  const step = (label: string, exposure: number) => ({ timestamp: 1, label, params: { ...freshParams(5200), exposure }, paramBag: {} });

  it("tells apart two looks on the same step, a turn, and the as-shot look", () => {
    const first = lookKey(photo, { photoId: "a", currentIndex: 1, stack: [step("Original", 0), step("Exposure", 1)] });
    const redone = lookKey(photo, { photoId: "a", currentIndex: 1, stack: [step("Original", 0), step("Exposure", 2)] });
    expect(first).not.toBe(redone);
    expect(lookKey({ ...photo, rotation: 90 }, undefined)).not.toBe(lookKey(photo, undefined));
    expect(lookKey(photo, undefined)).toBe(lookKey(photo, undefined));
  });

  it("keeps the newest frames", () => {
    const cache = createPreviewCache(2);
    const frame = { width: 1, height: 1, encoding: "rgba" as const, bytes: new Uint8Array(4) };
    cache.put("a", frame);
    cache.put("b", frame);
    cache.get("a");
    cache.put("c", frame);
    expect([cache.get("a"), cache.get("b"), cache.get("c")].map(Boolean)).toEqual([true, false, true]);
  });
});

describe("cachedPicture", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "slu-pic-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const env = (vars: Record<string, string>, stdout = true): CliEnv => ({
    cwd: "/w", userData: "/u", appRoot: "/a", electronBinary: null, appVersion: "3.3.0", platform: "linux",
    isTTY: { stdin: true, stdout, stderr: true }, env: vars,
  });
  const photo = { id: "p1" } as CatalogPhoto;
  const iterm = { TERM_PROGRAM: "iTerm.app" };

  function stored(): { previewFile: (p: CatalogPhoto) => string | null } {
    const file = join(dir, "p1.jpg");
    writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return { previewFile: () => file };
  }

  it("is the stored JPEG as an iTerm2 inline file, 28 cells wide", async () => {
    const bytes = await cachedPicture(env(iterm), 120, stored(), photo);
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe(
      "\x1b]1337;File=inline=1;size=4;width=28;preserveAspectRatio=1:/9j/2Q==\x07\n",
    );
  });

  it.each([
    ["a terminal that isn't iTerm2", env({ KITTY_WINDOW_ID: "1" }), 120],
    ["output that isn't a terminal", env(iterm, false), 120],
    ["a window under 96 columns", env(iterm), 95],
  ])("is null for %s", async (_name, e, width) => {
    expect(await cachedPicture(e, width, stored(), photo)).toBeNull();
  });

  it("is null when the app stored no preview, or the file can't be read", async () => {
    expect(await cachedPicture(env(iterm), 120, { previewFile: () => null }, photo)).toBeNull();
    expect(await cachedPicture(env(iterm), 120, { previewFile: () => join(dir, "gone.jpg") }, photo)).toBeNull();
  });
});
