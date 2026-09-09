// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The bridge's recovery from a worker that cannot create its WebGL2 context.
// After a GPU reset Chromium refuses 3D contexts to the page for a while, and
// the crash-recovery reload lands inside that window: the first init fails
// although the GPU is back. Before this, `ready` never settled and Develop
// stayed grey until the app was restarted (SafeLight #96, round 5).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderBridge } from "./render-bridge";
import type { WorkerRequest, WorkerResponse } from "./render-worker";

class FakeWorker {
  static instances: FakeWorker[] = [];
  posted: WorkerRequest[] = [];
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(msg: WorkerRequest) {
    this.posted.push(msg);
  }

  terminate() {
    this.terminated = true;
  }

  reply(msg: WorkerResponse) {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>);
  }
}

const inits = (worker: FakeWorker) => worker.posted.filter((m) => m.cmd === "init");
const initError: WorkerResponse = { type: "initError", message: "WebGL2 not supported" };

describe("RenderBridge init recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries init with growing delays until the worker reports ready", async () => {
    const bridge = new RenderBridge();
    const seen: string[] = [];
    bridge.setOnAvailability((availability) => seen.push(availability));
    const errors: string[] = [];
    bridge.setOnError((message) => errors.push(message));
    bridge.init(64, 64);
    const worker = FakeWorker.instances[0];
    expect(inits(worker)).toHaveLength(1);

    worker.reply(initError);
    expect(bridge.availability).toBe("retrying");
    expect(errors[0]).toContain("WebGL2 not supported");
    vi.advanceTimersByTime(999);
    expect(inits(worker)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(inits(worker)).toHaveLength(2);

    worker.reply(initError);
    vi.advanceTimersByTime(1999);
    expect(inits(worker)).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(inits(worker)).toHaveLength(3);
    expect(inits(worker)[2]).toMatchObject({ cmd: "init", width: 64, height: 64 });

    let ready = false;
    void bridge.ready.then(() => {
      ready = true;
    });
    worker.reply({ type: "ready", pipelineFloat: true });
    await Promise.resolve();
    expect(ready).toBe(true);
    expect(bridge.pipelineFloat).toBe(true);
    expect(bridge.availability).toBe("ready");
    expect(seen).toEqual(["starting", "retrying", "retrying", "ready"]);
    bridge.dispose();
  });

  it("gives up after the retry budget and reports failed", () => {
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    bridge.init(64, 64);
    const worker = FakeWorker.instances[0];
    for (let i = 0; i < 20; i++) {
      worker.reply(initError);
      vi.advanceTimersByTime(60_000);
    }
    expect(bridge.availability).toBe("failed");
    const attempts = inits(worker).length;
    expect(attempts).toBe(10);
    vi.advanceTimersByTime(600_000);
    expect(inits(worker)).toHaveLength(attempts);
    bridge.dispose();
  });

  it("keeps retrying for long enough to outlast Chromium's two-minute block", () => {
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    bridge.init(64, 64);
    const worker = FakeWorker.instances[0];
    // Fail every attempt and let the bridge's own timers pace the next one;
    // the simulated time until it gives up is the window it covers.
    const gaveUp = () => bridge.availability === "failed";
    let elapsed = 0;
    for (;;) {
      worker.reply(initError);
      if (gaveUp()) break;
      const before = inits(worker).length;
      while (inits(worker).length === before) {
        vi.advanceTimersByTime(1_000);
        elapsed += 1_000;
      }
    }
    expect(elapsed).toBeGreaterThanOrEqual(150_000);
    bridge.dispose();
  });

  it("stops retrying once disposed", () => {
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    bridge.init(64, 64);
    const worker = FakeWorker.instances[0];
    worker.reply(initError);
    bridge.dispose();
    vi.advanceTimersByTime(600_000);
    expect(inits(worker)).toHaveLength(1);
    expect(worker.terminated).toBe(true);
  });

  it("reports the current availability to a late subscriber", () => {
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    bridge.init(64, 64);
    FakeWorker.instances[0].reply(initError);
    const seen: string[] = [];
    bridge.setOnAvailability((availability) => seen.push(availability));
    expect(seen).toEqual(["retrying"]);
    bridge.dispose();
  });
});
