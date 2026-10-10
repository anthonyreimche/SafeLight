// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams, UprightMode } from "@/catalog/types";
import type { UprightResult } from "./upright";
import type { ProcessingStageContribution, StageTextureData } from "@/extensions/types";
import type { ResolvedPipeline } from "@/extensions/pipelines";
import { resolvePipelineFor, usePipelineStore } from "@/extensions/pipelines";
import { onStagesReleased, useRegistry } from "@/extensions/registry";
import type { HistogramData } from "./histogram";
import type { WorkerRequest, WorkerResponse } from "./render-worker";
import { getSettings, useSettings } from "@/state/settings-store";

export interface FrameResult {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** The size the renderer holds the source this frame was drawn from at. */
  sourceWidth: number;
  sourceHeight: number;
  /** The number of that source; see RenderBridge.sourceGen. */
  sourceGen: number;
  histogram?: HistogramData;
}

export interface ThumbnailResult {
  requestId: string;
  blob: Blob;
}

type FrameCallback = (frame: FrameResult) => void;
type HistogramCallback = (histogram: HistogramData) => void;
type ThumbnailCallback = (result: ThumbnailResult) => void;
type UprightCallback = (result: UprightResult) => void;
type ErrorCallback = (message: string) => void;
/** The number (RenderBridge.sourceGen) of a develop source the worker couldn't take. */
type SourceErrorCallback = (sourceGen: number) => void;
/** Whether the worker's develop renderer exists: "starting" until the first
 *  init settles, "retrying" while a failed init is being re-attempted,
 *  "failed" once the retry budget is spent. */
export type RendererAvailability = "starting" | "ready" | "retrying" | "failed";
type AvailabilityCallback = (availability: RendererAvailability, detail?: string) => void;

// Retry ladder for a worker whose WebGL2 context could not be created. After a
// GPU reset Chromium refuses 3D contexts to the page for a while — up to two
// minutes once resets repeat — and the crash-recovery reload lands inside that
// window, so the first init after a recovery fails although the GPU is back.
// About 2½ minutes of retries outlasts the block; a GPU that never comes back
// ends in "failed" instead of a silent, permanently grey Develop view.
const INIT_RETRY_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000, 30_000];
// A render the worker hasn't answered in this long is given up on, so a reply that
// never comes can't hold the next render back for good. A worker drawing a heavy photo
// says nothing until each render is done, as one that stopped does, so once one of its
// last RENDER_TIMES_KEPT answers took longer, it gets SLOW_RENDER_ALLOWANCE times the
// slowest of them instead.
const RENDER_WATCHDOG_MS = 2_000;
const RENDER_TIMES_KEPT = 8;
const SLOW_RENDER_ALLOWANCE = 3;
// While a render given up on may still be answered, the one sent after it isn't timed:
// the worker may only be slow. One that says nothing at all for this long has stopped,
// or lost both answers, and gets the newest request anyway.
const RENDER_BACKSTOP_MS = 30_000;
type HealSourceCallback = (src: { data: Uint8ClampedArray; width: number; height: number }) => void;
/** What the render waiting in the mailbox asks for besides the frame. */
interface WaitingRender {
  wantHistogram: boolean;
  wantExtended: boolean;
}

/** The top-level fields of `next` that `last` lacks or holds another value in, each the
 *  very value `next` holds. */
function changedFields<T extends object>(last: T, next: T): Partial<T> {
  const set: Partial<T> = {};
  for (const key in next) {
    if (!Object.hasOwn(last, key) || !Object.is(last[key], next[key])) set[key] = next[key];
  }
  return set;
}

