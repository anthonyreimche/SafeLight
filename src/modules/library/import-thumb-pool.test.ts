// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Pool bookkeeping only — the task itself is mocked. Fake workers make the
// interesting states real: buffers transferred, slots reused, tasks queued
// past the cap, and the degrade-to-inline path when a worker dies.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ThumbTaskInput, ThumbTaskResult } from "./import-thumb-task";

const h = vi.hoisted(() => ({
  runThumbTask: vi.fn(async (): Promise<ThumbTaskResult> => ({ ok: false })),
}));

vi.mock("./import-thumb-task", () => ({ runThumbTask: h.runThumbTask }));

type Pool = typeof import("./import-thumb-pool");

class FakeWorker {
  static spawned: FakeWorker[] = [];
  onmessage: ((e: { data: ThumbTaskResult }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  posted: { msg: ThumbTaskInput; transfer?: Transferable[] }[] = [];
  constructor() {
    FakeWorker.spawned.push(this);
  }
  postMessage(msg: ThumbTaskInput, transfer?: Transferable[]) {
    this.posted.push({ msg, transfer });
  }
  terminate() {}
  respond(result: ThumbTaskResult) {
    this.onmessage?.({ data: result });
  }
}

const postedCount = () =>
  FakeWorker.spawned.reduce((n, w) => n + w.posted.length, 0);

function input(name = "a.NEF"): ThumbTaskInput {
  return {
    buffer: new ArrayBuffer(8),
    name,
    type: "",
    lastModified: 1,
    orientation: undefined,
    previewSource: "auto",
    thumbMaxEdge: 640,
  };
}

async function bootPool(withWorkers: boolean): Promise<Pool> {
  FakeWorker.spawned = [];
  if (withWorkers) vi.stubGlobal("Worker", FakeWorker);
  vi.resetModules();
  return import("./import-thumb-pool");
}

beforeEach(() => {
  h.runThumbTask.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("processThumb", () => {
  it("runs inline when workers are unavailable", async () => {
    const { processThumb } = await bootPool(false);
    const r = await processThumb(input());
    expect(r).toEqual({ ok: false });
    expect(h.runThumbTask).toHaveBeenCalledTimes(1);
  });

  it("dispatches to a worker, transferring the buffer, and resolves its reply", async () => {
    const { processThumb } = await bootPool(true);
    const i = input();
    const p = processThumb(i);
    expect(FakeWorker.spawned).toHaveLength(1);
    const [w] = FakeWorker.spawned;
    expect(w.posted[0].msg.name).toBe("a.NEF");
    expect(w.posted[0].transfer).toEqual([i.buffer]);

    const thumb = new Blob(["t"]);
    w.respond({ ok: true, thumb, width: 100, height: 50 });
    await expect(p).resolves.toEqual({ ok: true, thumb, width: 100, height: 50 });
    expect(h.runThumbTask).not.toHaveBeenCalled();
  });

  it("reuses an idle worker instead of spawning another", async () => {
    const { processThumb } = await bootPool(true);
    const p1 = processThumb(input());
    FakeWorker.spawned[0].respond({ ok: false });
    await p1;
    void processThumb(input("b.NEF"));
    expect(FakeWorker.spawned).toHaveLength(1);
    expect(FakeWorker.spawned[0].posted).toHaveLength(2);
  });

  it("queues past the pool cap and drains as workers free up", async () => {
    const { processThumb, importPoolSize } = await bootPool(true);
    const size = importPoolSize();
    const promises = Array.from({ length: size + 1 }, (_, i) =>
      processThumb(input(`p${i}.NEF`)),
    );
    expect(FakeWorker.spawned).toHaveLength(size);
    expect(postedCount()).toBe(size); // the extra task waits

    FakeWorker.spawned[0].respond({ ok: false });
    expect(postedCount()).toBe(size + 1); // freed slot picked it up
    FakeWorker.spawned.forEach((w) => w.respond({ ok: false }));
    await expect(Promise.all(promises)).resolves.toBeDefined();
  });

  it("degrades to inline for everything once a worker errors", async () => {
    const { processThumb, importPoolSize } = await bootPool(true);
    const size = importPoolSize();
    const promises = Array.from({ length: size + 1 }, (_, i) =>
      processThumb(input(`p${i}.NEF`)),
    );

    FakeWorker.spawned[0].onerror?.(new Event("error"));
    // In-flight tasks lost their transferred buffers — they resolve ok:false;
    // the queued task still owns its buffer and completes inline.
    const results = await Promise.all(promises);
    expect(results.slice(0, size)).toEqual(
      Array.from({ length: size }, () => ({ ok: false })),
    );
    expect(h.runThumbTask).toHaveBeenCalledTimes(1);

    await processThumb(input("later.NEF"));
    expect(h.runThumbTask).toHaveBeenCalledTimes(2);
    expect(FakeWorker.spawned).toHaveLength(size); // no respawn attempts
  });
});
