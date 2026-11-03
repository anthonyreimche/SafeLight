// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { WorkerRequest, WorkerResponse } from "../render-protocol";
import { getSettings } from "@/state/settings-store";

/** Whether the worker's develop renderer exists: "starting" until the first
 *  init settles, "retrying" while a failed init is being re-attempted,
 *  "failed" once the retry budget is spent. A worker that was ready is
 *  "unresponsive" while it says nothing for long with renders waiting, until it
 *  speaks again, and "lost" from losing its graphics context until it answers
 *  the restore as it would an init. */
export type RendererAvailability = "starting" | "ready" | "retrying" | "unresponsive" | "lost" | "failed";
export type AvailabilityCallback = (availability: RendererAvailability, detail?: string) => void;

// Retry ladder for a worker whose WebGL2 context could not be created. After a
// GPU reset Chromium refuses 3D contexts to the page for a while — up to two
// minutes once resets repeat — and the crash-recovery reload lands inside that
// window, so the first init after a recovery fails although the GPU is back.
// About 2½ minutes of retries outlasts the block; a GPU that never comes back
// ends in "failed" instead of a silent, permanently grey Develop view.
const INIT_RETRY_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000, 30_000];

/** What the worker says besides answering init. */
export type WorkerAnswer = Exclude<WorkerResponse, { type: "ready" | "initError" | "contextLost" }>;

/** The worker as the bridge's parts share it. */
export interface WorkerLink {
  readonly availability: RendererAvailability;
  readonly disposed: boolean;
  /** When the worker last said anything. */
  readonly heardAt: number;
  post(msg: WorkerRequest, transfer?: Transferable[]): void;
}

/** What the transport tells the bridge. */
export interface TransportEvents {
  message(msg: WorkerAnswer): void;
  /** An init is about to go: the worker starts afresh, and builds its first
   *  program from what it holds by then. */
  beforeInit(): void;
  /** The renderer is ready: availability already says so. */
  ready(): void;
  /** No render in flight will be answered: an init failed, the worker died
   *  before its renderer was ready, or its graphics context was lost. */
  stopped(): void;
  /** The worker won't answer, or will only answer that it can't: every request
   *  waiting is settled with what a failure is answered with. */
  settlePending(): void;
  error(message: string): void;
  /** Every init failed, none of them after a lost context: this launch's
   *  graphics backend can't run Safelight's renderer, and retrying won't change that. */
  unusable(detail: string): void;
}

export class RenderTransport implements WorkerLink {
  private readonly worker: Worker;
  private readonly events: TransportEvents;
  private readyResolve: (() => void) | null = null;
  /** Settles once the worker's renderer is ready, or once the transport gives up
   *  on it (availability "failed") or is disposed: it never rejects. */
  readonly ready: Promise<void>;
  // Whether the worker's WebGL2 context has renderable float color buffers. Set
  // from the "ready" message; governs the pipeline's working precision (see
  // WebGLRenderer.colorBufferFloat). Undefined until the worker reports ready.
  pipelineFloat: boolean | undefined;
  availability: RendererAvailability = "starting";
  // Why the last init failed, while availability is "retrying" or "failed".
  private availabilityDetail: string | undefined;
  private onAvailability: AvailabilityCallback | null = null;
  private initArgs: { width: number; height: number } | null = null;
  private initAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  // The inits failing now answer a restore after a lost context.
  private restoring = false;
  disposed = false;
  heardAt = 0;

  constructor(events: TransportEvents) {
    this.events = events;
    this.worker = new Worker(
      new URL("../render-worker.ts", import.meta.url),
      { type: "module" },
    );
    this.ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    this.worker.onmessage = this.handleMessage;
    this.worker.onerror = (e) => {
      const message = e.message ?? "Worker error";
      // A working worker goes on after an uncaught throw (a stray timer callback), quiet
      // or without its context too; only one that never got its renderer going is given
      // up on.
      if (this.availability === "ready" || this.availability === "unresponsive" || this.availability === "lost") {
        this.events.error(message);
        return;
      }
      this.cancelRetry();
      this.events.stopped();
      this.giveUp(message);
      this.events.error(message);
    };
  }

  private handleMessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    this.heardAt = performance.now();
    switch (msg.type) {
      case "ready":
        this.pipelineFloat = msg.pipelineFloat;
        this.becomeReady();
        break;
      case "initError":
        this.initFailed(msg.message);
        break;
      case "contextLost":
        this.restoring = true;
        this.events.stopped();
        this.setAvailability("lost", "the graphics context was lost");
        break;
      default:
        if (this.availability === "unresponsive") this.becomeReady();
        this.events.message(msg);
    }
  };

  // A restored context's init that fails is retried as a first one would be.
  private becomeReady() {
    this.initAttempt = 0;
    this.restoring = false;
    this.setAvailability("ready");
    this.events.ready();
    this.readyResolve?.();
    this.readyResolve = null;
  }

  /** The worker has said nothing for long while renders waited for it: whoever waits
   *  is settled, and its next word makes it ready again. */
  unresponsive() {
    if (this.availability !== "ready") return;
    this.setAvailability("unresponsive", "the renderer stopped responding");
    this.settlePending();
  }

  init(width: number, height: number) {
    this.initArgs = { width, height };
    this.initAttempt = 0;
    this.restoring = false;
    this.postInit();
  }

  private postInit() {
    if (!this.initArgs) return;
    this.events.beforeInit();
    // The worker's settings-store can't reach localStorage, so read the
    // High-bit-depth preference here (main thread) and hand it across.
    this.post({ cmd: "init", ...this.initArgs, highBitDepth: getSettings().highBitDepth });
  }

  private initFailed(message: string) {
    this.events.stopped();
    const delay = this.initArgs ? INIT_RETRY_MS[this.initAttempt] : undefined;
    if (delay === undefined) {
      const first = this.availability !== "failed";
      this.giveUp(message);
      this.events.error(`renderer unavailable: ${message}`);
      if (first && !this.restoring) this.events.unusable(message);
      return;
    }
    this.initAttempt++;
    this.setAvailability("retrying", message);
    this.events.error(`renderer init failed (${message}); retrying in ${delay / 1000}s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.postInit();
    }, delay);
  }

  private giveUp(detail: string) {
    this.setAvailability("failed", detail);
    this.settlePending();
  }

  private setAvailability(availability: RendererAvailability, detail?: string) {
    this.availability = availability;
    this.availabilityDetail = detail;
    this.onAvailability?.(availability, detail);
  }

  /** Reports the current availability at once, then every change. */
  setOnAvailability(cb: AvailabilityCallback | null) {
    this.onAvailability = cb;
    cb?.(this.availability, this.availabilityDetail);
  }

  private cancelRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  // Whoever awaits `ready` or a request (an eyedropper its probe, the grid a
  // thumbnail) goes on with what a failure is answered with.
  private settlePending() {
    this.readyResolve?.();
    this.readyResolve = null;
    this.events.settlePending();
  }

  dispose() {
    this.disposed = true;
    this.cancelRetry();
    // terminate() tears down the worker (and its GL context) synchronously.
    this.worker.terminate();
    this.settlePending();
  }

  // A failed bridge has given up on its worker, which answers nothing or only that it
  // can't.
  post(msg: WorkerRequest, transfer?: Transferable[]) {
    if (this.disposed || this.availability === "failed") return;
    if (transfer) {
      this.worker.postMessage(msg, transfer);
    } else {
      this.worker.postMessage(msg);
    }
  }
}
