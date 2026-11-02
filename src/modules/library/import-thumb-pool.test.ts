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
  h.runThumbTask.mockReset();
  h.runThumbTask.mockImplementation(async () => ({ ok: false }));
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

  it("fails the in-flight tasks when a worker errors and finishes the queued one inline", async () => {
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
  });

  it("finishes queued tasks inline one at a time", async () => {
    const { processThumb, importPoolSize } = await bootPool(true);
    const size = importPoolSize();
    const finish: (() => void)[] = [];
    h.runThumbTask.mockImplementation(
      () => new Promise<ThumbTaskResult>((r) => finish.push(() => r({ ok: false }))),
    );
    const promises = Array.from({ length: size + 3 }, (_, i) =>
      processThumb(input(`p${i}.NEF`)),
    );

    FakeWorker.spawned[0].onerror?.(new Event("error"));
    await Promise.resolve();
    expect(h.runThumbTask).toHaveBeenCalledTimes(1);

    for (let done = 1; done <= 3; done++) {
      finish[done - 1]();
      await new Promise((r) => setTimeout(r, 0));
      expect(h.runThumbTask).toHaveBeenCalledTimes(Math.min(done + 1, 3));
    }
    await expect(Promise.all(promises)).resolves.toHaveLength(size + 3);
  });

  describe("after worker errors", () => {
    async function failOnce(pool: Pool, name: string): Promise<void> {
      const p = pool.processThumb(input(name));
      FakeWorker.spawned[FakeWorker.spawned.length - 1].onerror?.(new Event("error"));
      await p;
    }

    it("goes back to fresh workers after a single error", async () => {
      const pool = await bootPool(true);
      await failOnce(pool, "a.NEF");

      void pool.processThumb(input("b.NEF"));
      expect(FakeWorker.spawned).toHaveLength(2);
      expect(FakeWorker.spawned[1].posted).toHaveLength(1);
      expect(h.runThumbTask).not.toHaveBeenCalled();
    });

    it("degrades to inline once the errors keep coming", async () => {
      const pool = await bootPool(true);
      for (let i = 0; i < 3; i++) await failOnce(pool, `bad${i}.NEF`);

      await pool.processThumb(input("later.NEF"));
      expect(h.runThumbTask).toHaveBeenCalledTimes(1);
      expect(FakeWorker.spawned).toHaveLength(3); // no respawn attempts
    });

    it("counts only consecutive errors: a reply in between starts the count over", async () => {
      const pool = await bootPool(true);
      await failOnce(pool, "bad0.NEF");
      await failOnce(pool, "bad1.NEF");
      const ok = pool.processThumb(input("good.NEF"));
      FakeWorker.spawned[FakeWorker.spawned.length - 1].respond({ ok: false });
      await ok;
      await failOnce(pool, "bad2.NEF");
      await failOnce(pool, "bad3.NEF");

      void pool.processThumb(input("later.NEF"));
      expect(h.runThumbTask).not.toHaveBeenCalled();
      expect(FakeWorker.spawned[FakeWorker.spawned.length - 1].posted).toHaveLength(1);
    });
  });

  describe("a worker that never answers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("resolves ok:false after the time limit and terminates that worker", async () => {
      const { processThumb } = await bootPool(true);
      const p = processThumb(input());
      const [stalled] = FakeWorker.spawned;
      const terminate = vi.spyOn(stalled, "terminate");

      await vi.advanceTimersByTimeAsync(59_000);
      expect(terminate).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(p).resolves.toEqual({ ok: false });
      expect(terminate).toHaveBeenCalledTimes(1);
    });

    it("ignores a reply from a worker it already gave up on", async () => {
      const { processThumb } = await bootPool(true);
      for (let i = 0; i < 2; i++) {
        const p = processThumb(input(`stalled${i}.NEF`));
        await vi.advanceTimersByTimeAsync(60_000);
        await p;
      }

      FakeWorker.spawned[0].respond({ ok: false });
      expect(vi.getTimerCount()).toBe(0);

      const p = processThumb(input("stalled2.NEF"));
      await vi.advanceTimersByTimeAsync(60_000);
      await p;
      await processThumb(input("later.NEF"));
      expect(h.runThumbTask).toHaveBeenCalledTimes(1);
    });

    it("keeps no timer once the worker has answered", async () => {
      const { processThumb } = await bootPool(true);
      const p = processThumb(input());
      FakeWorker.spawned[0].respond({ ok: false });
      await p;
      expect(vi.getTimerCount()).toBe(0);
    });

    it("replaces the stalled worker, which then serves the next task", async () => {
      const { processThumb } = await bootPool(true);
      const p = processThumb(input());
      await vi.advanceTimersByTimeAsync(60_000);
      await p;

      void processThumb(input("next.NEF"));
      expect(FakeWorker.spawned).toHaveLength(2);
      expect(FakeWorker.spawned[1].posted).toHaveLength(1);
      expect(h.runThumbTask).not.toHaveBeenCalled();
    });

    it("hands a queued task to the replacement instead of leaving it waiting", async () => {
      const { processThumb, importPoolSize } = await bootPool(true);
      const size = importPoolSize();
      const promises = Array.from({ length: size + 1 }, (_, i) =>
        processThumb(input(`p${i}.NEF`)),
      );
      expect(postedCount()).toBe(size);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(postedCount()).toBe(size + 1);
      FakeWorker.spawned[FakeWorker.spawned.length - 1].respond({ ok: false });
      await expect(Promise.all(promises)).resolves.toHaveLength(size + 1);
    });
  });
});
