// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerRequest, WorkerResponse } from "../render-protocol";
import { RenderTransport, type TransportEvents } from "./transport";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(_msg: WorkerRequest) {}

  terminate() {}

  reply(msg: WorkerResponse) {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>);
  }
}

function events(): TransportEvents & { unusable: ReturnType<typeof vi.fn<(detail: string) => void>> } {
  return {
    message: () => undefined,
    beforeInit: () => undefined,
    ready: () => undefined,
    stopped: () => undefined,
    settlePending: () => undefined,
    error: () => undefined,
    unusable: vi.fn<(detail: string) => void>(),
  };
}

const stockFailed: WorkerResponse = { type: "initError", message: "stock program failed to link" };

// Fails every init the transport sends until it gives up.
function failUntilGivenUp(transport: RenderTransport, worker: FakeWorker) {
  for (let i = 0; i < 20 && transport.availability !== "failed"; i++) {
    worker.reply(stockFailed);
    vi.advanceTimersByTime(60_000);
  }
}

// A machine that makes a WebGL2 context but can't build Safelight's own shader
// fails every init the same way; the launch's graphics backend has to change.
describe("RenderTransport giving up on the renderer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("says the renderer is unusable, once, when the init retries run out", () => {
    const ev = events();
    const transport = new RenderTransport(ev);
    transport.init(64, 64);
    const worker = FakeWorker.instances[0];
    for (let i = 0; i < 9; i++) {
      worker.reply(stockFailed);
      vi.advanceTimersByTime(60_000);
    }
    expect(transport.availability).toBe("retrying");
    expect(ev.unusable).not.toHaveBeenCalled();
    worker.reply(stockFailed);
    expect(transport.availability).toBe("failed");
    expect(ev.unusable.mock.calls).toEqual([["stock program failed to link"]]);
    worker.reply(stockFailed);
    vi.advanceTimersByTime(600_000);
    expect(ev.unusable).toHaveBeenCalledTimes(1);
    transport.dispose();
  });

  // A lost context is the GPU process's to recover; main's crash handling owns it.
  it("leaves a restore after a lost context that keeps failing to the crash handling", () => {
    const ev = events();
    const transport = new RenderTransport(ev);
    transport.init(64, 64);
    const worker = FakeWorker.instances[0];
    worker.reply({ type: "ready", pipelineFloat: true });
    worker.reply({ type: "contextLost" });
    failUntilGivenUp(transport, worker);
    expect(transport.availability).toBe("failed");
    expect(ev.unusable).not.toHaveBeenCalled();
    transport.dispose();
  });

  it("doesn't call a worker that died before its renderer was ready unusable", () => {
    const ev = events();
    const transport = new RenderTransport(ev);
    transport.init(64, 64);
    FakeWorker.instances[0].onerror?.({ message: "boom" } as ErrorEvent);
    expect(transport.availability).toBe("failed");
    expect(ev.unusable).not.toHaveBeenCalled();
    transport.dispose();
  });
});
