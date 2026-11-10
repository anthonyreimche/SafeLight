// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The multi-pass prepass framework: ping-pong targets, per-stage result
// textures or layers of one shared array, cached pass programs, and the
// signatures that let a frame reuse a stage's result when nothing it depends on
// changed. The renderer hands it each frame's inputs and draws the splits.

import { BUILTIN_DENOISE_ID } from "./builtin-denoise";
import { SCRATCH_UNIT, allocateInto, created, drainErrors, workingFormat, type TexFormat } from "./gl-resources";
import { simpleHash } from "./hash";
import { passDraws, stageDraws } from "./pass-draws";
import { prefixSig } from "./prepass-signature";
import { buildOutcome, createProgram, withProcessVersion, type ProgramBuilds } from "./program-cache";
import type { ProcessVersion } from "./shaders";
import { isDormant, paramIsActive } from "./stage-coverage";
import {
  INPUT_IMAGE_UNIFORM,
  INPUT_IS_SOURCE_UNIFORM,
  PASS_VERTEX_SHADER,
  SOURCE_IMAGE_UNIFORM,
  type ContributedBinding,
  type PrepassStage,
  type StageSplit,
} from "./stage-injection";
import { StageResultLayers } from "./stage-result-layers";
import { bindUniformByType, boundValue } from "./uniform-values";

// A layered stage's cached result is kept under its id with this prefix.
const LAYER_KEY = "layer:";

// The unit a pass reads a drawn input from (fetchInput). Every unit but the
// scratch one, which the source takes, belongs to the develop program, so it
// is lent for the stage's draws and handed back after them.
const INPUT_UNIT = 4;

function warnOnce(seen: Set<string>, key: string, message: () => string): void {
  if (seen.has(key)) return;
  seen.add(key);
  console.warn(message());
}

/** A coarse class of what draws cost the driver: the area drawn, by powers of
 *  4, and with `draws` given, a stage's draws in a frame, by powers of 2.
 *  Without it, the develop program's one draw. */
export function drawCost(w: number, h: number, draws?: number): string {
  const area = `a${Math.ceil(Math.log2(Math.max(1, w * h)) / 2)}`;
  return draws === undefined ? area : `${area}d${Math.ceil(Math.log2(Math.max(1, draws)))}`;
}

/** What a stage's pass programs and results are made from, besides the bag:
 *  its passes' sources, draw counts and checkpoints, and the stage whose
 *  programs it draws with. */
function passesPrint(stage: PrepassStage): string {
  const passes = stage.passes.map((p) => [p.fragmentSource, p.vertexSource ?? null, p.iterations, p.drawCount ?? null, p.keep ?? null]);
  return simpleHash(JSON.stringify([passes, stage.passesOf ?? ""]));
}

type PassProgram = { owner: string; program: WebGLProgram; locs: Record<string, WebGLUniformLocation | null> };
type Target = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };

/** The state after a kept pass, the prefix signature it was drawn under, and
 *  the source it was drawn from. */
type Checkpoint = Target & { sig: string; srcSig: string };

/** What fetchInput reads in a stage's draws: the source as uploaded, or the
 *  input drawn at pass size. */
type StageInput = { tex: WebGLTexture; isSource: boolean };

type UnitResult = { kind: "unit"; resultUniform: string; tex: WebGLTexture; unit: number };
type LayerResult = { kind: "layer"; layerUniform: string; layer: number };

/** A prepass stage's result this frame: a texture on its unit, or its layer of
 *  the shared array (-1 for none). */
export type PrepassResult = UnitResult | LayerResult;

/** What a frame's prepasses are drawn from and at. */
export interface PrepassFrame {
  stages: readonly PrepassStage[];
  srcTex: WebGLTexture;
  /** Identifies the source's contents for caching. */
  srcSig: string;
  /** Whether a split draw must apply the retouch itself, as the main draw does
   *  when there is no patched source. */
  applyRetouch: boolean;
  /** The split part of a reads-current stage's prepass signature. */
  splitToken: (stageId: string, split: StageSplit) => number;
  w: number;
  h: number;
  baseCurve: number;
  bag: Record<string, unknown>;
  /** Each mask copy's coverage slot, -1 for a mask that applies nothing. */
  copySlots: ReadonlyMap<string, number>;
  /** The units results may take (prepass-units.ts). */
  units: readonly number[];
  /** How many mask copies may run their passes this frame. */
  copyBudget: number;
  /** The source epoch, which the shared array starts over on. */
  epoch: number;
  /** The photo's, which pass programs are built and results kept under. */
  processVersion: ProcessVersion;
  linear: boolean;
  isFallbackPreview: boolean;
  /** The decoded source's size before the upload cap (uSourceSize). */
  sourceWidth: number;
  sourceHeight: number;
  /** srcTex's own size: the passes draw at it only when it is w×h. */
  srcW: number;
  srcH: number;
}

export interface PrepassHost {
  /** Draws the develop program up to split `index` of `srcTex` into `target`. */
  drawSplit(
    index: number,
    srcTex: WebGLTexture,
    applyRetouch: boolean,
    target: { fbo: WebGLFramebuffer | null; w: number; h: number },
  ): void;
  /** Says once what a path loses on this GPU. */
  note(path: "prepass" | "stage-results", note: string): void;
  /** Told as each pass program starts and stops building. */
  builds?: ProgramBuilds;
  /** Asked before a stage's draws whether they are to be waited on. */
  draws?: StageDraws;
}

/** The first draws of a stage at a cost (drawCost), which a renderer waits on so
 *  a draw that takes the graphics driver down can be pinned on the stage. */
export interface StageDraws {
  /** Whether `stageId`'s draws at `cost` are to be waited on, asked before them. */
  started(stageId: string, cost: string): boolean;
  /** `drawn`: they finished; false when they stopped short. Not told when the
   *  context was lost. */
  ended(stageId: string, cost: string, drawn: boolean): void;
}

/** Reads one pixel of the bound framebuffer, which can't return before every
 *  draw into it has finished: as RGBA `type`, or with none, in the format and
 *  type the framebuffer says it reads in. False, having read nothing, for a
 *  type it has no array for. */