export class RenderBridge {
  private worker: Worker;
  private readyResolve: (() => void) | null = null;
  readonly ready: Promise<void>;
  // Whether the worker's WebGL2 context has renderable float color buffers. Set
  // from the "ready" message; governs the pipeline's working precision (see
  // WebGLRenderer.colorBufferFloat). Undefined until ready resolves.
  pipelineFloat: boolean | undefined;
  private onFrame: FrameCallback | null = null;
  private onHistogram: HistogramCallback | null = null;
  private onThumbnail: ThumbnailCallback | null = null;
  private onUpright: UprightCallback | null = null;
  private onError: ErrorCallback | null = null;
  private onSourceError: SourceErrorCallback | null = null;
  private onHealSource: HealSourceCallback | null = null;
  private onAvailability: AvailabilityCallback | null = null;
  availability: RendererAvailability = "starting";
  private initArgs: { width: number; height: number } | null = null;
  private initAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  // Resolves with the rendered blob, or null when the worker reports a cache miss
  // (the caller then decodes + uploads + retries).
  private thumbResolvers = new Map<string, (blob: Blob | null) => void>();
  private uprightResolvers = new Map<number, (result: UprightResult) => void>();
  private sourceBoundResolvers = new Map<number, (hit: boolean) => void>();
  private hasSourceResolvers = new Map<number, (has: boolean) => void>();
  private captureResolvers = new Map<number, (bitmap: ImageBitmap) => void>();
  private reqIdSeq = 0;
  // The live photo's display-transform pick, mirrored from the params the
  // develop view sends, so the live pipeline follows the photo and can be
  // re-resolved when the registry or the Preferences default changes.
  private liveDisplayTransform: string | null = null;
  private livePipelineSent = false;
  // The params last handed to the worker, whole or by patches. A fresh renderer has seen
  // none.
  private lastPostedParams: DevelopParams | null = null;
  // The param bag last handed to the worker, whole or by patches. A fresh renderer has
  // seen none.
  private lastPostedBag: Record<string, unknown> | null = null;
  // The render mailbox: the seq of the one render the worker is drawing, and the newest
  // request made since, which goes when that one is answered. The worker draws renders
  // in the order they come, so posting each request while it is slower than the display
  // queues a backlog the view plays back after the user lets go.
  private renderSeq = 0;
  private renderInFlight: number | null = null;
  // When the render in flight started to be timed: its post, or `ready` for one posted
  // before it. null while it isn't timed.
  private renderSince: number | null = null;
  private renderWatchdog: ReturnType<typeof setTimeout> | null = null;
  private renderWaiting: WaitingRender | null = null;
  // The render last given up on while its answer may still come. The worker draws renders
  // in order, so until it answers that one or the one sent after it, another render sent
  // would only queue behind them.
  private renderOverdue: { seq: number; since: number } | null = null;
  // How long, in ms, the worker took over each of its last answers.
  private renderTimes: number[] = [];
  private renderBackstop: ReturnType<typeof setTimeout> | null = null;
  // When the worker last said anything, or the backstop last sent a render.
  private quietSince = 0;
  private sourcesBound = 0;

  constructor() {
    this.worker = new Worker(
      new URL("./render-worker.ts", import.meta.url),
      { type: "module" },
    );
    this.ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    this.worker.onmessage = this.handleMessage;
    this.worker.onerror = (e) => {
      this.onError?.(e.message ?? "Worker error");
    };
  }

