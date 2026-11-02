// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The multi-pass prepass framework: ping-pong targets, per-stage result
// textures or layers of one shared array, cached pass programs, and the
// signatures that let a frame reuse a stage's result when nothing it depends on
// changed. The renderer hands it each frame's inputs and draws the splits.

import { BUILTIN_DENOISE_ID } from "./builtin-denoise";
import { allocateInto, created, workingFormat, type TexFormat } from "./gl-resources";
import { simpleHash } from "./hash";
import { passDraws, stageDraws } from "./pass-draws";
import { createProgram } from "./program-cache";
import { paramIsActive } from "./stage-coverage";
import {
  PASS_VERTEX_SHADER,
  type ContributedBinding,
  type PrepassStage,
  type StageSplit,
} from "./stage-injection";
import { StageResultLayers } from "./stage-result-layers";
import { bindUniformByType, boundValue } from "./uniform-values";

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
  /** The stage set's signature, which keys the pass programs. */
  stageSig: string;
  linear: boolean;
  isFallbackPreview: boolean;
  /** The decoded source's size before the upload cap (uSourceSize). */
  sourceWidth: number;
  sourceHeight: number;
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
  private resultTargets = new Map<string, { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }>();
  // Cached pass programs, keyed by stageSig|stageId|passIdx|source hash.
  private passPrograms = new Map<string, { program: WebGLProgram; locs: Record<string, WebGLUniformLocation | null> }>();
  // A layered program's prepass results: one array, a layer per stage that has run.
  private readonly layers: StageResultLayers;
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
  private warnedOverflow = new Set<string>();
  private warnedSplitFallback = new Set<string>();
  private warnedDenoiseSkipped = false;
  // Each prepass stage's result this frame, bound onto the main program before the draw.
  private results: PrepassResult[] = [];
  // Active prepass stages the last frame had no texture unit left for.
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

  constructor(gl: WebGL2RenderingContext, float: boolean, host: PrepassHost) {
    this.gl = gl;
    this.float = float;
    this.host = host;
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

  /** Active stages the last frame had no texture unit or result layer for. */
  get overflowedStages(): readonly string[] {
    return this.overflowed;
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

  /** A new stage set: pass programs and cached results go, a stage whose GLSL
   *  was fixed (extension update / dev-folder reload) gets a fresh compile
   *  attempt, and a stage that left the set (its extension was turned off)
   *  takes its targets with it. Only the stages that read a layer in the
   *  program now selected keep one: a set within the sampler budget has no use
   *  for the array, the one large result texture, and what it held is stale. */
  stageSetChanged(prepass: readonly PrepassStage[]): void {
    for (const pass of this.passPrograms.values()) this.gl.deleteProgram(pass.program);
    this.passPrograms.clear();
    this.sigs.clear();
    this.failed.clear();
    this.releaseTargets(prepass);
    const layered = prepass.filter((s) => s.layerUniform !== undefined);
    this.layers.release(new Set(layered.map((s) => s.stageId)));
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.ppTex) if (t) gl.deleteTexture(t);
    for (const f of this.ppFbo) if (f) gl.deleteFramebuffer(f);
    for (const t of this.resultTargets.values()) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    this.resultTargets.clear();
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
  // prepasses run clipped to [0, 1]. Returns false if a complete framebuffer
  // can't be made (prepasses are then skipped).
  private ensurePingPong(w: number, h: number): boolean {
    const gl = this.gl;
    if (this.ppTex[0] && this.ppW === w && this.ppH === h) return true;
    for (let i = 0; i < 2; i++) {
      if (!this.ppTex[i]) this.ppTex[i] = gl.createTexture();
      if (!this.ppFbo[i]) this.ppFbo[i] = gl.createFramebuffer();
      if (!this.allocTarget(this.ppTex[i]!, this.ppFbo[i]!, w, h)) {
        this.ppW = 0;
        this.ppH = 0;
        return false;
      }
    }
    this.ppW = w;
    this.ppH = h;
    return true;
  }

  // Free the result target of every stage no longer in `prepass`, and the
  // ping-pong pair once no prepass stage is left.
  private releaseTargets(prepass: readonly PrepassStage[]): void {
    const gl = this.gl;
    const kept = new Set(prepass.map((s) => s.stageId));
    for (const [stageId, t] of this.resultTargets) {
      if (kept.has(stageId)) continue;
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
      this.resultTargets.delete(stageId);
    }
    if (prepass.length > 0) return;
    for (const t of this.ppTex) gl.deleteTexture(t);
    for (const f of this.ppFbo) gl.deleteFramebuffer(f);
    this.ppTex = [null, null];
    this.ppFbo = [null, null];
    this.ppW = 0;
    this.ppH = 0;
  }

  private ensureStageResult(stageId: string, w: number, h: number) {
    const gl = this.gl;
    let t = this.resultTargets.get(stageId);
    if (!t) {
      t = { tex: created(gl.createTexture()), fbo: created(gl.createFramebuffer()), w: 0, h: 0 };
      this.resultTargets.set(stageId, t);
    }
    if (t.w !== w || t.h !== h) {
      this.allocTarget(t.tex, t.fbo, w, h);
      t.w = w;
      t.h = h;
    }
    return t;
  }

  private passProgram(key: string, fragmentSource: string, bindings: ContributedBinding[]) {
    let e = this.passPrograms.get(key);
    if (e) return e;
    const program = createProgram(this.gl, PASS_VERTEX_SHADER, fragmentSource);
    const gl = this.gl;
    const locs: Record<string, WebGLUniformLocation | null> = {};
    for (const n of [
      "uPrevPass", "uTexel", "uPassIndex", "uPassCount",
      "uPrevRaw", "uSrcLinear", "uIsFallbackPreview", "uApplyBaseCurve", "uSourceSize",
    ]) {
      locs[n] = gl.getUniformLocation(program, n);
    }
    for (const b of bindings) locs[b.glslName] = gl.getUniformLocation(program, b.glslName);
    e = { program, locs };
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
  // opacity) is idle too.
  private active(stage: PrepassStage, frame: PrepassFrame): boolean {
    if (frame.copySlots.get(stage.stageId) === -1) return false;
    const { bag } = frame;
    const prefix = stage.stageId + ".";
    for (const [k, v] of Object.entries(bag)) {
      if (!k.startsWith(prefix)) continue;
      if (paramIsActive(v)) return true;
    }
    return stage.passes.some((pass) => pass.drawCount !== undefined && passDraws(pass, bag) > 0);
  }

  // Signature of everything a stage's prepass RESULT depends on: the source
  // (srcSig), pass-resolution, linearization flags, and this stage's PASS param
  // values (inline blend params don't affect the prepass, so they're excluded —
  // that's what makes dragging Luminance Amount, exposure, etc. a cache hit).
  private sig(stage: PrepassStage, srcSig: string, frame: PrepassFrame): string {
    const { bag, w, h, baseCurve } = frame;
    let params = "";
    for (const pass of stage.passes) {
      for (const b of pass.bindings) {
        params += `${b.qualifiedKey}=${String(boundValue(bag, b))};`;
      }
    }
    const draws = stage.passes.map((p) => passDraws(p, bag)).join(",");
    return `${srcSig}|${w}x${h}|${frame.linear ? 1 : 0}${frame.isFallbackPreview ? 1 : 0}${baseCurve}|${params}|draws:${draws}`;
  }

  /** Runs every prepass stage against the frame's source (the develop source,
   *  patched when retouch is active). Leaves results in per-stage targets or
   *  layers of the shared array, and records the unit and layer bindings the
   *  main draw applies (frameResults). */
  run(frame: PrepassFrame): void {
    this.results = [];
    this.overflowed = [];
    this.unshown = new Set();
    this.copiesPending = false;
    this.denoiseReady = false; // set true below only if the denoise prepass yields a real result
    if (frame.stages.length === 0) return;
    const gl = this.gl;
    const { srcTex, w, h } = frame;
    const haveTargets = this.ensurePingPong(w, h);

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
    const active = frame.stages.map(
      (s) =>
        haveTargets &&
        !this.failed.has(s.stageId) &&
        this.active(s, frame) &&
        stageDraws(s, frame.bag) > 0 &&
        (s.stageId !== BUILTIN_DENOISE_ID || this.denoiserRunnable()),
    );
    if (!this.float && active.some(Boolean)) {
      this.host.note(
        "prepass",
        "Extension prepasses run at 8-bit, clipped to 0–1, because this GPU has no float render targets.",
      );
    }
    const held = this.putOffCopies(active, frame);
    // Layers for every active stage at once, so the array grows at most once a frame.
    if (layered) {
      const ids = frame.stages
        .filter((s, i) => active[i] && s.layerUniform !== undefined)
        .map((s) => s.stageId);
      this.layers.reserve(ids, w, h, frame.epoch);
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
        if (active[i]) this.overflowed.push(stage.stageId);
        if (active[i] && !this.warnedOverflow.has(stage.stageId)) {
          this.warnedOverflow.add(stage.stageId);
          console.warn(
            `[render] prepass stage '${stage.stageId}' exceeds the ${units.length}-unit ` +
              `budget and will not run; its inline reads another stage's result.`,
          );
        }
        continue; // resolved after the loop, once the winners' textures are known
      }

      // Cache hit: nothing the prepass depends on changed — reuse the result and
      // skip the passes entirely.
      const { split, sig } = this.prepassKey(stage, frame);
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
        const result = this.drawStagePasses(stage, split, frame);
        // Copy the final ping-pong result into the stage's dedicated target so the
        // next stage's ping-pong doesn't clobber it.
        const target = this.ensureStageResult(stage.stageId, w, h);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, result);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.fbo);
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
        this.sigs.set(stage.stageId, { sig, srcSig: frame.srcSig, w, h });
        this.results.push({ kind: "unit", resultUniform: stage.resultUniform, tex: target.tex, unit });
        if (stage.stageId === BUILTIN_DENOISE_ID) this.denoiseReady = true;
      } catch (err) {
        console.error(`[render] prepass stage '${stage.stageId}' failed; disabling it`, err);
        this.failed.add(stage.stageId);
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
      const last = this.sigs.get(layered ? `layer:${stage.stageId}` : stage.stageId);
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
    held = false,
  ): void {
    const layer = active ? this.layers.layer(stage.stageId) : -1;
    if (active && layer < 0) {
      this.overflowed.push(stage.stageId);
      if (!this.warnedOverflow.has(stage.stageId)) {
        this.warnedOverflow.add(stage.stageId);
        console.warn(
          `[render] prepass stage '${stage.stageId}' got no result layer (the GPU refused ` +
            `the shared result array) and will not run.`,
        );
      }
    }
    if (layer < 0) {
      this.results.push({ kind: "layer", layerUniform, layer: -1 });
      return;
    }
    // A dropped layer is never read through an old signature: every signature
    // carries the source epoch, and the store drops on a new epoch or size.
    const cacheKey = `layer:${stage.stageId}`;
    try {
      const { split, sig } = this.prepassKey(stage, frame);
      if (!held && this.sigs.get(cacheKey)?.sig !== sig) {
        const result = this.drawStagePasses(stage, split, frame);
        this.layers.write(stage.stageId, result, frame.w, frame.h);
        this.sigs.set(cacheKey, { sig, srcSig: frame.srcSig, w: frame.w, h: frame.h });
      }
      this.results.push({ kind: "layer", layerUniform, layer });
      if (stage.stageId === BUILTIN_DENOISE_ID) this.denoiseReady = true;
    } catch (err) {
      console.error(`[render] prepass stage '${stage.stageId}' failed; disabling it`, err);
      this.failed.add(stage.stageId);
      this.results.push({ kind: "layer", layerUniform, layer: -1 });
    }
  }

  // The split a stage's prepass is drawn from this frame, if any, and the
  // signature of everything its result depends on.
  private prepassKey(
    stage: PrepassStage,
    frame: PrepassFrame,
  ): { split: StageSplit | null; sig: string } {
    const split = stage.split && this.splitDrawable(stage.stageId) ? stage.split : null;
    const stageSrcSig = split
      ? `${frame.srcSig}|split:${frame.splitToken(stage.stageId, split)}`
      : frame.srcSig;
    return { split, sig: this.sig(stage, stageSrcSig, frame) };
  }

  // Draws a stage's passes over the ping-pong pair, after its split draw when it
  // reads the current image, and returns the framebuffer holding the result.
  private drawStagePasses(
    stage: PrepassStage,
    split: StageSplit | null,
    frame: PrepassFrame,
  ): WebGLFramebuffer {
    const gl = this.gl;
    const { srcTex, applyRetouch, w, h, baseCurve } = frame;
    let readTex: WebGLTexture = srcTex;
    let prevRaw = true;            // first read linearizes + base-curves the source
    let writeIdx = 0;
    let lastIdx = 0;
    if (split) {
      this.host.drawSplit(split.index, srcTex, applyRetouch, { fbo: this.ppFbo[0], w, h });
      this.draws.split++;
      readTex = this.ppTex[0]!;
      prevRaw = false;
      writeIdx = 1;
    }
    let passIdx = 0;
    for (const pass of stage.passes) {
      // Distinguish passes by index AND source hash: two passes of one stage
      // with equal-length sources (separable H/V blur) share a length, so a
      // length-only key collided and reused the first pass's program.
      // A mask copy draws with its stage's programs (same source, its own values).
      const owner = stage.passesOf ?? stage.stageId;
      const key = `${frame.stageSig}|${owner}|${passIdx}|${simpleHash(pass.fragmentSource)}`;
      passIdx++;
      const prog = this.passProgram(key, pass.fragmentSource, pass.bindings);
      const { bag } = frame;
      const draws = passDraws(pass, bag);
      for (let it = 0; it < draws; it++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.ppFbo[writeIdx]);
        gl.viewport(0, 0, w, h);
        gl.useProgram(prog.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, readTex);
        gl.uniform1i(prog.locs.uPrevPass!, 0);
        gl.uniform2f(prog.locs.uTexel!, 1 / w, 1 / h);
        gl.uniform1i(prog.locs.uPassIndex!, it);
        gl.uniform1i(prog.locs.uPassCount!, draws);
        gl.uniform1i(prog.locs.uPrevRaw!, prevRaw ? 1 : 0);
        gl.uniform1i(prog.locs.uSrcLinear!, frame.linear ? 1 : 0);
        // Null where the pass doesn't name it (not declared, see stage-injection.ts); a no-op then.
        gl.uniform2f(prog.locs.uSourceSize, frame.sourceWidth, frame.sourceHeight);
        gl.uniform1i(prog.locs.uIsFallbackPreview!, frame.isFallbackPreview ? 1 : 0);
        gl.uniform1i(prog.locs.uApplyBaseCurve!, baseCurve);
        for (const b of pass.bindings) {
          const loc = prog.locs[b.glslName];
          if (loc == null) continue;
          bindUniformByType(gl, loc, b.glslType, boundValue(bag, b), b.length);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        this.draws.pass++;
        readTex = this.ppTex[writeIdx]!;
        prevRaw = false;
        lastIdx = writeIdx;
        writeIdx = 1 - writeIdx;
      }
    }
    return this.ppFbo[lastIdx]!;
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
    if (!this.warnedSplitFallback.has(stageId)) {
      this.warnedSplitFallback.add(stageId);
      console.warn(
        `[render] stage '${stageId}' reads the current image, but this GPU has no float ` +
          `render targets; it reads the source instead.`,
      );
    }
    return false;
  }
}
