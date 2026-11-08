// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CropRect, DevelopParams } from "@/catalog/types";
import type { BrushTipContribution, ProcessingStageContribution, StageTextureData } from "@/extensions/types";
import type { ResolvedPipeline } from "@/extensions/pipelines";
import { resolvePipelineFor } from "@/extensions/pipelines";
import type { HistogramData } from "./histogram";
import type {
  DevelopedPixels, SourceImage, ThumbEncodeOptions, ThumbRequest, WorkerRequest,
} from "./render-protocol";
import type { ProbePoint } from "./webgl/renderer";
import type { MonitorTransform } from "./display-profile";
import type { ColorSpaceId, DisplaySpace } from "./color-space";
import {
  DEFAULT_CAPTURE_SPACE, captureMaxEdge, type FloatCaptureOptions, type FloatFrame, type LiveFloatCaptureOptions,
} from "./float-frame";
import type { SourceSample, StoredSample } from "./source-sample";
import { setSourcePixels } from "./source-pixels";
import {
  RenderTransport, type AvailabilityCallback, type RendererAvailability, type WorkerAnswer,
} from "./render-bridge/transport";
import { RenderRequests, blankBitmap } from "./render-bridge/requests";
import { RenderMailbox } from "./render-bridge/mailbox";
import { ParamSync, derivedFor } from "./render-bridge/param-sync";
import { flushStageSync, stagesForWorker, unwireBridge, wireBridge } from "./render-bridge/wiring";
import { unwireBrushTips, wireBrushTips } from "./brush-tip-registry";
import { forgetStageFailures, recordStageFailure, stageFailureText } from "./render-bridge/stage-failures";
import { useRegistry } from "@/extensions/registry";
import { privilegedGpu } from "@/native/privileged";

export type { RendererAvailability } from "./render-bridge/transport";
export { getStageTextures, setStageTexture, stagesForWorker } from "./render-bridge/wiring";

export interface FrameResult {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** The size the renderer holds the source this frame was drawn from at. */
  sourceWidth: number;
  sourceHeight: number;
  /** The number of that source; see RenderBridge.sourceGen. */
  sourceGen: number;
  /** The decoded frame's size before the upload cap, and whether `readSourceSample`
   *  has a sample of the source: a live float decode, or a cached preview stored with one. */
  sourceFullWidth: number;
  sourceFullHeight: number;
  sourceNative: boolean;
  /** The window of the image it was drawn for (setViewport); null, the whole image. */
  roi: { x: number; y: number; w: number; h: number } | null;
  /** The size a frame of the whole image would have, which a window is part of; 0,
   *  unknown. */
  wholeWidth: number;
  wholeHeight: number;
  /** The region of the transformed image it is of: the crop drawn, which crop mode
   *  widens to the whole image; null, unknown. */
  crop: CropRect | null;
  histogram?: HistogramData;
  /** It asked for a histogram that arrives on its own (setOnHistogram), after it. */
  histogramFollows?: boolean;
  /** The prepass stages it was drawn without, for want of a texture unit. */
  overflowedStages: readonly string[];
}

type FrameCallback = (frame: FrameResult) => void;
type HistogramCallback = (histogram: HistogramData) => void;
type HistogramErrorCallback = () => void;
type ErrorCallback = (message: string) => void;
/** The number (RenderBridge.sourceGen) of a develop source the worker couldn't take,
 *  and why. */
type SourceErrorCallback = (sourceGen: number, message: string) => void;
type SourcePixelsCallback = (src: { data: Uint8ClampedArray; width: number; height: number }) => void;

/** What moves to the worker with a source rather than being copied: its pixels,
 *  and the sample a cached preview carries (8 MB). */
function transferOf(image: SourceImage): Transferable[] {
  if (image.kind === "bitmap") return [image.bitmap];
  const transfer: Transferable[] = [image.data.buffer];
  if (image.kind === "float16" && image.sample) transfer.push(image.sample.data.buffer);
  return transfer;
}