  private handleMessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    this.quietSince = performance.now();
    switch (msg.type) {
      case "ready":
        this.pipelineFloat = msg.pipelineFloat;
        this.setAvailability("ready");
        this.armRenderWatchdog();
        this.readyResolve?.();
        this.readyResolve = null;
        break;
      case "initError": {
        this.clearRenderMailbox();
        const delay = this.initArgs ? INIT_RETRY_MS[this.initAttempt] : undefined;
        if (delay === undefined) {
          this.setAvailability("failed", msg.message);
          this.onError?.(`renderer unavailable: ${msg.message}`);
          break;
        }
        this.initAttempt++;
        this.setAvailability("retrying", msg.message);
        this.onError?.(`renderer init failed (${msg.message}); retrying in ${delay / 1000}s`);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.postInit();
        }, delay);
        break;
      }
      case "frame":
        this.renderAnswered(msg.seq);
        // No view listens (Develop closed, or between one photo's view and the
        // next's): nothing will close the bitmap, which holds a decoded image.
        if (!this.onFrame) {
          msg.bitmap.close();
          break;
        }
        // Drawn even when the mailbox no longer waits for it (given up on, or from
        // before a re-init): it is still newer than what the view shows.
        this.onFrame({
          bitmap: msg.bitmap,
          width: msg.width,
          height: msg.height,
          sourceWidth: msg.sourceWidth,
          sourceHeight: msg.sourceHeight,
          sourceGen: msg.sourceGen,
          histogram: msg.histogram,
        });
        break;
      case "frameSkipped":
        this.renderAnswered(msg.seq);
        break;
      case "renderError":
        this.renderAnswered(msg.seq);
        this.onError?.(`render failed: ${msg.message}`);
        break;
      case "sourceError":
        this.onSourceError?.(msg.sourceGen);
        this.onError?.(`source failed: ${msg.message}`);
        break;
      case "histogram":
        this.onHistogram?.(msg.histogram);
        break;
      case "thumbnail": {
        const resolver = this.thumbResolvers.get(msg.requestId);
        if (resolver) {
          this.thumbResolvers.delete(msg.requestId);
          resolver(msg.blob);
        }
        this.onThumbnail?.({ requestId: msg.requestId, blob: msg.blob });
        break;
      }
      case "thumbnailMiss": {
        const resolver = this.thumbResolvers.get(msg.requestId);
        if (resolver) {
          this.thumbResolvers.delete(msg.requestId);
          resolver(null);
        }
        break;
      }
      case "thumbnailError": {
        // Reject the pending request (resolver(null) -> renderThumbnailAsync
        // rejects) so the caller stops awaiting and can retry on the next edit,
        // then surface the underlying cause for diagnosis.
        const resolver = this.thumbResolvers.get(msg.requestId);
        if (resolver) {
          this.thumbResolvers.delete(msg.requestId);
          resolver(null);
        }
        this.onError?.(`thumbnail render failed: ${msg.message}`);
        break;
      }
      case "sourceBound": {
        if (msg.hit) this.sourcesBound++;
        const resolver = this.sourceBoundResolvers.get(msg.reqId);
        if (resolver) {
          this.sourceBoundResolvers.delete(msg.reqId);
          resolver(msg.hit);
        }
        break;
      }
      case "hasSource": {
        const resolver = this.hasSourceResolvers.get(msg.reqId);
        if (resolver) {
          this.hasSourceResolvers.delete(msg.reqId);
          resolver(msg.has);
        }
        break;
      }
      case "captured": {
        const resolver = this.captureResolvers.get(msg.reqId);
        if (resolver) {
          this.captureResolvers.delete(msg.reqId);
          resolver(msg.bitmap);
        }
        break;
      }
      case "upright": {
        const resolver = this.uprightResolvers.get(msg.reqId);
        if (resolver) {
          this.uprightResolvers.delete(msg.reqId);
          resolver(msg.result);
        }
        this.onUpright?.(msg.result);
        break;
      }
      case "uprightError": {
        // Settle the pending computeUpright with a zero (no-op) result so the
        // awaiting caller unblocks instead of hanging, then surface the cause.
        const resolver = this.uprightResolvers.get(msg.reqId);
        if (resolver) {
          this.uprightResolvers.delete(msg.reqId);
          resolver({ straighten: 0, perspectiveV: 0, perspectiveH: 0 });
        }
        this.onError?.(`upright analysis failed: ${msg.message}`);
        break;
      }
      case "healSource":
        this.onHealSource?.({ data: msg.data, width: msg.width, height: msg.height });
        break;
      case "error":
        // Not tied to a request, so per-request resolvers can't be settled from
        // here; each request path posts its own settling response on failure.
        this.onError?.(msg.message);
        break;
    }
  };

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  init(width: number, height: number) {
    this.initArgs = { width, height };
    this.initAttempt = 0;
    this.postInit();
  }

  private postInit() {
    if (!this.initArgs) return;
    this.lastPostedParams = null;
    this.lastPostedBag = null;
    this.clearRenderMailbox();
    // The worker builds its first develop program while it handles init, from the
    // stages and pipeline it holds by then, so the current ones go first: on a
    // retry too, since either may have changed while the last init was failing.
    this.syncStages();
    this.syncPipeline();
    // The worker's settings-store can't reach localStorage, so read the
    // High-bit-depth preference here (main thread) and hand it across.
    this.post({ cmd: "init", ...this.initArgs, highBitDepth: getSettings().highBitDepth });
  }

  private setAvailability(availability: RendererAvailability, detail?: string) {
    this.availability = availability;
    this.onAvailability?.(availability, detail);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.clearRenderMailbox();
    // terminate() tears down the worker (and its GL context) synchronously; a
    // "dispose" message would be preempted by it, so don't bother sending one.
    this.worker.terminate();
  }

  // ------------------------------------------------------------------
  // Callbacks
  // ------------------------------------------------------------------

  setOnFrame(cb: FrameCallback | null) { this.onFrame = cb; }
  setOnHistogram(cb: HistogramCallback | null) { this.onHistogram = cb; }
  setOnThumbnail(cb: ThumbnailCallback | null) { this.onThumbnail = cb; }
  setOnUpright(cb: UprightCallback | null) { this.onUpright = cb; }
  setOnError(cb: ErrorCallback | null) { this.onError = cb; }
  setOnSourceError(cb: SourceErrorCallback | null) { this.onSourceError = cb; }
  setOnHealSource(cb: HealSourceCallback | null) { this.onHealSource = cb; }
  /** Reports the current availability at once, then every change. */
  setOnAvailability(cb: AvailabilityCallback | null) {
    this.onAvailability = cb;
    cb?.(this.availability);
  }

  // ------------------------------------------------------------------
  // Image data
  // ------------------------------------------------------------------

  /** The develop view moved to another photo: the worker draws no frame and measures
   *  no histogram until that photo's source is set or bound. */
  clearSource() {
    this.post({ cmd: "clearSource" });
  }

  /** The number the worker's frames carry for the develop source handed over last: it
   *  counts each setImage and each main uploadSource that binds, once it is posted, and
   *  each bindSource hit, as it is answered. So read it after awaiting bindSource, and bind
   *  nothing else while one is unanswered: the worker counts that hit first. */
  get sourceGen(): number {
    return this.sourcesBound;
  }

  setImage(
    image:
      | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
      | { kind: "float16"; data: Uint16Array; width: number; height: number }
      | { kind: "bitmap"; bitmap: ImageBitmap },
    maxEdge?: number,
    isFallbackPreview?: boolean,
    baseCurveForBitmap?: boolean,
  ) {
    const transfer = [image.kind === "bitmap" ? image.bitmap : image.data.buffer];
    this.post(
      { cmd: "setImage", image, maxEdge, isFallbackPreview, baseCurveForBitmap },
      transfer,
    );
    this.sourcesBound++;
  }

  // ------------------------------------------------------------------
  // GPU source cache
  // ------------------------------------------------------------------

  /** Bind a resident source as the develop renderer's active image. Resolves
   *  true on a cache hit, false if the caller must decode + uploadSource. */
  bindSource(key: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const reqId = ++this.reqIdSeq;
      this.sourceBoundResolvers.set(reqId, resolve);
      this.post({ cmd: "bindSource", reqId, key });
    });
  }

  uploadSource(
    target: "main" | "thumb",
    key: string,
    image:
      | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
      | { kind: "float16"; data: Uint16Array; width: number; height: number }
      | { kind: "bitmap"; bitmap: ImageBitmap },
    maxEdge?: number,
    isFallbackPreview?: boolean,
    baseCurveForBitmap?: boolean,
    // false = upload into the cache without changing the active source (prefetch).
    bind = true,
  ) {
    const transfer = [image.kind === "bitmap" ? image.bitmap : image.data.buffer];
    this.post(
      { cmd: "uploadSource", target, key, image, maxEdge, isFallbackPreview, baseCurveForBitmap, bind },
      transfer,
    );
    if (bind && target === "main") this.sourcesBound++;
  }

  /** Is a source already resident in the given renderer's cache? */
  hasSource(target: "main" | "thumb", key: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const reqId = ++this.reqIdSeq;
      this.hasSourceResolvers.set(reqId, resolve);
      this.post({ cmd: "hasSource", reqId, target, key });
    });
  }

  setCacheBudget(bytes: number) {
    this.post({ cmd: "setCacheBudget", bytes });
  }

  setViewport(
    roi: { x: number; y: number; w: number; h: number } | null,
    outW?: number,
    outH?: number,
  ) {
    this.post({ cmd: "setViewport", roi, outW, outH });
  }

  // Render a thumbnail from a resident source. Resolves null on a cache miss so
  // the caller can decode + uploadSource("thumb", …) and retry.
  renderThumbnailFromSource(opts: {
    requestId: string;
    key: string;
    params: DevelopParams;
    asShotTemperature: number;
    maxEdge: number;
    quality?: number;
    // Per-render extension-stage params; the thumb renderer applies these for
    // this render only, so a photo other than the live develop one renders with
    // its own stage params rather than the active photo's.
    contributedParams?: Record<string, unknown>;
  }): Promise<Blob | null> {
    return new Promise<Blob | null>((resolve) => {
      this.thumbResolvers.set(opts.requestId, resolve);
      this.post({
        cmd: "renderThumbnailFromSource",
        ...opts,
        pipeline: resolvePipelineFor(opts.params.displayTransform),
      });
    });
  }

  // ------------------------------------------------------------------
  // Parameters
  // ------------------------------------------------------------------

  /** The live photo's params. Posting structured-clones every brush dab, and the
   *  worker's renderer signs the masks and retouch again whenever they are not the
   *  arrays it drew last, so only the difference from the params last posted goes: the
   *  top-level fields that are new or not the same value, and the keys dropped. The
   *  first params, and the first after an init, go whole. Callers replace `params`,
   *  and each field in it, on change and never mutate one in place. */
  setParams(params: DevelopParams) {
    if (!this.livePipelineSent || params.displayTransform !== this.liveDisplayTransform) {
      this.liveDisplayTransform = params.displayTransform;
      this.syncPipeline();
    }
    const last = this.lastPostedParams;
    if (params === last) return;
    if (!last) {
      this.post({ cmd: "setParams", params });
    } else {
      const set = changedFields(last, params);
      const remove = Object.keys(last).filter((key) => !Object.hasOwn(params, key));
      if (remove.length === 0 && Object.keys(set).length === 0) return;
      this.post({ cmd: "patchParams", set, remove });
    }
    this.lastPostedParams = params;
  }

  /** Generic param bag for extension-contributed processing-stage uniforms,
   *  keyed by qualified key "{stageId}.{key}". Pushed to both the develop and
   *  thumbnail renderers in the worker. Posting clones every value, brush dabs
   *  included, into objects the renderer then bakes coverage from again, and the
   *  Develop view offers a bag on every change, so only the difference from the last
   *  bag posted goes: the entries that are new or not the same value, and the keys
   *  dropped. The first bag, and the first after an init, goes whole. Callers replace
   *  the bag and the values in it on change and never mutate them. */
  setContributedParams(bag: Record<string, unknown>) {
    const last = this.lastPostedBag;
    if (!last) {
      this.post({ cmd: "setContributedParams", bag });
    } else {
      const set = changedFields(last, bag);
      const remove = Object.keys(last).filter((key) => !Object.hasOwn(bag, key));
      if (remove.length === 0 && Object.keys(set).length === 0) return;
      this.post({ cmd: "patchContributedParams", set, remove });
    }
    this.lastPostedBag = bag;
  }

  /** Pixel data (baked LUT atlases, etc.) for processing-stage textures, keyed
   *  by qualified key "{stageId}.{key}". Structured-cloned to the worker (not
   *  transferred) so the caller keeps its buffers and can re-push on a swap. */
  setStageTextures(bag: Record<string, StageTextureData>) {
    this.post({ cmd: "setStageTextures", bag });
  }

  /** Render one frame with `params` (at the current source + viewport) to an
   *  ImageBitmap, without touching the live display. Used to grab a "before"
   *  frame for before/after comparison overlays. The live params are restored
   *  in the worker afterwards. */
  capture(params: DevelopParams): Promise<ImageBitmap> {
    return new Promise<ImageBitmap>((resolve) => {
      const reqId = ++this.reqIdSeq;
      this.captureResolvers.set(reqId, resolve);
      this.post({ cmd: "capture", reqId, params, pipeline: resolvePipelineFor(params.displayTransform) });
    });
  }

  setAsShotTemperature(kelvin: number) {
    this.post({ cmd: "setAsShotTemperature", kelvin });
  }

  /** Global HSL band shaping (Preferences ▸ HSL): range scales band widths,
   *  smooth blends the falloff. Applies to the live develop renderer. */
  setHslStyle(range: number, smooth: number) {
    this.post({ cmd: "setHslStyle", range, smooth });
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  /** Draw a frame of the state the worker holds. While one is in flight only the
   *  newest request waits, asking for every histogram the requests it replaced asked
   *  for, and goes once the worker answers. Messages that set state still go at once,
   *  so the worker has them before the render that waits. */
  render(wantHistogram = false, wantExtended = false) {
    if (this.disposed) return;
    if (this.renderInFlight === null) {
      this.postRender({ wantHistogram, wantExtended });
      return;
    }
    const waiting = this.renderWaiting;
    this.renderWaiting = {
      wantHistogram: wantHistogram || (waiting?.wantHistogram ?? false),
      wantExtended: wantExtended || (waiting?.wantExtended ?? false),
    };
  }

  private postRender(request: WaitingRender) {
    const seq = ++this.renderSeq;
    this.renderInFlight = seq;
    this.renderSince = null;
    this.armRenderWatchdog();
    this.post({ cmd: "render", seq, ...request });
  }

  // Until `ready` the worker is creating its renderer and building the first program,
  // which can take longer than the watchdog allows, and draws nothing before that is
  // done. A render sent meanwhile holds the slot untimed and is timed from `ready`. One
  // sent while a render given up on may still be answered waits behind it in the worker,
  // so it is timed from its post, but only once that answer has come.
  private armRenderWatchdog() {
    const seq = this.renderInFlight;
    if (seq === null || this.renderWatchdog || this.availability !== "ready") return;
    const now = performance.now();
    const since = (this.renderSince ??= now);
    if (this.renderOverdue) {
      this.armRenderBackstop();
      return;
    }
    const giveUpMs = this.renderGiveUpMs();
    this.renderWatchdog = setTimeout(() => {
      this.renderWatchdog = null;
      console.warn(`[render-bridge] render ${seq} not answered in ${Math.round(giveUpMs)} ms`);
      this.renderOverdue = { seq, since };
      this.sendWaitingRender();
    }, Math.max(0, since + giveUpMs - now));
  }

  // The render in flight, untimed behind one given up on, becomes the one given up on
  // once the worker has said nothing for RENDER_BACKSTOP_MS, and the newest request goes.
  private armRenderBackstop() {
    if (this.renderBackstop) return;
    const check = () => {
      const quiet = performance.now() - this.quietSince;
      if (quiet < RENDER_BACKSTOP_MS) {
        this.renderBackstop = setTimeout(check, RENDER_BACKSTOP_MS - quiet);
        return;
      }
      this.renderBackstop = null;
      const seq = this.renderInFlight;
      if (seq === null) return;
      console.warn(`[render-bridge] no word from the worker in ${RENDER_BACKSTOP_MS} ms`);
      this.quietSince = performance.now();
      this.renderOverdue = { seq, since: this.renderSince ?? this.quietSince };
      this.sendWaitingRender();
    };
    const due = this.quietSince + RENDER_BACKSTOP_MS - performance.now();
    this.renderBackstop = setTimeout(check, Math.max(0, due));
  }

  private renderGiveUpMs(): number {
    const slowest = Math.max(0, ...this.renderTimes);
    return slowest > RENDER_WATCHDOG_MS ? SLOW_RENDER_ALLOWANCE * slowest : RENDER_WATCHDOG_MS;
  }

  private noteRenderTime(since: number) {
    this.renderTimes.push(performance.now() - since);
    if (this.renderTimes.length > RENDER_TIMES_KEPT) this.renderTimes.shift();
  }

  // A seq neither in flight nor overdue belongs to a render the mailbox cleared, so its
  // answer frees nothing. The worker answers renders in order: the answer to the one in
  // flight means the one given up on before it will never be answered.
  private renderAnswered(seq: number) {
    const overdue = this.renderOverdue;
    if (overdue?.seq === seq) {
      this.noteRenderTime(overdue.since);
      this.renderOverdue = null;
      this.clearRenderBackstop();
      this.armRenderWatchdog();
      return;
    }
    if (seq !== this.renderInFlight) return;
    if (this.renderSince !== null) this.noteRenderTime(this.renderSince);
    this.renderOverdue = null;
    this.sendWaitingRender();
  }

  private sendWaitingRender() {
    const next = this.renderWaiting;
    this.clearRenderSlot();
    if (next) this.postRender(next);
  }

  private clearRenderSlot() {
    if (this.renderWatchdog) clearTimeout(this.renderWatchdog);
    this.renderWatchdog = null;
    this.clearRenderBackstop();
    this.renderInFlight = null;
    this.renderSince = null;
    this.renderWaiting = null;
  }

  private clearRenderBackstop() {
    if (this.renderBackstop) clearTimeout(this.renderBackstop);
    this.renderBackstop = null;
  }

  // Seqs keep counting, so an answer to a render from before can't free a later one.
  private clearRenderMailbox() {
    this.clearRenderSlot();
    this.renderOverdue = null;
  }

  renderThumbnail(opts: {
    requestId: string;
    image:
      | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
      | { kind: "float16"; data: Uint16Array; width: number; height: number }
      | { kind: "bitmap"; bitmap: ImageBitmap };
    params: DevelopParams;
    asShotTemperature: number;
    maxEdge: number;
    quality?: number;
    contributedParams?: Record<string, unknown>;
  }) {
    const { image } = opts;
    const transfer = [image.kind === "bitmap" ? image.bitmap : image.data.buffer];
    this.post(
      { cmd: "renderThumbnail", ...opts, pipeline: resolvePipelineFor(opts.params.displayTransform) },
      transfer,
    );
  }

  renderThumbnailAsync(opts: {
    requestId: string;
    image:
      | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
      | { kind: "float16"; data: Uint16Array; width: number; height: number }
      | { kind: "bitmap"; bitmap: ImageBitmap };
    params: DevelopParams;
    asShotTemperature: number;
    maxEdge: number;
    quality?: number;
    contributedParams?: Record<string, unknown>;
  }): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      this.thumbResolvers.set(opts.requestId, (blob) =>
        blob ? resolve(blob) : reject(new Error("thumbnail render failed")),
      );
      this.renderThumbnail(opts);
    });
  }

  // ------------------------------------------------------------------
  // Display overlays
  // ------------------------------------------------------------------

  setShowClipping(mode: number) {
    this.post({ cmd: "setShowClipping", mode });
  }

  // Colour (display-space, 0..1) for out-of-image crop-mode margins, so the
  // develop view frames the photo in the canvas surround rather than black.
  setOutsideColor(rgb: [number, number, number]) {
    this.post({ cmd: "setOutsideColor", rgb });
  }

  // Coverage overlay: tint the given mask index (or -1 = off) in `color` at
  // `strength` (animated fade).
  setMaskViz(index: number, color: [number, number, number], strength: number) {
    this.post({ cmd: "setMaskViz", index, color, strength });
  }

  // Sharpening preview (Alt/Ctrl-drag): 0 = off, 1 = masking, 2 = detail, 3 = luma.
  setSharpenViz(mode: number) {
    this.post({ cmd: "setSharpenViz", mode });
  }

  /** Measure the worker's last render. While a render waits in the mailbox the
   *  measurement rides on it: sent on its own, the worker would measure the render in
   *  flight, and the newer one waiting would go unmeasured. */
  computeHistogram(wantExtended?: boolean) {
    const waiting = this.renderWaiting;
    if (waiting) {
      this.renderWaiting = {
        wantHistogram: true,
        wantExtended: waiting.wantExtended || !!wantExtended,
      };
      return;
    }
    this.post({ cmd: "computeHistogram", wantExtended });
  }

  computeUpright(mode: UprightMode): Promise<UprightResult> {
    return new Promise<UprightResult>((resolve) => {
      const reqId = ++this.reqIdSeq;
      this.uprightResolvers.set(reqId, resolve);
      this.post({ cmd: "analyzeUpright", reqId, mode });
    });
  }

  // ------------------------------------------------------------------
  // Extension stages & pipeline
  // ------------------------------------------------------------------

  setStages(stages: ProcessingStageContribution[]) {
    this.post({ cmd: "setStages", stages });
  }

  /** Re-send the processing stages the registry holds now. */
  syncStages() {
    this.setStages(Object.values(useRegistry.getState().processingStages));
  }

  setPipeline(pipeline: ResolvedPipeline) {
    this.post({ cmd: "setPipeline", pipeline });
  }

  /** Re-send the live pipeline: the live photo's pick resolved against the
   *  current registry and Preferences default. */
  syncPipeline() {
    this.livePipelineSent = true;
    this.setPipeline(resolvePipelineFor(this.liveDisplayTransform));
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  private post(msg: WorkerRequest, transfer?: Transferable[]) {
    if (this.disposed) return;
    if (transfer) {
      this.worker.postMessage(msg, transfer);
    } else {
      this.worker.postMessage(msg);
    }
  }
}