export function readOnePixel(gl: WebGL2RenderingContext, type?: number): boolean {
  const t: number = type ?? gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
  const format: number = type === undefined ? gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) : gl.RGBA;
  const px =
    t === gl.FLOAT
      ? new Float32Array(4)
      : t === gl.UNSIGNED_BYTE
        ? new Uint8Array(4)
        : t === gl.HALF_FLOAT || t === gl.UNSIGNED_SHORT
          ? new Uint16Array(4)
          : null;
  if (!px) return false;
  gl.readPixels(0, 0, 1, 1, format, t, px);
  return true;
}

/** Waits out the work queued so far with a one-pixel read of the default
 *  framebuffer, which is always complete, so the draws watched after it are
 *  the only ones a read after them waits on. The read binding is left as found. */
export function settleQueuedDraws(gl: WebGL2RenderingContext): void {
  const bound: WebGLFramebuffer | null = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  readOnePixel(gl, gl.UNSIGNED_BYTE);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, bound);
}

export interface PrepassOptions {
  /** Whether kept passes (StagePass.keep) leave checkpoints. Only a renderer
   *  that draws the same photo again gains from them: the live view's. */
  checkpoints?: boolean;
}

export class PrepassRunner {
  private readonly gl: WebGL2RenderingContext;
  private readonly host: PrepassHost;
  // Whether float targets render: RGBA16F intermediates, else RGBA8 (working).
  private readonly float: boolean;
  private readonly working: TexFormat;
  private ppTex: [WebGLTexture | null, WebGLTexture | null] = [null, null];
  private ppFbo: [WebGLFramebuffer | null, WebGLFramebuffer | null] = [null, null];
  private ppW = 0;
  private ppH = 0;
  private resultTargets = new Map<string, Target>();
  // The input fetchInput reads when it isn't the source as uploaded: the split,
  // or the source resampled to pass size. Drawn again by each stage that needs it.
  private input: Target | null = null;
  // Each stage's checkpoints, by the index of the kept pass.
  private checkpoints = new Map<string, Map<number, Checkpoint>>();
  // The source epoch the checkpoints were drawn from.
  private checkpointEpoch = -1;
  private readonly keepsCheckpoints: boolean;
  // Stages a checkpoint couldn't be allocated for: they run whole until the
  // stage set changes.
  private uncheckpointed = new Set<string>();
  private warnedCheckpoint = new Set<string>();
  // Stages the GPU refused an input target to: until the stage set changes
  // they read the source, as without float render targets.
  private inputRefused = new Set<string>();
  private warnedInput = new Set<string>();
  // The sizes the GPU refused the ping-pong pair and each stage's result
  // target at: not asked for again until the size, the source or the stage set
  // changes.
  private pingPongRefused: { w: number; h: number } | null = null;
  private resultRefused = new Map<string, { w: number; h: number }>();
  // Cached pass programs, keyed by stageId|passIdx|source hash|process version,
  // with the stage that owns them.
  private passPrograms = new Map<string, PassProgram>();
  // Each stage's passes as the set holding it declared them (passesPrint), so a
  // new set tells the stages it changed from the ones it kept.
  private prints = new Map<string, string>();
  // A layered program's prepass results: one array, a layer per stage that has run.
  private readonly layers: StageResultLayers;
  // The array generation the `layer:` signatures were drawn into.
  private layerGeneration = 0;
  // Per-stage signature of the last prepass run; lets run() skip the
  // (expensive) passes and reuse the cached result when nothing it depends on
  // (source, this stage's pass params, dims, linearization, and for a
  // reads-current stage its split token) changed — so editing unrelated
  // controls (exposure, etc.) doesn't recompute denoise. Kept with the source
  // and size the result was drawn from, which a put-off copy may still show.
  private sigs = new Map<string, { sig: string; srcSig: string; w: number; h: number }>();
  // Prepass stages whose program failed to compile/link under this stage set,
  // skipped thereafter so one bad stage can't throw out of render() and freeze the view.
  private failed = new Set<string>();
  // The stages whose passes failed this frame, by the id of the stage that owns
  // the pass programs, with what the failure threw.
  private failures: { stageId: string; error: unknown }[] = [];
  private warnedOverflow = new Set<string>();
  private warnedRefused = new Set<string>();
  private warnedSplitFallback = new Set<string>();
  private warnedDenoiseSkipped = false;
  // Each prepass stage's result this frame, bound onto the main program before the draw.
  private results: PrepassResult[] = [];
  // Active prepass stages the last frame had no texture unit, result layer or
  // target for.
  private overflowed: string[] = [];
  // Copies whose prepass this frame put off with no earlier result to show:
  // they apply nothing until it runs.
  private unshown = new Set<string>();
  private copiesPending = false;
  // True when the built-in denoise prepass produced a real float result this
  // frame (active, float targets, not failed). Drives uDenoiseReady so the
  // inline swap of `lin` never applies a raw fallback texture.
  private denoiseReady = false;
  // Cumulative draws, for diagnostics and the cost tests.
  private draws = { split: 0, pass: 0 };

  constructor(gl: WebGL2RenderingContext, float: boolean, host: PrepassHost, opts: PrepassOptions = {}) {
    this.gl = gl;
    this.float = float;
    this.host = host;
    this.keepsCheckpoints = opts.checkpoints ?? false;
    this.working = workingFormat(gl, float);
    this.layers = new StageResultLayers(gl, float, () =>
      host.note(
        "stage-results",
        "Stage results are stored at 8-bit, clipped to 0–1, because this GPU has no float render targets.",
      ),
    );
  }

  /** Each stage's result this frame, for the main draw to bind. */
  get frameResults(): readonly PrepassResult[] {
    return this.results;
  }

  /** Active stages the last frame had no texture unit, result layer or target
   *  (one the GPU refused) for. */
  get overflowedStages(): readonly string[] {
    return this.overflowed;
  }

  /** The stages whose passes failed in the last frame, which bound the raw
   *  source as their result: the stage owning each pass program and its error. */
  get failedPasses(): readonly { stageId: string; error: unknown }[] {
    return this.failures;
  }

  /** Whether the last frame put off a mask copy's prepass. */
  get copiesPutOff(): boolean {
    return this.copiesPending;
  }

  /** Whether the built-in denoise prepass produced a real result this frame. */
  get denoised(): boolean {
    return this.denoiseReady;
  }

  /** Cumulative split and pass draws. */
  get drawCounts(): { readonly split: number; readonly pass: number } {
    return { ...this.draws };
  }

  /** Whether a mask copy's prepass was put off this frame with no result to show. */
  unshownCopy(stageId: string): boolean {
    return this.unshown.has(stageId);
  }