/** Where a float frame is read and the space it is converted into: pre-output
 *  in linear Rec.709 unless asked otherwise. */
function floatRead(opts: Pick<FloatCaptureOptions, "point" | "space">): Pick<FloatFrame, "point" | "space"> {
  return { point: opts.point ?? "pre-output", space: opts.space ?? DEFAULT_CAPTURE_SPACE };
}

export class RenderBridge {
  private readonly transport: RenderTransport;
  private readonly requests: RenderRequests;
  private readonly mailbox: RenderMailbox;
  private readonly paramSync: ParamSync;
  /** Settles once the worker's renderer is ready, or once the bridge gives up on it
   *  (availability "failed") or is disposed: it never rejects, so read `availability`
   *  or `pipelineFloat` after it. */
  readonly ready: Promise<void>;
  private onFrame: FrameCallback | null = null;
  private onHistogram: HistogramCallback | null = null;
  private onHistogramError: HistogramErrorCallback | null = null;
  private onError: ErrorCallback | null = null;
  private onSourceError: SourceErrorCallback | null = null;
  private onSourcePixels: SourcePixelsCallback | null = null;
  private sourcesBound = 0;
  // The source number clearSource was called at: its pixels may still be on their way.
  private pixelsClearedGen: number | null = null;
  // The ids of the stages last posted, to tell when the set loses one.
  private postedStageIds: ReadonlySet<string> = new Set();

  constructor() {
    this.transport = new RenderTransport({
      message: (msg) => this.handleMessage(msg),
      beforeInit: () => {
        this.paramSync.reset();
        this.mailbox.clear();
        forgetStageFailures();
        // The worker builds its first develop program while it handles init, from the
        // stages and pipeline it holds by then, so the current ones go first: on a
        // retry too, since either may have changed while the last init was failing.
        this.syncStages();
        this.syncPipeline();
      },
      ready: () => this.mailbox.armWatchdog(),
      stopped: () => this.mailbox.clear(),
      settlePending: () => this.requests.settleAll(),
      error: (message) => this.onError?.(message),
      unusable: (detail) => {
        void privilegedGpu()?.rendererFailed(detail).catch(() => undefined);
      },
    });
    this.ready = this.transport.ready;
    this.requests = new RenderRequests(this.transport);
    this.mailbox = new RenderMailbox(
      this.transport,
      () => this.transport.unresponsive(),
      () => this.requests.longRunning,
    );
    this.paramSync = new ParamSync(this.transport);
  }

  /** Whether the worker's WebGL2 context has renderable float colour buffers;
   *  undefined until the worker reports ready. */
  get pipelineFloat(): boolean | undefined {
    return this.transport.pipelineFloat;
  }

  get availability(): RendererAvailability {
    return this.transport.availability;
  }