// Singleton bridge — shared across all hooks that need rendering.
let singleton: RenderBridge | null = null;
let unsubStages: (() => void) | null = null;
let unsubPipeline: (() => void) | null = null;
let unsubSettings: (() => void) | null = null;

// Stage textures live here (not in the per-photo param bag — they're bulk static
// data tied to the stage, not the edit). Extensions push via api.setStageTexture;
// the bag is replayed when the bridge (re)initialises.
const stageTextures: Record<string, StageTextureData> = {};

// Stage and stage-texture changes don't flow through the param-driven develop
// render effect, so an extension swapping a stage or its textures (e.g. picking
// a film stock) wouldn't repaint until the next interaction. Redraw here,
// rAF-debounced so a swap (re-register + N texture uploads) coalesces into one.
let stageRenderRaf: number | null = null;
function requestStageRender(): void {
  if (!singleton || stageRenderRaf != null) return;
  stageRenderRaf = requestAnimationFrame(() => {
    stageRenderRaf = null;
    singleton?.render(false);
  });
}

/** Set or clear (null) a processing stage's texture by qualified key
 *  "{stageId}.{key}". Forwards the full bag to the worker. */
export function setStageTexture(
  qualifiedKey: string,
  tex: StageTextureData | null,
): void {
  if (tex) stageTextures[qualifiedKey] = tex;
  else delete stageTextures[qualifiedKey];
  singleton?.setStageTextures(stageTextures);
  requestStageRender();
}

