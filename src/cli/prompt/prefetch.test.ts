import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineRequest } from "@/engine/protocol";
import type { EngineClient } from "../engine-client";
import { previewFrameSize } from "../preview";
import { catalogueStamp, createPreviewCache, frameKey, lookKey } from "../preview-cache";
import type { CliEnv } from "../types";
import { createPrefetcher, PICTURE_COLUMNS, prefetchPreview, type PrefetchJob } from "./prefetch";

/** A job that renders until it is stopped, and says when it ended. */
function hanging(log: string[], name: string): PrefetchJob {
  return (signal) => new Promise((resolve) => {
    log.push(`start ${name}`);
    signal.addEventListener("abort", () => {
      log.push(`stopped ${name}`);
      resolve(null);
    });
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("prefetch", () => {
  it("stops the running job and resolves once it has let go", async () => {
    const log: string[] = [];
    const prefetch = createPrefetcher();
    prefetch.start(hanging(log, "b"));
    await tick();
    await prefetch.stop();
    log.push("command runs");
    expect(log).toEqual(["start b", "stopped b", "command runs"]);
  });

  it("stops the job before it starts the next", async () => {
    const log: string[] = [];
    const prefetch = createPrefetcher();
    prefetch.start(hanging(log, "b"));
    await tick();
    prefetch.start(hanging(log, "c"));
    await tick();
    expect(log).toEqual(["start b", "stopped b", "start c"]);
    await prefetch.stop();
  });

  it("doesn't render a photo at a step it already rendered", async () => {
    const asked: boolean[] = [];
    const prefetch = createPrefetcher();
    const job: PrefetchJob = async (_signal, already) => {
      asked.push(already("p1@2/3"));
      return "p1@2/3";
    };
    prefetch.start(job);
    await tick();
    prefetch.start(job);
    await tick();
    await prefetch.stop();
    expect(asked).toEqual([false, true]);
  });

  it("forgets nothing for a job that was stopped or failed", async () => {
    const asked: boolean[] = [];
    const prefetch = createPrefetcher();
    prefetch.start(async () => { throw new Error("engine gone"); });
    await tick();
    prefetch.start(async (_signal, already) => { asked.push(already("p1@1/1")); return null; });
    await tick();
    await prefetch.stop();
    expect(asked).toEqual([false]);
  });
});

describe("prefetchPreview", () => {
  let temp: string;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "slu-prefetch-"));
    fs.mkdirSync(path.join(temp, "shoot", ".safelight"), { recursive: true });
    fs.mkdirSync(path.join(temp, "profile"));
    fs.writeFileSync(path.join(temp, "shoot", "a.ARW"), "A");
    const photo = { id: "a", filename: "a.ARW", relPath: "a.ARW", folder: "", width: 600, height: 400, fileSize: 1, mimeType: "image/x-sony-arw", rating: 0, colorLabel: "none", flag: "none", rotation: 0, keywords: [], dateCreated: 1, dateImported: 2, exif: {} };
    fs.writeFileSync(path.join(temp, "shoot", ".safelight", "catalog.json"), JSON.stringify({ version: 2, id: "c", photos: [photo], edits: [], removed: [] }));
    vi.stubGlobal("BroadcastChannel", class { postMessage() {} addEventListener() {} removeEventListener() {} close() {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const env = (): CliEnv => ({
    cwd: path.join(temp, "shoot"), userData: path.join(temp, "profile"), appRoot: "/app", electronBinary: null, appVersion: "3", platform: process.platform,
    isTTY: { stdin: true, stdout: true, stderr: true }, env: {},
  });

  function engine(requests: EngineRequest[]): EngineClient {
    return {
      async *request(req) {
        requests.push(req);
        if (req.type !== "preview") return;
        yield { id: req.id, type: "frame", frame: 1, width: req.width, height: req.height, encoding: req.encoding };
        yield { frame: 1, bytes: new Uint8Array(req.width * req.height * 4) };
        yield { id: req.id, type: "done" };
      },
      shutdown: async () => {},
    };
  }

  it("keeps the frame the next preview of that photo asks for, so showing it needs no engine", async () => {
    const requests: EngineRequest[] = [];
    const cache = createPreviewCache();
    cache.drawnAs = { mode: "blocks" };
    const abs = path.join(temp, "shoot", "a.ARW");
    const key = await prefetchPreview(env(), abs, engine(requests), new AbortController().signal, cache);
    const size = previewFrameSize("blocks", undefined, PICTURE_COLUMNS, { rotation: 0, width: 600, height: 400 });
    const catalogue = await catalogueStamp(path.join(temp, "shoot", ".safelight"));
    expect(catalogue).toBeDefined();
    expect(requests).toMatchObject([{ type: "preview", photoId: "a", ...size, catalogue }]);
    expect(key).toBe(frameKey(lookKey({ id: "a", rotation: 0 }, undefined), size, catalogue));
    expect(cache.get(key ?? "")).toMatchObject(size);
    expect(await prefetchPreview(env(), abs, engine(requests), new AbortController().signal, cache)).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("renders nothing before a picture has been shown, since it can't know how it will be drawn", async () => {
    const requests: EngineRequest[] = [];
    expect(await prefetchPreview(env(), path.join(temp, "shoot", "a.ARW"), engine(requests), new AbortController().signal, createPreviewCache())).toBeNull();
    expect(requests).toEqual([]);
  });
});