  /** The shared result array, or its stand-in. */
  layersTexture(): WebGLTexture {
    return this.layers.texture();
  }

  /** A new stage set. A stage that left it (its extension was turned off)
   *  takes its pass programs, cached result and targets with it, and one whose
   *  passes changed (extension update / dev-folder reload) its programs and
   *  cached result; one in both sets as it was keeps them, so a stage joining
   *  the set (woken from dormancy) costs the others no pass. Every failed
   *  stage gets a fresh compile attempt. Only the stages that read a layer in
   *  the program now selected keep one: a set within the sampler budget has no
   *  use for the array, the one large result texture, and what it held is stale.
   *  A stage that reads a layer now gives back the full-size target of its own. */
  stageSetChanged(prepass: readonly PrepassStage[]): void {
    const before = this.prints;
    const next = new Map(prepass.map((s) => [s.stageId, passesPrint(s)]));
    const kept = (stageId: string): boolean => {
      const print = next.get(stageId);
      return print !== undefined && print === before.get(stageId);
    };
    this.prints = next;
    for (const [key, pass] of this.passPrograms) {
      if (kept(pass.owner)) continue;
      this.gl.deleteProgram(pass.program);
      this.passPrograms.delete(key);
    }
    for (const stageId of [...this.checkpoints.keys()]) if (!kept(stageId)) this.dropCheckpoints(stageId);
    this.uncheckpointed.clear();
    this.inputRefused.clear();
    this.pingPongRefused = null;
    this.resultRefused.clear();
    const layered = new Set(prepass.filter((s) => s.layerUniform !== undefined).map((s) => s.stageId));
    for (const key of this.sigs.keys()) {
      const stageId = key.startsWith(LAYER_KEY) ? key.slice(LAYER_KEY.length) : key;
      if (!kept(stageId) || (stageId !== key && !layered.has(stageId))) this.sigs.delete(key);
    }
    for (const stageId of layered) {
      this.sigs.delete(stageId);
      const t = this.resultTargets.get(stageId);
      if (!t) continue;
      this.deleteTarget(t);
      this.resultTargets.delete(stageId);
    }
    this.failed.clear();
    this.releaseTargets(prepass);
    this.layers.release(layered);
    this.forgetDroppedLayers();
  }