/** Drop the textures of the stages a swept extension owned, so turning it off
 *  frees them here and, through the smaller bag, in the worker. A key belongs
 *  to the longest stage id it extends: a stage whose id extends a dropped one
 *  keeps its own. */
function releaseStageTextures(stageIds: readonly string[]): void {
  const released = new Set(stageIds);
  const stages = [...stageIds, ...Object.keys(useRegistry.getState().processingStages)];
  const ownerOf = (key: string): string => {
    let owner = "";
    for (const id of stages)
      if (key.startsWith(`${id}.`) && id.length > owner.length) owner = id;
    return owner;
  };
  const dropped = Object.keys(stageTextures).filter((key) => released.has(ownerOf(key)));
  if (dropped.length === 0) return;
  for (const key of dropped) delete stageTextures[key];
  singleton?.setStageTextures(stageTextures);
}
onStagesReleased(releaseStageTextures);

/** The current stage-texture bag (qualified key → data). Returned by reference;
 *  callers must not mutate. Used by the export pipeline to seed its own renderer
 *  with the same film LUTs / spectral tables the live renderer has, so stages
 *  that depend on uploaded textures (e.g. Spektrafilm) don't render black. */
export function getStageTextures(): Record<string, StageTextureData> {
  return stageTextures;
}

function syncStages() {
  singleton?.syncStages();
}