  private handleMessage(msg: WorkerAnswer) {
    const requests = this.requests;
    switch (msg.type) {
      case "frame": {
        const again = this.mailbox.answered(msg.seq, msg.prepassPending);
        if (again) this.render(again.wantHistogram, again.wantExtended);
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
          sourceFullWidth: msg.sourceFullWidth ?? msg.sourceWidth,
          sourceFullHeight: msg.sourceFullHeight ?? msg.sourceHeight,
          sourceNative: msg.sourceNative ?? false,
          roi: msg.roi ?? null,
          wholeWidth: msg.wholeWidth ?? 0,
          wholeHeight: msg.wholeHeight ?? 0,
          crop: msg.crop ?? null,
          histogram: msg.histogram,
          histogramFollows: msg.histogramFollows,
          overflowedStages: msg.overflowedStages ?? [],
        });
        break;
      }
      case "frameSkipped":
        this.mailbox.answered(msg.seq);
        break;
      case "renderError":
        this.mailbox.answered(msg.seq);
        this.onError?.(`render failed: ${msg.message}`);
        break;
      case "sourceError":
        this.onSourceError?.(msg.sourceGen, msg.message);
        this.onError?.(`source failed: ${msg.message}`);
        break;
      case "histogram":
        this.onHistogram?.(msg.histogram);
        break;
      case "histogramError":
        this.onHistogramError?.();
        this.onError?.(msg.message);
        break;
      // A thumbnail request settles once, by its requestId: with its answer, or with
      // null for a miss or a failure.
      case "thumbnail":
      case "thumbnailFloat":
        requests.answer(requests.thumbs, msg.requestId, msg);
        break;
      case "thumbnailMiss":
        requests.answer(requests.thumbs, msg.requestId, null);
        break;
      case "thumbnailError":
        // Reject the pending request (null -> renderThumbnailAsync rejects) so the
        // caller stops awaiting and can retry on the next edit, then surface the
        // underlying cause for diagnosis.
        requests.answer(requests.thumbs, msg.requestId, null);
        this.onError?.(`thumbnail render failed: ${msg.message}`);
        break;
      case "sourceBound":
        if (msg.hit) this.sourcesBound++;
        requests.answer(requests.sourceBound, msg.reqId, msg.hit);
        break;
      case "hasSource":
        requests.answer(requests.hasSource, msg.reqId, msg.has);
        break;
      case "captured":
        // Given up on, or never asked: nothing will close it otherwise.
        if (!requests.answer(requests.captures, msg.reqId, msg.bitmap)) msg.bitmap.close();
        break;
      case "capturedFloat":
        requests.answer(requests.floatCaptures, msg.reqId, msg.frame);
        break;
      case "sourceSample":
        requests.answer(requests.sourceSamples, msg.reqId, msg.sample);
        break;
      case "probed":
        requests.answer(requests.probes, msg.reqId, msg.rgb);
        break;
      case "developedPixels":
        requests.answer(requests.pixels, msg.reqId, msg.pixels);
        break;
      case "developedPixelsError":
        // Settle the pending read with nothing so the awaiting caller unblocks
        // instead of hanging, then surface the cause.
        requests.answer(requests.pixels, msg.reqId, null);
        this.onError?.(`reading the developed frame failed: ${msg.message}`);
        break;
      case "sourcePixels":
        // Pixels sent before the last source was handed over, or before it was cleared,
        // are another photo's.
        if (msg.sourceGen !== this.sourcesBound || msg.sourceGen === this.pixelsClearedGen) break;
        this.onSourcePixels?.({ data: msg.data, width: msg.width, height: msg.height });
        break;
      case "stageQuarantined": {
        const stage = { stageId: msg.stageId, signature: msg.signature, log: msg.log };
        recordStageFailure(stage);
        this.onError?.(stageFailureText(stage, useRegistry.getState().processingStages));
        break;
      }
      case "error":
        // Not tied to a request, so per-request resolvers can't be settled from
        // here; each request path posts its own settling response on failure.
        this.onError?.(msg.message);
        break;
    }
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  init(width: number, height: number) {
    this.transport.init(width, height);
  }

  dispose() {
    if (this.transport.disposed) return;
    this.paramSync.dispose();
    this.mailbox.clear();
    this.transport.dispose();
  }

  // ------------------------------------------------------------------
  // Callbacks
  // ------------------------------------------------------------------

  setOnFrame(cb: FrameCallback | null) { this.onFrame = cb; }
  setOnHistogram(cb: HistogramCallback | null) { this.onHistogram = cb; }
  /** Told when the histogram a frame said would follow it failed to be measured, so the
   *  view can ask for one at its next frame. */
  setOnHistogramError(cb: HistogramErrorCallback | null) { this.onHistogramError = cb; }
  setOnError(cb: ErrorCallback | null) { this.onError = cb; }
  setOnSourceError(cb: SourceErrorCallback | null) { this.onSourceError = cb; }
  setOnSourcePixels(cb: SourcePixelsCallback | null) { this.onSourcePixels = cb; }
  /** Reports the current availability at once, then every change. */
  setOnAvailability(cb: AvailabilityCallback | null) {
    this.transport.setOnAvailability(cb);
  }

  // ------------------------------------------------------------------
  // Image data
  // ------------------------------------------------------------------

  /** The develop view moved to another photo: the worker draws no frame and measures
   *  no histogram until that photo's source is set or bound. */
  clearSource() {
    this.pixelsClearedGen = this.sourcesBound;
    setSourcePixels(new Uint8ClampedArray(0), 0, 0);
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
    image: SourceImage,
    maxEdge?: number,
    isFallbackPreview?: boolean,
  ) {
    const transfer = transferOf(image);
    this.post(
      { cmd: "setImage", image, maxEdge, isFallbackPreview },
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
      const reqId = this.requests.nextId();
      this.requests.expect(this.requests.sourceBound, reqId, resolve, () => false);
      this.post({ cmd: "bindSource", reqId, key });
    });
  }

  uploadSource(
    target: "main" | "thumb",
    key: string,
    image: SourceImage,
    maxEdge?: number,
    isFallbackPreview?: boolean,
    // false = upload into the cache without changing the active source (prefetch).
    bind = true,
  ) {
    const transfer = transferOf(image);
    this.post(
      { cmd: "uploadSource", target, key, image, maxEdge, isFallbackPreview, bind },
      transfer,
    );
    if (bind && target === "main") this.sourcesBound++;
  }

  /** Is a source already resident in the given renderer's cache? */
  hasSource(target: "main" | "thumb", key: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const reqId = this.requests.nextId();
      this.requests.expect(this.requests.hasSource, reqId, resolve, () => false);
      this.post({ cmd: "hasSource", reqId, target, key });
    });
  }

  setCacheBudget(bytes: number) {
    this.post({ cmd: "setCacheBudget", bytes });
  }

  /** A resident cached source takes the decoded size and centre sample its
   *  completed RAW cache entry now holds; the worker ignores a key it doesn't
   *  hold. The sample moves to the worker. */
  setSourceSample(key: string, update: { fullWidth: number; fullHeight: number; sample: StoredSample }) {
    this.post(
      { cmd: "setSourceSample", key, fullWidth: update.fullWidth, fullHeight: update.fullHeight, sample: update.sample },
      [update.sample.data.buffer],
    );
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
  // `lossless` wins over `quality`.
  renderThumbnailFromSource(opts: ThumbEncodeOptions & { key: string }): Promise<Blob | null> {
    return new Promise<Blob | null>((resolve) => {
      this.requests.expect(
        this.requests.thumbs,
        opts.requestId,
        (answer) => resolve(answer?.type === "thumbnail" ? answer.blob : null),
        () => null,
      );
      flushStageSync();
      const pipeline = resolvePipelineFor(opts.params.displayTransform);
      const contributedParams = this.paramSync.thumbBag(pipeline, opts.contributedParams);
      this.post({
        cmd: "renderThumbnailFromSource",
        ...opts,
        pipeline,
        contributedParams,
        derived: derivedFor(opts.params),
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
    this.paramSync.setParams(params);
  }

  /** Generic param bag for extension-contributed processing-stage uniforms,
   *  keyed by qualified key "{stageId}.{key}". Pushed to both the develop and
   *  thumbnail renderers in the worker. Posting clones every value, brush dabs
   *  included, into objects the renderer then bakes coverage from again, and the
   *  Develop view offers a bag on every change, so only the difference from the last
   *  bag posted goes: the entries that are new or not the same value, and the keys
   *  dropped. The first bag, and the first after an init, goes whole. Callers replace
   *  the bag and the values in it on change and never mutate them. The live display
   *  transform's derived uniforms are added to it (bagForRender). */
  setContributedParams(bag: Record<string, unknown>) {
    this.paramSync.setLiveBag(bag);
  }

  /** Pixel data (baked LUT atlases, etc.) for processing-stage textures, keyed
   *  by qualified key "{stageId}.{key}". Structured-cloned to the worker (not
   *  transferred) so the caller keeps its buffers and can re-push on a swap. */
  setStageTextures(bag: Record<string, StageTextureData>) {
    this.post({ cmd: "setStageTextures", bag });
  }

  /** The brush tips the worker's bakes stamp with, the whole set: it replaces the
   *  one the worker holds. Structured-cloned, as the textures are. */
  setBrushTips(tips: Record<string, BrushTipContribution>) {
    this.post({ cmd: "setBrushTips", tips });
  }

  /** Start building, in the background, the program that would wake those of
   *  `stageIds` that are dormant (WebGLRenderer.prewarmStages). */
  prewarmStages(stageIds: string[]) {
    this.post({ cmd: "prewarmStages", stageIds });
  }

  /** The stage textures set and the keys cleared since the bag last posted, whole
   *  or by patches; the worker merges them into the bag it holds. */
  patchStageTextures(set: Record<string, StageTextureData>, remove: string[]) {
    this.post({ cmd: "patchStageTextures", set, remove });
  }

  /** Render one frame with `params` (at the current source + viewport) to an
   *  ImageBitmap, without touching the live display. Used to grab a "before"
   *  frame for before/after comparison overlays. The live params are restored
   *  in the worker afterwards. The frame is sRGB unless `asShown` asks for it
   *  as the screen shows it, through the display profile. `paramBag` is merged
   *  over the live stage params for this capture only. */
  capture(
    params: DevelopParams,
    opts: { asShown?: boolean; paramBag?: Record<string, unknown> } = {},
  ): Promise<ImageBitmap> {
    return new Promise<ImageBitmap>((resolve) => {
      const reqId = this.requests.nextId();
      this.requests.expect(this.requests.captures, reqId, resolve, blankBitmap);
      flushStageSync();
      const pipeline = resolvePipelineFor(params.displayTransform);
      const bagPatch = this.paramSync.capturePatch(pipeline, opts.paramBag);
      this.post({
        cmd: "capture",
        reqId,
        params,
        derived: derivedFor(params),
        pipeline,
        asShown: opts.asShown === true,
        ...(bagPatch ? { bagPatch } : {}),
      });
    });
  }

  /** Render one frame with `params` as capture() does, for measuring, and read
   *  it as floats at `opts.point` (default "pre-output"), converted into
   *  `opts.space` (default linear Rec.709) on the GPU. It is read at most
   *  `opts.maxEdge` px on its long edge (default DEFAULT_CAPTURE_MAX_EDGE;
   *  Infinity for the full view). Null when the worker has no renderer, no
   *  source or no float render targets, or is disposed. */
  captureFloat(
    params: DevelopParams,
    opts: LiveFloatCaptureOptions = {},
  ): Promise<FloatFrame | null> {
    if (this.transport.disposed) return Promise.resolve(null);
    return new Promise<FloatFrame | null>((resolve) => {
      const reqId = this.requests.nextId();
      this.requests.expect(this.requests.floatCaptures, reqId, resolve, () => null, { long: true });
      flushStageSync();
      const pipeline = resolvePipelineFor(params.displayTransform);
      const bagPatch = this.paramSync.capturePatch(pipeline, opts.paramBag);
      this.post({
        cmd: "captureFloat",
        reqId,
        params,
        derived: derivedFor(params),
        pipeline,
        ...floatRead(opts),
        // Not in floatRead: the thumbnails that share it are drawn small already.
        maxEdge: captureMaxEdge(opts.maxEdge),
        ...(bagPatch ? { bagPatch } : {}),
      });
    });
  }

  /** The native-resolution centre of the live photo's decode (source-sample.ts),
   *  cut before the upload cap: a fresh copy each call. A cached preview stored
   *  with its sample (3.1.0 and later) answers one too. Null when the worker has
   *  no renderer or no source, between photos, when the bound source is a bitmap,
   *  the camera preview or a cache entry written before the sample was kept, or
   *  when disposed. */
  readSourceSample(): Promise<SourceSample | null> {
    if (this.transport.disposed) return Promise.resolve(null);
    return new Promise<SourceSample | null>((resolve) => {
      const reqId = this.requests.nextId();
      this.requests.expect(this.requests.sourceSamples, reqId, resolve, () => null);
      this.post({ cmd: "readSourceSample", reqId });
    });
  }

  /** The linear colour around (u, v) of the live frame, x right and y down in
   *  [0, 1] across its buffer, averaged over 5×5 of its pixels: "output" is the
   *  colour the output stage receives, "mask" the scene-linear colour the mask
   *  components compare. Drawn from what the worker holds when the request
   *  arrives, so it follows params posted before it. Null when the worker has
   *  nothing to read it from, or is disposed. */
  probe(u: number, v: number, point: ProbePoint): Promise<[number, number, number] | null> {
    if (this.transport.disposed) return Promise.resolve(null);
    return new Promise<[number, number, number] | null>((resolve) => {
      const reqId = this.requests.nextId();
      this.requests.expect(this.requests.probes, reqId, resolve, () => null);
      flushStageSync();
      this.post({ cmd: "probe", reqId, u, v, point });
    });
  }

  /** The monitor's profile for the live view (Linux), or null for none. */
  setMonitorTransform(transform: MonitorTransform | null) {
    this.post({ cmd: "setMonitorTransform", transform });
  }

  /** The space the screen shows, for the live view's version 3 frames. */
  setDisplaySpace(space: DisplaySpace) {
    this.post({ cmd: "setDisplaySpace", space });
  }

  /** Soft proof the live view's version 3 frames in `space`, the export's,
   *  or stop with null. */
  setProof(space: ColorSpaceId | null) {
    this.post({ cmd: "setProof", space });
  }

  setAsShotTemperature(kelvin: number) {
    this.post({ cmd: "setAsShotTemperature", kelvin });
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  /** Draw a frame of the state the worker holds. While one is in flight only the
   *  newest request waits, asking for every histogram the requests it replaced asked
   *  for, and goes once the worker answers. Messages that set state still go at once,
   *  so the worker has them before the render that waits. */
  render(wantHistogram = false, wantExtended = false) {
    flushStageSync();
    this.mailbox.render(wantHistogram, wantExtended);
  }

  /** Resolves once no render has been requested for `ms`: work that would land on
   *  the worker mid-drag (a neighbour's decode) waits for the edit to go quiet. Aborting
   *  `signal` stops the wait and resolves it at once. */
  whenRenderQuiet(ms = 300, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const check = () => {
        const wait = this.mailbox.lastRequestedAt + ms - performance.now();
        if (wait <= 0) resolve();
        else timer = setTimeout(check, wait);
      };
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      if (signal?.aborted) resolve();
      else check();
    });
  }

  renderThumbnail(opts: ThumbEncodeOptions & {
    image: SourceImage;
    float?: Pick<FloatFrame, "point" | "space">;
  }) {
    const { image } = opts;
    flushStageSync();
    const transfer = [image.kind === "bitmap" ? image.bitmap : image.data.buffer];
    const pipeline = resolvePipelineFor(opts.params.displayTransform);
    const contributedParams = this.paramSync.thumbBag(pipeline, opts.contributedParams);
    this.post(
      { cmd: "renderThumbnail", ...opts, pipeline, contributedParams, derived: derivedFor(opts.params) },
      transfer,
    );
  }

  renderThumbnailAsync(opts: ThumbEncodeOptions & { image: SourceImage }): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      this.requests.expect(
        this.requests.thumbs,
        opts.requestId,
        (answer) =>
          answer?.type === "thumbnail" ? resolve(answer.blob) : reject(new Error("thumbnail render failed")),
        () => null,
      );
      this.renderThumbnail(opts);
    });
  }

  /** A thumbnail read as floats rather than encoded (renderPhotoFloatFrame): at
   *  `float.point`, converted into `float.space` on the GPU, pre-output in
   *  linear Rec.709 unless asked otherwise. Drawn from the thumb renderer's
   *  resident source under `key`, or from `image`, which it doesn't keep. Null
   *  on a cache miss, as renderThumbnailFromSource resolves, and when the render
   *  fails, the worker has no float render targets or doesn't answer, or the
   *  bridge is disposed. */
  renderThumbnailFloat(
    opts: ThumbRequest & { float: Pick<FloatCaptureOptions, "point" | "space"> },
  ): Promise<FloatFrame | null> {
    if (this.transport.disposed) return Promise.resolve(null);
    return new Promise<FloatFrame | null>((resolve) => {
      this.requests.expect(
        this.requests.thumbs,
        opts.requestId,
        (answer) => resolve(answer?.type === "thumbnailFloat" ? answer.frame : null),
        () => null,
      );
      const float = floatRead(opts.float);
      if (opts.key !== undefined) {
        flushStageSync();
        const pipeline = resolvePipelineFor(opts.params.displayTransform);
        const contributedParams = this.paramSync.thumbBag(pipeline, opts.contributedParams);
        this.post({
          cmd: "renderThumbnailFromSource",
          ...opts,
          float,
          pipeline,
          contributedParams,
          derived: derivedFor(opts.params),
        });
      } else {
        this.renderThumbnail({ ...opts, float });
      }
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
    flushStageSync();
    this.mailbox.computeHistogram(wantExtended);
  }

  /** The live photo's developed frame of the whole image, untransformed and
   *  uncropped, with its long edge at `edge` px; null without a frame. */
  readDevelopedPixels(edge: number): Promise<DevelopedPixels | null> {
    return new Promise<DevelopedPixels | null>((resolve) => {
      const reqId = this.requests.nextId();
      this.requests.expect(this.requests.pixels, reqId, resolve, () => null, { long: true });
      flushStageSync();
      this.post({ cmd: "readDevelopedPixels", reqId, edge });
    });
  }

  // ------------------------------------------------------------------
  // Extension stages & pipeline
  // ------------------------------------------------------------------

  setStages(stages: ProcessingStageContribution[]) {
    const ids = new Set(stages.map((s) => s.id));
    if ([...this.postedStageIds].some((id) => !ids.has(id))) forgetStageFailures();
    this.postedStageIds = ids;
    this.post({ cmd: "setStages", stages });
  }

  /** Re-send the processing stages the registry holds now, and the live
   *  params' values they derive. */
  syncStages() {
    this.setStages(stagesForWorker());
    this.paramSync.refreshDerived();
  }

  setPipeline(pipeline: ResolvedPipeline) {
    this.post({ cmd: "setPipeline", pipeline });
  }

  /** Re-send the live pipeline: the live photo's pick resolved against the
   *  current registry and Preferences default. */
  syncPipeline() {
    this.paramSync.syncPipeline();
  }

  private post(msg: WorkerRequest, transfer?: Transferable[]) {
    this.transport.post(msg, transfer);
  }
}

// Singleton bridge — shared across all hooks that need rendering.
let singleton: RenderBridge | null = null;

export function getRenderBridge(): RenderBridge {
  if (!singleton) {
    singleton = new RenderBridge();
    // init posts the current stages and pipeline ahead of itself.
    singleton.init(2560, 2560);
    wireBridge(singleton);
    wireBrushTips(singleton);
  }
  return singleton;
}

/** Pass a prewarm hint to the shared bridge, if there is one: a hint is never a
 *  reason to start the render worker. */
export function hintStages(stageIds: string[]): void {
  singleton?.prewarmStages(stageIds);
}

export function disposeRenderBridge() {
  unwireBridge();
  unwireBrushTips();
  singleton?.dispose();
  singleton = null;
}