  // A layer's signature holds only for the array it was drawn into.
  private forgetDroppedLayers(): void {
    if (this.layers.generation === this.layerGeneration) return;
    this.layerGeneration = this.layers.generation;
    for (const key of [...this.sigs.keys()]) if (key.startsWith(LAYER_KEY)) this.sigs.delete(key);
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.ppTex) if (t) gl.deleteTexture(t);
    for (const f of this.ppFbo) if (f) gl.deleteFramebuffer(f);
    for (const t of this.resultTargets.values()) this.deleteTarget(t);
    this.resultTargets.clear();
    for (const stageId of [...this.checkpoints.keys()]) this.dropCheckpoints(stageId);
    this.dropInput();
    this.layers.dispose();
    for (const e of this.passPrograms.values()) gl.deleteProgram(e.program);
    this.passPrograms.clear();
  }

  // A prepass target in the working format, (re)allocated on the active unit.
  private allocTarget(tex: WebGLTexture, fbo: WebGLFramebuffer, w: number, h: number): boolean {
    return allocateInto(this.gl, tex, fbo, this.working, w, h, this.gl.LINEAR);
  }

  // Lazily (re)allocate the two ping-pong targets. RGBA16F when float render
  // targets are supported, else RGBA8: the denoiser is then kept out
  // (denoiserRunnable) and the core NR block takes over, while extension
  // prepasses run clipped to [0, 1]. Returns false when the GPU refuses them
  // (prepasses are then skipped), and goes on refusing at that size without
  // asking again.
  private ensurePingPong(w: number, h: number): boolean {
    const gl = this.gl;
    if (this.ppTex[0] && this.ppW === w && this.ppH === h) return true;
    if (this.pingPongRefused?.w === w && this.pingPongRefused.h === h) return false;
    for (let i = 0; i < 2; i++) {
      if (!this.ppTex[i]) this.ppTex[i] = gl.createTexture();
      if (!this.ppFbo[i]) this.ppFbo[i] = gl.createFramebuffer();
      if (!this.allocChecked(this.ppTex[i]!, this.ppFbo[i]!, w, h)) {
        this.dropPingPong();
        this.pingPongRefused = { w, h };
        return false;
      }
    }
    this.ppW = w;
    this.ppH = h;
    this.pingPongRefused = null;
    return true;
  }

  private dropPingPong(): void {
    const gl = this.gl;
    for (const t of this.ppTex) gl.deleteTexture(t);
    for (const f of this.ppFbo) gl.deleteFramebuffer(f);
    this.ppTex = [null, null];
    this.ppFbo = [null, null];
    this.ppW = 0;
    this.ppH = 0;
  }

  // Free the result target of every stage no longer in `prepass`, and the
  // ping-pong pair once no prepass stage is left.
  private releaseTargets(prepass: readonly PrepassStage[]): void {
    const kept = new Set(prepass.map((s) => s.stageId));
    for (const [stageId, t] of this.resultTargets) {
      if (kept.has(stageId)) continue;
      this.deleteTarget(t);
      this.resultTargets.delete(stageId);
    }
    if (!prepass.some((s) => s.inputSource !== undefined)) this.dropInput();
    if (prepass.length > 0) return;
    this.dropPingPong();
  }

  // An idle stage keeps its result while it is still the answer for this
  // source at this size, so turning it back on (or dragging through zero)
  // draws nothing. Once the source or size moves on, that result can never be
  // a cache hit again, and it goes; the ping-pong pair goes with the last of
  // them when nothing runs this frame.
  private releaseStale(active: readonly boolean[], held: ReadonlySet<number>, frame: PrepassFrame): void {
    frame.stages.forEach((stage, i) => {
      if (!active[i] && !held.has(i)) this.dropStaleCheckpoints(stage.stageId, frame);
      // A layered stage's result is its layer; a target it kept from version 1
      // frames is idle here, however active the stage is.
      const layered = stage.layerUniform !== undefined;
      if (!layered && (active[i] || held.has(i))) return;
      const t = this.resultTargets.get(stage.stageId);
      if (!t) return;
      const last = this.sigs.get(stage.stageId);
      if (last && last.srcSig === frame.srcSig && t.w === frame.w && t.h === frame.h) return;
      this.deleteTarget(t);
      this.resultTargets.delete(stage.stageId);
      this.sigs.delete(stage.stageId);
    });
    if (!frame.stages.some((s, i) => active[i] && s.inputSource !== undefined)) this.dropInput();
    if (active.some(Boolean) || this.resultTargets.size > 0 || !this.ppTex[0]) return;
    this.dropPingPong();
  }

  // The stage's result target at w×h, or null when the GPU refuses it. A
  // refused target goes with the result it held, so an older image is never
  // read as this size's, and isn't asked for again at that size.
  private ensureStageResult(stageId: string, w: number, h: number): Target | null {
    const gl = this.gl;
    const refused = this.resultRefused.get(stageId);
    if (refused?.w === w && refused.h === h) return null;
    let t = this.resultTargets.get(stageId);
    if (!t) {
      t = { tex: created(gl.createTexture()), fbo: created(gl.createFramebuffer()), w: 0, h: 0 };
      this.resultTargets.set(stageId, t);
    }
    if (t.w !== w || t.h !== h) {
      if (!this.allocChecked(t.tex, t.fbo, w, h)) {
        this.deleteTarget(t);
        this.resultTargets.delete(stageId);
        this.sigs.delete(stageId);
        this.resultRefused.set(stageId, { w, h });
        return null;
      }
      t.w = w;
      t.h = h;
      this.resultRefused.delete(stageId);
    }
    return t;
  }

  // An active stage the GPU refused a target to: it overflows, as one with no
  // unit left does, warning once.
  private refusedTarget(stageId: string, target: string): void {
    this.overflowed.push(stageId);
    warnOnce(this.warnedRefused, stageId, () => `[render] prepass stage '${stageId}' got no ${target} (the GPU refused it) and will not run.`);
  }

  private passProgram(
    key: string,
    owner: string,
    name: string,
    sources: { fragment: string; vertex?: string },
    bindings: ContributedBinding[],
  ) {
    let e = this.passPrograms.get(key);
    if (e) return e;
    const stageIds = new Set([owner]);
    this.host.builds?.started(stageIds);
    let program: WebGLProgram;
    try {
      program = createProgram(this.gl, sources.vertex ?? PASS_VERTEX_SHADER, sources.fragment, name);
    } catch (err) {
      this.host.builds?.ended(stageIds, buildOutcome(err));
      throw err;
    }
    this.host.builds?.ended(stageIds, "built");
    const gl = this.gl;
    const locs: Record<string, WebGLUniformLocation | null> = {};
    for (const n of [
      "uPrevPass", "uTexel", "uPassIndex", "uPassCount", "uWholeDraw",
      "uPrevRaw", "uSrcLinear", "uIsFallbackPreview", "uApplyBaseCurve", "uSourceSize", SOURCE_IMAGE_UNIFORM,
      INPUT_IMAGE_UNIFORM, INPUT_IS_SOURCE_UNIFORM,
    ]) {
      locs[n] = gl.getUniformLocation(program, n);
    }
    for (const b of bindings) locs[b.glslName] = gl.getUniformLocation(program, b.glslName);
    e = { owner, program, locs };
    this.passPrograms.set(key, e);
    return e;
  }

  // True when the stage actually does something this frame: the param bag holds
  // a non-trivial value for any of its keys, or one of its `{ key, max }` passes
  // resolves above 0 draws, the uniform's default included. Lets an untouched
  // denoise stage cost nothing (its inline glsl early-outs anyway). Booleans and
  // vectors count alongside numbers: a bool/vector-driven prepass used to be seen
  // as inactive (only non-zero numbers qualified), so such stages never ran.
  // The draw-count test exists because the inline runs with the same defaults:
  // a stage whose count defaults above 0 otherwise sat idle on an untouched
  // photo and its inline read the idle fallback (the raw source) as its result.
  // It covers `{ key, max }` counts only, so fixed counts and plain non-zero
  // uniform defaults (Moiré's `pattern`/`edge` at 50) don't start every such
  // stage on every photo. A mask copy whose mask applies nothing (hidden, 0
  // opacity) is idle too. A stage that declares dormantWhen is active exactly
  // while that rule doesn't hold.
  private active(stage: PrepassStage, frame: PrepassFrame): boolean {
    if (frame.copySlots.get(stage.stageId) === -1) return false;
    const { bag } = frame;
    if (stage.dormant) return !isDormant(stage.dormant, bag);
    const prefix = stage.stageId + ".";
    for (const [k, v] of Object.entries(bag)) {
      if (!k.startsWith(prefix)) continue;
      if (paramIsActive(v)) return true;
    }
    return stage.passes.some((pass) => pass.drawCount !== undefined && passDraws(pass, bag) > 0);
  }

  /** Runs every prepass stage against the frame's source (the develop source,
   *  patched when retouch is active). Leaves results in per-stage targets or
   *  layers of the shared array, and records the unit and layer bindings the
   *  main draw applies (frameResults). */
  run(frame: PrepassFrame): void {
    this.results = [];
    this.failures = [];
    this.overflowed = [];
    this.unshown = new Set();
    this.copiesPending = false;
    this.denoiseReady = false; // set true below only if the denoise prepass yields a real result
    if (frame.stages.length === 0) return;
    if (frame.epoch !== this.checkpointEpoch) {
      for (const stageId of [...this.checkpoints.keys()]) this.dropCheckpoints(stageId);
      this.checkpointEpoch = frame.epoch;
      // A refusal may have been transient: a new photo asks again.
      this.pingPongRefused = null;
      this.resultRefused.clear();
    }
    const { srcTex, w, h } = frame;
    // The ping-pong pair is two full-size targets, so it's made only once some
    // stage runs, not for every photo opened with a prepass extension installed.
    const runs = frame.stages.map(
      (s) =>
        !this.failed.has(s.stageId) &&
        this.active(s, frame) &&
        stageDraws(s, frame.bag) > 0 &&
        (s.stageId !== BUILTIN_DENOISE_ID || this.denoiserRunnable()),
    );
    const haveTargets = runs.some(Boolean) && this.ensurePingPong(w, h);
    if (!haveTargets) {
      frame.stages.forEach((s, i) => {
        if (runs[i]) this.refusedTarget(s.stageId, "ping-pong pair");
      });
    }

    // The units are a hard budget, so they go to the stages that actually
    // produce a result this frame; every inactive/failed stage shares the next
    // free unit, holding the raw source. EVERY stage gets an explicit binding — a
    // sampler that is never uniform1i'd defaults to unit 0 and silently reads
    // uImage, which is exactly the garbage an active-but-starved stage must never
    // see (SafeLight #96: the Contrast Equalizer's coarsest band decoded the raw
    // image as wavelet detail and crushed the render to black). On a layered
    // program the shared result array takes the pool's first unit, and only
    // stages that name their result sampler take the rest.
    const pool = frame.units;
    const layered = frame.stages.some((s) => s.layerUniform !== undefined);
    const units = layered ? pool.slice(1) : pool;
    // A stage whose passes all resolve to 0 draws has nothing to run: it is
    // idle this frame, split included.
    const active = runs.map((r) => haveTargets && r);
    if (!this.float && active.some(Boolean)) {
      this.host.note(
        "prepass",
        "Extension prepasses run at 8-bit, clipped to 0–1, because this GPU has no float render targets.",
      );
    }
    const held = this.putOffCopies(active, frame);
    this.releaseStale(active, held, frame);
    // Layers for every active stage at once, so the array grows at most once a frame.
    if (layered) {
      const ids = frame.stages
        .filter((s, i) => active[i] && s.layerUniform !== undefined)
        .map((s) => s.stageId);
      this.layers.reserve(ids, w, h, frame.epoch);
      this.forgetDroppedLayers();
    }
    const unitOf = new Map<number, number>();
    let next = 0;
    for (let i = 0; i < frame.stages.length; i++) {
      const sampled = frame.stages[i].layerUniform === undefined;
      if (active[i] && sampled && next < units.length) unitOf.set(i, units[next++]);
    }
    const spareUnit = next < units.length ? units[next] : -1;

    for (let i = 0; i < frame.stages.length; i++) {
      const stage = frame.stages[i];
      if (stage.layerUniform !== undefined) {
        this.runLayerStage(stage, stage.layerUniform, active[i], frame, held.has(i));
        continue;
      }
      const unit = unitOf.get(i);
      if (unit === undefined) {
        if (active[i]) {
          this.overflowed.push(stage.stageId);
          warnOnce(
            this.warnedOverflow,
            stage.stageId,
            () =>
              `[render] prepass stage '${stage.stageId}' exceeds the ${units.length}-unit ` +
              `budget and will not run; its inline reads another stage's result.`,
          );
        }
        continue; // resolved after the loop, once the winners' textures are known
      }

      // Cache hit: nothing the prepass depends on changed — reuse the result and
      // skip the passes entirely.
      const { split, sig, srcSig } = this.prepassKey(stage, frame);
      const cached = this.resultTargets.get(stage.stageId);
      const current = held.has(i) || this.sigs.get(stage.stageId)?.sig === sig;
      if (cached && cached.w === w && cached.h === h && current) {
        this.results.push({ kind: "unit", resultUniform: stage.resultUniform, tex: cached.tex, unit });
        if (stage.stageId === BUILTIN_DENOISE_ID) this.denoiseReady = true;
        continue;
      }

      // A throwing pass (e.g. a shader that fails to compile) must not crash the
      // whole render. Disable just this stage for the session and fall back to
      // the raw source so the rest of the pipeline keeps working.
      try {
        // The stage's dedicated target, so the next stage's ping-pong doesn't
        // clobber the result.
        const target = this.ensureStageResult(stage.stageId, w, h);
        if (!target) {
          this.refusedTarget(stage.stageId, "result target");
          this.results.push({ kind: "unit", resultUniform: stage.resultUniform, tex: srcTex, unit });
          continue;
        }
        const drawnSig = this.drawStagePasses(stage, split, srcSig, frame, target.fbo) ? sig : this.drawWithoutInput(stage, frame, target.fbo);
        this.sigs.set(stage.stageId, { sig: drawnSig, srcSig: frame.srcSig, w, h });
        this.results.push({ kind: "unit", resultUniform: stage.resultUniform, tex: target.tex, unit });
        if (stage.stageId === BUILTIN_DENOISE_ID) this.denoiseReady = true;
      } catch (err) {
        this.fail(stage, err);
        this.results.push({ kind: "unit", resultUniform: stage.resultUniform, tex: srcTex, unit });
      }
    }

    // Stages that got no unit: inactive/failed ones share the spare slot with
    // the raw source bound (their inline gates itself off, so the value is
    // never used). When every slot went to an active stage there is no spare,
    // so the rest alias the first winner's binding — a complete texture with
    // bounded values, never the unit-0 image.
    const winner = this.results.find((r): r is UnitResult => r.kind === "unit");
    const fallback =
      spareUnit >= 0
        ? { tex: srcTex, unit: spareUnit }
        : winner
          ? { tex: winner.tex, unit: winner.unit }
          : null;
    if (fallback) {
      for (let i = 0; i < frame.stages.length; i++) {
        const stage = frame.stages[i];
        if (stage.layerUniform === undefined && !unitOf.has(i)) {
          this.results.push({ kind: "unit", resultUniform: stage.resultUniform, ...fallback });
        }
      }
    }
  }

  // At most maskCopyPrepassesPerFrame mask copies run their passes in a frame
  // drawn to the canvas, in mask order; the rest wait for the frames after it
  // (prepassPending). A waiting copy that holds a result from this source at
  // this size shows it meanwhile (held); one that doesn't applies nothing
  // (unshown, and idle this frame). Cache hits cost nothing and never wait.
  private putOffCopies(active: boolean[], frame: PrepassFrame): Set<number> {
    const held = new Set<number>();
    const budget = frame.copyBudget;
    if (budget === Infinity) return held;
    let started = 0;
    frame.stages.forEach((stage, i) => {
      if (!active[i] || stage.passesOf === undefined) return;
      const layered = stage.layerUniform !== undefined;
      const last = this.sigs.get(layered ? `${LAYER_KEY}${stage.stageId}` : stage.stageId);
      if (last?.sig === this.prepassKey(stage, frame).sig) return;
      if (started < budget) {
        started++;
        return;
      }
      this.copiesPending = true;
      const target = this.resultTargets.get(stage.stageId);
      const sameSource =
        last !== undefined &&
        last.srcSig === frame.srcSig &&
        last.w === frame.w &&
        last.h === frame.h &&
        (layered || (target?.w === frame.w && target.h === frame.h));
      if (sameSource) {
        held.add(i);
      } else {
        active[i] = false;
        this.unshown.add(stage.stageId);
      }
    });
    return held;
  }

  // A layered stage: its result goes to its layer of the shared array, cached
  // apart from the result a version 1 frame keeps in the stage's own target, so
  // frames of the two versions never take each other's.
  private runLayerStage(
    stage: PrepassStage,
    layerUniform: string,
    active: boolean,
    frame: PrepassFrame,
    held: boolean,
  ): void {
    const layer = active ? this.layers.layer(stage.stageId) : -1;
    if (active && layer < 0) {
      this.overflowed.push(stage.stageId);
      warnOnce(
        this.warnedRefused,
        stage.stageId,
        () =>
          `[render] prepass stage '${stage.stageId}' got no result layer (the GPU refused ` +
          `the shared result array) and will not run.`,
      );
    }
    if (layer < 0) {
      this.results.push({ kind: "layer", layerUniform, layer: -1 });
      return;
    }
    // A dropped layer is never read through an old signature: the signatures go
    // with the array they were drawn into (forgetDroppedLayers).
    const cacheKey = `${LAYER_KEY}${stage.stageId}`;
    try {
      const { split, sig, srcSig } = this.prepassKey(stage, frame);
      if (!held && this.sigs.get(cacheKey)?.sig !== sig) {
        const target = this.layers.target(stage.stageId);
        const drawnSig = this.drawStagePasses(stage, split, srcSig, frame, target) ? sig : this.drawWithoutInput(stage, frame, target);
        this.sigs.set(cacheKey, { sig: drawnSig, srcSig: frame.srcSig, w: frame.w, h: frame.h });
      }
      this.results.push({ kind: "layer", layerUniform, layer });
      if (stage.stageId === BUILTIN_DENOISE_ID) this.denoiseReady = true;
    } catch (err) {
      this.fail(stage, err);
      this.results.push({ kind: "layer", layerUniform, layer: -1 });
    }
  }

  private fail(stage: PrepassStage, err: unknown): void {
    console.error(`[render] prepass stage '${stage.stageId}' failed; disabling it`, err);
    this.failed.add(stage.stageId);
    this.dropCheckpoints(stage.stageId);
    this.failures.push({ stageId: stage.passesOf ?? stage.stageId, error: err });
  }

  // The split a stage's prepass is drawn from this frame, if any, what its
  // input is drawn from (the source, with the split's token for a split), and
  // the signature of everything its result depends on.
  private prepassKey(
    stage: PrepassStage,
    frame: PrepassFrame,
  ): { split: StageSplit | null; srcSig: string; sig: string } {
    const split = stage.split && !this.inputRefused.has(stage.stageId) && this.splitDrawable(stage.stageId) ? stage.split : null;
    const srcSig = split
      ? `${frame.srcSig}|split:${frame.splitToken(stage.stageId, split)}`
      : frame.srcSig;
    return { split, srcSig, sig: prefixSig(stage, frame, srcSig, stage.passes.length - 1) };
  }

  // Draws a stage again after the GPU refused its input target, now reading
  // the source, and returns the signature it was drawn under.
  private drawWithoutInput(stage: PrepassStage, frame: PrepassFrame, target: WebGLFramebuffer): string {
    const { split, srcSig, sig } = this.prepassKey(stage, frame);
    if (!this.drawStagePasses(stage, split, srcSig, frame, target)) {
      throw new Error(`stage '${stage.stageId}' asked for an input target again`);
    }
    return sig;
  }

  // Draws a stage's passes over the ping-pong pair, after its split draw when it
  // reads the current image. The last draw goes to `target`, the stage's result,
  // so nothing is copied after it. Passes sample the ping-pong textures, the
  // source and the stage's input only, never a result, so the target is never
  // read while it is written. A pass that names its region draws only that,
  // except on the stage's first two draws, which fill a pair that holds another
  // stage's leftovers, and its last, which fills the result. A stage with a
  // checkpoint drawn under this frame's signature starts after that pass, from
  // the checkpoint in both targets; its draws keep the numbers a full run gives
  // them, so the same ones are drawn whole and the result is the full run's.
  // False, having drawn nothing, when the GPU refuses the input target.
  private drawStagePasses(
    stage: PrepassStage,
    split: StageSplit | null,
    srcSig: string,
    frame: PrepassFrame,
    target: WebGLFramebuffer,
  ): boolean {
    const gl = this.gl;
    const counts = stage.passes.map((p) => passDraws(p, frame.bag));
    let remaining = stageDraws(stage, frame.bag);
    if (remaining === 0) throw new Error(`stage '${stage.stageId}' has no draw to write its result`);
    const { srcTex, applyRetouch, w, h } = frame;
    const resumed = this.resumePoint(stage, frame, srcSig);
    const first = resumed + 1;
    let drawn = counts.slice(0, first).reduce((a, b) => a + b, 0);
    remaining -= drawn;
    // A mask copy draws with its stage's programs (same source, its own values).
    const owner = stage.passesOf ?? stage.stageId;
    const cost = drawCost(w, h, remaining);
    const watched = this.host.draws?.started(owner, cost) ?? false;
    let finished = false;
    try {
      const fetches = stage.passes.some((p, i) => i >= first && counts[i] > 0 && p.fetchesInput);
      const input = fetches ? this.stageInput(stage, split, frame) : null;
      if (input === undefined) return false;
      let readTex: WebGLTexture = srcTex;
      let prevRaw = true;            // first read linearizes + base-curves the source
      let writeIdx = 0;
      if (resumed >= 0) {
        this.restoreCheckpoint(stage.stageId, resumed);
        readTex = this.ppTex[0]!;
        prevRaw = false;
        writeIdx = 1;
      } else if (split && input) {
        readTex = input.tex;
        prevRaw = false;
      } else if (split) {
        this.host.drawSplit(split.index, srcTex, applyRetouch, { fbo: this.ppFbo[0], w, h });
        this.draws.split++;
        readTex = this.ppTex[0]!;
        prevRaw = false;
        writeIdx = 1;
      }
      const lent = input && !input.isSource ? this.boundAt(INPUT_UNIT) : undefined;
      try {
        for (let passIdx = first; passIdx < stage.passes.length; passIdx++) {
          const pass = stage.passes[passIdx];
          // Distinguish passes by index AND source hash: two passes of one stage
          // with equal-length sources (separable H/V blur) share a length, so a
          // length-only key collided and reused the first pass's program.
          const key = `${owner}|${passIdx}|${simpleHash(pass.fragmentSource + (pass.vertexSource ?? ""))}|pv${frame.processVersion}`;
          const name = `pass ${passIdx + 1} of stage "${owner}"`;
          const sources = {
            fragment: withProcessVersion(pass.fragmentSource, frame.processVersion),
            ...(pass.vertexSource === undefined ? {} : { vertex: withProcessVersion(pass.vertexSource, frame.processVersion) }),
          };
          const prog = this.passProgram(key, owner, name, sources, pass.bindings);
          const draws = counts[passIdx];
          for (let it = 0; it < draws; it++) {
            const last = --remaining === 0;
            this.drawPass(prog, last ? target : this.ppFbo[writeIdx], frame, pass.bindings, {
              readTex, it, draws, whole: last || drawn < 2, prevRaw, input,
            });
            this.draws.pass++;
            drawn++;
            readTex = this.ppTex[writeIdx]!;
            prevRaw = false;
            writeIdx = 1 - writeIdx;
          }
          if (pass.keep && draws > 0 && remaining > 0) {
            this.keepCheckpoint(stage, passIdx, this.ppFbo[1 - writeIdx]!, frame, srcSig);
          }
        }
      } finally {
        if (lent !== undefined) {
          gl.activeTexture(gl.TEXTURE0 + INPUT_UNIT);
          gl.bindTexture(gl.TEXTURE_2D, lent);
          gl.activeTexture(gl.TEXTURE0);
        }
      }
      // The last draw left `target` bound.
      if (watched) readOnePixel(gl, this.float ? gl.FLOAT : gl.UNSIGNED_BYTE);
      finished = true;
      return true;
    } finally {
      if (watched && !gl.isContextLost()) this.host.draws?.ended(owner, cost, finished);
    }
  }

  // One draw of a pass program into `fbo`: `readTex` is the previous draw, or
  // while `prevRaw` the stage's input as the first draw reads it.
  private drawPass(
    prog: PassProgram,
    fbo: WebGLFramebuffer | null,
    frame: PrepassFrame,
    bindings: readonly ContributedBinding[],
    draw: { readTex: WebGLTexture; it: number; draws: number; whole: boolean; prevRaw: boolean; input: StageInput | null },
  ): void {
    const gl = this.gl;
    const { w, h, bag } = frame;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.program);
    const sourceLoc = prog.locs[SOURCE_IMAGE_UNIFORM];
    if (sourceLoc) {
      gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, frame.srcTex);
      gl.uniform1i(sourceLoc, SCRATCH_UNIT);
    }
    // The locations are null where the pass doesn't name fetchInput (not
    // declared); the calls are no-ops then.
    if (draw.input) {
      const drawnInput = !draw.input.isSource;
      if (drawnInput) {
        gl.activeTexture(gl.TEXTURE0 + INPUT_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, draw.input.tex);
      }
      gl.uniform1i(prog.locs[INPUT_IMAGE_UNIFORM], drawnInput ? INPUT_UNIT : SCRATCH_UNIT);
      gl.uniform1i(prog.locs[INPUT_IS_SOURCE_UNIFORM], drawnInput ? 0 : 1);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, draw.readTex);
    gl.uniform1i(prog.locs.uPrevPass!, 0);
    gl.uniform2f(prog.locs.uTexel!, 1 / w, 1 / h);
    gl.uniform1i(prog.locs.uPassIndex!, draw.it);
    gl.uniform1i(prog.locs.uPassCount!, draw.draws);
    // Null without a region (not declared); a no-op then.
    gl.uniform1i(prog.locs.uWholeDraw, draw.whole ? 1 : 0);
    gl.uniform1i(prog.locs.uPrevRaw!, draw.prevRaw ? 1 : 0);
    gl.uniform1i(prog.locs.uSrcLinear!, frame.linear ? 1 : 0);
    // Null where the pass doesn't name it (not declared, see stage-injection.ts); a no-op then.
    gl.uniform2f(prog.locs.uSourceSize, frame.sourceWidth, frame.sourceHeight);
    gl.uniform1i(prog.locs.uIsFallbackPreview!, frame.isFallbackPreview ? 1 : 0);
    gl.uniform1i(prog.locs.uApplyBaseCurve!, frame.baseCurve);
    for (const b of bindings) {
      const loc = prog.locs[b.glslName];
      if (loc == null) continue;
      bindUniformByType(gl, loc, b.glslType, boundValue(bag, b), b.length);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // What fetchInput reads in a stage's draws. The source itself where the
  // passes draw at its size, without float render targets, whose 8-bit input
  // would clip it, and once the GPU has refused the input target. Otherwise
  // the input target, drawn now: the split, or the source resampled as the
  // stage's first draw reads it. Undefined, having drawn nothing, when the
  // GPU refuses the target now: the stage then reads the source.
  private stageInput(stage: PrepassStage, split: StageSplit | null, frame: PrepassFrame): StageInput | undefined {
    const { srcTex, w, h } = frame;
    const { inputSource } = stage;
    const atSize = frame.srcW === w && frame.srcH === h;
    const refused = this.inputRefused.has(stage.stageId);
    if (!split && (atSize || !this.float || refused || inputSource === undefined)) return { tex: srcTex, isSource: true };
    const input = this.ensureInput(w, h);
    if (!input) {
      this.inputRefused.add(stage.stageId);
      warnOnce(
        this.warnedInput,
        stage.stageId,
        () =>
          `[render] prepass stage '${stage.stageId}' got no target for its input (the GPU refused it), so it reads ` +
          `the source instead: fetchInput reads the source texel each pass texel falls in.`,
      );
      return undefined;
    }
    if (split) {
      this.host.drawSplit(split.index, srcTex, frame.applyRetouch, { fbo: input.fbo, w, h });
    } else if (inputSource !== undefined) {
      const owner = stage.passesOf ?? stage.stageId;
      const key = `${owner}|input|${simpleHash(inputSource)}|pv${frame.processVersion}`;
      const sources = { fragment: withProcessVersion(inputSource, frame.processVersion) };
      const prog = this.passProgram(key, owner, `input of stage "${owner}"`, sources, []);
      this.drawPass(prog, input.fbo, frame, [], { readTex: srcTex, it: 0, draws: 1, whole: true, prevRaw: true, input: null });
    }
    this.draws.split++;
    return { tex: input.tex, isSource: false };
  }

  // The input target at w×h, or null when the GPU refuses it.
  private ensureInput(w: number, h: number): Target | null {
    const gl = this.gl;
    const input = this.input ?? { tex: created(gl.createTexture()), fbo: created(gl.createFramebuffer()), w: 0, h: 0 };
    this.input = input;
    if (input.w !== w || input.h !== h) {
      if (!this.allocChecked(input.tex, input.fbo, w, h)) {
        this.dropInput();
        return null;
      }
      input.w = w;
      input.h = h;
    }
    return input;
  }

  // (Re)allocates a target on the scratch unit, reading the errors the
  // allocation raises as well as the framebuffer's completeness: a refused
  // texImage2D on a texture that held an image leaves the old one complete.
  private allocChecked(tex: WebGLTexture, fbo: WebGLFramebuffer, w: number, h: number): boolean {
    const gl = this.gl;
    drainErrors(gl);
    gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
    const complete = this.allocTarget(tex, fbo, w, h);
    gl.activeTexture(gl.TEXTURE0);
    return gl.getError() === gl.NO_ERROR && complete;
  }

  private dropInput(): void {
    if (!this.input) return;
    this.deleteTarget(this.input);
    this.input = null;
  }

  private deleteTarget(t: Target): void {
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  // The texture bound at `unit`, leaving TEXTURE0 active.
  private boundAt(unit: number): WebGLTexture | null {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    const bound: WebGLTexture | null = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.activeTexture(gl.TEXTURE0);
    return bound;
  }

  // The kept pass a stage resumes after: the last whose checkpoint was drawn
  // under this frame's signature up to that pass, or -1 to draw every pass.
  private resumePoint(stage: PrepassStage, frame: PrepassFrame, srcSig: string): number {
    if (!this.keepsCheckpoints) return -1;
    const kept = this.checkpoints.get(stage.stageId);
    if (!kept) return -1;
    for (let passIdx = stage.passes.length - 2; passIdx >= 0; passIdx--) {
      const c = kept.get(passIdx);
      if (c && c.w === frame.w && c.h === frame.h && c.sig === prefixSig(stage, frame, srcSig, passIdx)) return passIdx;
    }
    return -1;
  }

  // Copies the state the last draw left in `from` into the pass's checkpoint.
  // By the region rule that target holds the whole state: every texel the
  // draw left alone it holds from two draws back, unchanged since.
  private keepCheckpoint(
    stage: PrepassStage,
    passIdx: number,
    from: WebGLFramebuffer,
    frame: PrepassFrame,
    srcSig: string,
  ): void {
    const gl = this.gl;
    const { stageId } = stage;
    if (!this.keepsCheckpoints || this.uncheckpointed.has(stageId)) return;
    const { w, h } = frame;
    const kept = this.checkpoints.get(stageId) ?? new Map<number, Checkpoint>();
    this.checkpoints.set(stageId, kept);
    let c = kept.get(passIdx);
    if (!c || c.w !== w || c.h !== h) {
      const tex = c?.tex ?? created(gl.createTexture());
      const fbo = c?.fbo ?? created(gl.createFramebuffer());
      const complete = this.allocChecked(tex, fbo, w, h);
      c = { tex, fbo, w, h, sig: "", srcSig: "" };
      kept.set(passIdx, c);
      if (!complete) {
        this.dropCheckpoints(stageId);
        this.uncheckpointed.add(stageId);
        warnOnce(
          this.warnedCheckpoint,
          stageId,
          () =>
            `[render] prepass stage '${stageId}' got no checkpoint target (the GPU refused it), ` +
            `so it draws every pass on each change.`,
        );
        return;
      }
    }
    this.blit(from, c.fbo, w, h);
    c.sig = prefixSig(stage, frame, srcSig, passIdx);
    c.srcSig = frame.srcSig;
  }

  // Puts the checkpoint in both ping-pong targets, so a regioned draw finds the
  // state outside its region in whichever it writes.
  private restoreCheckpoint(stageId: string, passIdx: number): void {
    const c = this.checkpoints.get(stageId)?.get(passIdx);
    if (!c) throw new Error(`stage '${stageId}' has no checkpoint after pass ${passIdx + 1}`);
    this.blit(c.fbo, this.ppFbo[0]!, c.w, c.h);
    this.blit(c.fbo, this.ppFbo[1]!, c.w, c.h);
  }

  private blit(from: WebGLFramebuffer, to: WebGLFramebuffer, w: number, h: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  private dropCheckpoints(stageId: string): void {
    const kept = this.checkpoints.get(stageId);
    if (!kept) return;
    for (const c of kept.values()) this.deleteTarget(c);
    this.checkpoints.delete(stageId);
  }

  // An idle stage keeps its checkpoints while they are of this source at this
  // size, as it keeps its result (releaseStale).
  private dropStaleCheckpoints(stageId: string, frame: PrepassFrame): void {
    const kept = this.checkpoints.get(stageId);
    if (!kept) return;
    for (const c of kept.values()) {
      if (c.srcSig === frame.srcSig && c.w === frame.w && c.h === frame.h) continue;
      this.dropCheckpoints(stageId);
      return;
    }
  }

  // The denoiser's forward pass stores VST luma, which is always above 1, so an
  // RGBA8 ping-pong saturates it, and swapped in for `lin` that destroys the
  // frame. Without float render targets it stays out and the core NR block
  // runs in its place (skipCoreNR).
  denoiserRunnable(): boolean {
    if (this.float) return true;
    if (!this.warnedDenoiseSkipped) {
      this.warnedDenoiseSkipped = true;
      console.warn(
        "[render] The denoiser needs float render targets; this GPU has none, so the simpler " +
          "built-in noise reduction is used instead.",
      );
    }
    return false;
  }

  // A split stores signed, unbounded values; an RGBA8 target would clip
  // exactly what reading the current image is for.
  private splitDrawable(stageId: string): boolean {
    if (this.float) return true;
    warnOnce(
      this.warnedSplitFallback,
      stageId,
      () =>
        `[render] stage '${stageId}' reads the current image, but this GPU has no float ` +
        `render targets; it reads the source instead.`,
    );
    return false;
  }
}