function syncPipeline() {
  singleton?.syncPipeline();
}

export function getRenderBridge(): RenderBridge {
  if (!singleton) {
    singleton = new RenderBridge();
    // init posts the current stages and pipeline ahead of itself.
    singleton.init(2560, 2560);

    // Replay any stage textures registered before the bridge existed.
    if (Object.keys(stageTextures).length > 0) singleton.setStageTextures(stageTextures);

    // Push the GPU source-cache budget now and whenever the preference changes.
    singleton.setCacheBudget(getSettings().gpuSourceCacheBytes);
    let prevBudget = getSettings().gpuSourceCacheBytes;
    unsubSettings = useSettings.subscribe((s) => {
      if (s.gpuSourceCacheBytes !== prevBudget) {
        prevBudget = s.gpuSourceCacheBytes;
        singleton?.setCacheBudget(prevBudget);
      }
    });

    let prevStages = useRegistry.getState().processingStages;
    let prevPipelines = useRegistry.getState().pipelines;
    unsubStages = useRegistry.subscribe((s) => {
      if (s.processingStages !== prevStages) {
        prevStages = s.processingStages;
        syncStages();
        requestStageRender();
      }
      if (s.pipelines !== prevPipelines) {
        prevPipelines = s.pipelines;
        syncPipeline();
        // A pipeline (display-transform) swap is silent like a stage swap:
        // it updates renderer state but isn't param-driven, so force a redraw.
        requestStageRender();
      }
    });
    unsubPipeline = usePipelineStore.subscribe(() => {
      syncPipeline();
      // A new Preferences default changes what a photo without its own pick
      // renders with; repaint, else the canvas keeps the previous transform
      // until the next interaction.
      requestStageRender();
    });
  }
  return singleton;
}

export function disposeRenderBridge() {
  unsubStages?.();
  unsubStages = null;
  unsubPipeline?.();
  unsubPipeline = null;
  unsubSettings?.();
  unsubSettings = null;
  singleton?.dispose();
  singleton = null;
}
