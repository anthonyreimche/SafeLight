// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The compiled develop programs, one per pipeline, stage set, process version
// and exit, and the program builder every pass shares.

import type { ResolvedPipeline } from "@/rendering/webgl/resolved-pipeline";
import { BUILTIN_RESOLVED } from "./builtin-pipeline";
import { created } from "./gl-resources";
import {
  buildFragmentShader,
  variantKey,
  VERTEX_SHADER,
  type ProcessVersion,
  type ProgramExit,
  type ShaderVariant,
} from "./shaders";
import {
  RESULT_ARRAY_UNIFORM,
  VIEW_STAGES_UNIFORM,
  type BuiltStageInjection,
  type ContributedBinding,
} from "./stage-injection";

// Fixed attribute locations (bound before link), so every pipeline variant of
// the program shares the one VAO — swapping pipelines never rebuilds geometry.
export const ATTR_POS = 0;
export const ATTR_UV = 1;

// One compiled develop program per pipeline, stage set and process version:
// switching transforms or photos (or back) is an O(1) swap with no shader
// recompile or uniform re-query.
export interface PipelineProgram {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
  skipBase: boolean;
  skipShoulder: boolean;
}

// How many develop programs a cache keeps. A stage re-registered with other GLSL
// (a film stock picked) is a new program each time, and each holds driver memory.
export const MAX_PROGRAMS = 32;

// A frame waits for its program's build, and the render worker says nothing while
// it does, so a wait longer than this is logged: otherwise it reads as a worker that
// stopped.
const SLOW_BUILD_MS = 1_000;

// How many builds submit may leave unfinished: each holds a program the driver is
// compiling, and a hint the user never followed up leaves one nobody asks for.
const MAX_SUBMITTED = 4;

// How often whenBuilt asks the driver whether its build is done. A develop
// program takes hundreds of milliseconds, so a few more past it go unnoticed.
const SETTLE_POLL_MS = 8;

/** A develop program submitted ahead of a frame (ProgramCache.submit), and what
 *  entryFor needs to finish it into an entry. */
interface Submitted {
  build: SubmittedProgram;
  p: ResolvedPipeline;
  built: BuiltStageInjection;
  variant: ShaderVariant;
  stageIds: ReadonlySet<string>;
  exit: ProgramExit | undefined;
}

/** How a program build ended: built, failed with the driver's log (a compile or
 *  link error the quarantine can name), or suspect: failed with no log, which is
 *  the driver failing rather than the GLSL (Direct3D 11 losing the context over a
 *  shader it can't take). */
export type StageBuildOutcome = "built" | "failed" | "suspect";

/** Told as each program starts and stops building, with the ids of the stages in
 *  it, so a build that takes the graphics driver down can be pinned on them. */
export interface ProgramBuilds {
  started(stageIds: ReadonlySet<string>): void;
  ended(stageIds: ReadonlySet<string>, outcome: StageBuildOutcome): void;
}

/** The outcome of a build that threw `err`. */
export function buildOutcome(err: unknown): Exclude<StageBuildOutcome, "built"> {
  const message = err instanceof Error ? err.message : "";
  return /^(?:Shader compile|Program link) failed:\s*$/.test(message) ? "suspect" : "failed";
}

/** How a submitted build let go of unfinished ended: unknown on a lost context,
 *  which the driver may have lost over it, so the crash guard keeps it in hand. */
export function letGoOutcome(gl: WebGL2RenderingContext): Exclude<StageBuildOutcome, "built"> {
  return gl.isContextLost() ? "suspect" : "failed";
}

// More signatures than this for one stage id inside the window is a stage
// re-registering itself with new GLSL, compiling a program every time.
const CHURN_SIGNATURES = 8;
const CHURN_WINDOW_MS = 60_000;

export class ProgramCache {
  private readonly gl: WebGL2RenderingContext;
  private readonly maxPrograms: number;
  // Least recently used first: entryFor moves each hit to the end.
  private programs = new Map<string, PipelineProgram>();
  // The error each failed build threw, by program cache key (see entryFor).
  private failedBuilds = new Map<string, unknown>();
  // The ids of the stages each cached program or failure was built from, by
  // program cache key, so a stage set that loses a stage can let go of them.
  private programStages = new Map<string, ReadonlySet<string>>();
  // The entry the renderer draws with, which eviction passes over.
  private current: PipelineProgram | null = null;
  // When each stage id was last built under each of its signatures.
  private stageBuilds = new Map<string, Map<string, number>>();
  // Builds submitted and not finished yet, oldest first, by program cache key.
  private submitted = new Map<string, Submitted>();
  // KHR_parallel_shader_compile, which says when a build is done without waiting for it.
  private readonly parallel: KHR_parallel_shader_compile | null;
  private readonly builds: ProgramBuilds | undefined;

  constructor(gl: WebGL2RenderingContext, maxPrograms = MAX_PROGRAMS, builds?: ProgramBuilds) {
    this.gl = gl;
    this.maxPrograms = maxPrograms;
    this.parallel = gl.getExtension("KHR_parallel_shader_compile");
    this.builds = builds;
  }

  /** Start building the entry entryFor would build for these, without waiting for
   *  the driver: the frame that asks for it later finishes it, waiting only for
   *  what is left, and builds nothing again. True when a build was started; false
   *  for an entry built, failed or submitted already, or on a lost context. Past
   *  MAX_SUBMITTED, the oldest submission is let go. */
  submit(
    p: ResolvedPipeline,
    built: BuiltStageInjection,
    variant: ShaderVariant,
    stageIds: ReadonlySet<string>,
    exit?: ProgramExit,
  ): boolean {
    const key = cacheKeyOf(p, built, variant, exit);
    if (this.programs.has(key) || this.failedBuilds.has(key) || this.submitted.has(key)) return false;
    if (this.gl.isContextLost()) return false;
    for (const [oldest, s] of this.submitted) {
      if (this.submitted.size < MAX_SUBMITTED) break;
      this.letGo(oldest, s);
    }
    this.builds?.started(stageIds);
    const build = submitProgram(this.gl, VERTEX_SHADER, developSource(p, built, variant, exit), developName(p, stageIds));
    this.submitted.set(key, { build, p, built, variant, stageIds, exit });
    return true;
  }

  /** Finish the submitted builds the driver says are done (KHR_parallel_shader_compile),
   *  so no frame waits on them. Without the extension a build can't be asked about
   *  without waiting, and is finished by the frame that needs it. */
  settle(): void {
    const parallel = this.parallel;
    if (!parallel || this.submitted.size === 0) return;
    for (const s of [...this.submitted.values()]) {
      if (!this.gl.getProgramParameter(s.build.program, parallel.COMPLETION_STATUS_KHR)) continue;
      try {
        this.entryFor(s.p, s.built, s.variant, s.stageIds, s.exit);
      } catch {
        // Remembered under its key, and thrown to the frame that asks for it.
      }
    }
  }

  /** Build the entry entryFor would build for these without blocking the
   *  thread on the driver: submitted, then finished by settle() once the
   *  driver says it is done, asked every SETTLE_POLL_MS. Resolves once it is
   *  built or has failed, never rejecting: a failure is remembered for
   *  entryFor to throw. Without KHR_parallel_shader_compile a build can't be
   *  asked about, so it resolves at once and leaves the build to entryFor. */
  async whenBuilt(
    p: ResolvedPipeline,
    built: BuiltStageInjection,
    variant: ShaderVariant,
    stageIds: ReadonlySet<string>,
    exit?: ProgramExit,
  ): Promise<void> {
    if (!this.parallel) return;
    const key = cacheKeyOf(p, built, variant, exit);
    this.submit(p, built, variant, stageIds, exit);
    while (this.submitted.has(key) && !this.gl.isContextLost()) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      this.settle();
    }
  }

  private letGo(key: string, s: Submitted): void {
    this.submitted.delete(key);
    this.builds?.ended(s.stageIds, letGoOutcome(this.gl));
    const gl = this.gl;
    gl.deleteShader(s.build.vs);
    gl.deleteShader(s.build.fs);
    gl.deleteProgram(s.build.program);
  }

  /** The entry the renderer has switched to drawing with: never evicted while it is. */
  setCurrent(entry: PipelineProgram): void {
    this.current = entry;
  }

  // Program + uniform locations for a pipeline + stage set + process version (+ a
  // probe's or scene measurement's exit), cached by combined signature. A bad custom transform falls back
  // to the built-in entry — cached under the failing sig too, so it isn't recompiled
  // (and re-logged) every frame. A build that throws is remembered under its key
  // and rethrown as it was, without compiling again, until a signature or the
  // version gives another key. The stage set comes in as an argument, not from the
  // renderer's own state, so building an entry never touches what it is drawing with;
  // `stageIds` are the ids of the stages `built` was built from. Past `maxPrograms`,
  // each new program deletes the least recently used one.
  entryFor(
    p: ResolvedPipeline,
    built: BuiltStageInjection,
    variant: ShaderVariant,
    stageIds: ReadonlySet<string>,
    exit?: ProgramExit,
  ): PipelineProgram {
    const cacheKey = cacheKeyOf(p, built, variant, exit);
    const cached = this.programs.get(cacheKey);
    if (cached) {
      this.programs.delete(cacheKey);
      this.programs.set(cacheKey, cached);
      return cached;
    }
    if (this.failedBuilds.has(cacheKey)) throw this.failedBuilds.get(cacheKey);
    this.programStages.set(cacheKey, stageIds);
    this.noteStageSignatures(built.sig);
    try {
      const entry = this.buildEntry(p, built, variant, stageIds, exit, this.takeSubmitted(cacheKey));
      this.programs.set(cacheKey, entry);
      this.evictBeyondCap(entry);
      return entry;
    } catch (err) {
      // A lost context fails every build; that says nothing of this one.
      if (this.gl.isContextLost()) this.programStages.delete(cacheKey);
      else this.failedBuilds.set(cacheKey, err);
      throw err;
    }
  }

  // Delete the least recently used programs past the cap, bar the one in use
  // and `keep`, the one about to be handed out.
  private evictBeyondCap(keep: PipelineProgram): void {
    let over = this.programs.size - this.maxPrograms;
    if (over <= 0) return;
    const released = new Set<WebGLProgram>();
    for (const [key, entry] of this.programs) {
      if (over === 0) break;
      if (entry.program === keep.program || entry.program === this.current?.program) continue;
      released.add(entry.program);
      this.programs.delete(key);
      this.programStages.delete(key);
      over--;
    }
    this.deleteUnshared(released);
  }

  // A fallback entry shares the built-in entry's program under another key.
  private deleteUnshared(released: Set<WebGLProgram>): void {
    for (const e of this.programs.values()) released.delete(e.program);
    for (const program of released) this.gl.deleteProgram(program);
  }

  // `sig` is a stage injection's: "id:signature" per stage, joined by "|".
  private noteStageSignatures(sig: string): void {
    if (sig === "") return;
    const now = Date.now();
    for (const part of sig.split("|")) {
      const at = part.lastIndexOf(":");
      const id = part.slice(0, at);
      const seen = this.stageBuilds.get(id) ?? new Map<string, number>();
      seen.set(part.slice(at + 1), now);
      for (const [signature, builtAt] of seen) if (now - builtAt > CHURN_WINDOW_MS) seen.delete(signature);
      this.stageBuilds.set(id, seen);
      if (seen.size === CHURN_SIGNATURES + 1) {
        console.warn(
          `[renderer] stage "${id}" was built with ${seen.size} different shaders within a minute; ` +
            "each one compiles a develop program of its own",
        );
      }
    }
  }

  // The submission under `key`, handed over to be finished.
  private takeSubmitted(key: string): SubmittedProgram | undefined {
    const s = this.submitted.get(key);
    this.submitted.delete(key);
    return s?.build;
  }

  // Finishes `submitted` when there is one, else builds the entry here and now.
  private buildEntry(
    p: ResolvedPipeline,
    built: BuiltStageInjection,
    variant: ShaderVariant,
    stageIds: ReadonlySet<string>,
    exit: ProgramExit | undefined,
    submitted?: SubmittedProgram,
  ): PipelineProgram {
    let program: WebGLProgram;
    if (!submitted) this.builds?.started(stageIds);
    try {
      program = submitted
        ? finishProgram(this.gl, submitted)
        : createProgram(this.gl, VERTEX_SHADER, developSource(p, built, variant, exit), developName(p, stageIds));
      this.builds?.ended(stageIds, "built");
    } catch (err) {
      this.builds?.ended(stageIds, buildOutcome(err));
      if (!p.glsl) throw err; // built-in must compile
      // Said only once the built-in builds: when it doesn't either, the stages are
      // at fault, not the transform.
      const fallback = this.entryFor(BUILTIN_RESOLVED, built, variant, stageIds, exit);
      console.error(`[pipeline] "${p.id}" failed to compile; using built-in:`, err);
      return fallback;
    }
    return {
      program,
      uniforms: uniformLocations(this.gl, program, built, p.bindings ?? []),
      skipBase: p.skipBaseCurve,
      skipShoulder: p.skipToneShoulder,
    };
  }

  // Delete the programs, and forget the failures, built from a stage that isn't
  // in `current`: its extension was turned off, and should it come back its
  // stage set compiles again like any new one.
  /** Let go of the builds submitted with a stage not among `current`, before
   *  the stage set they were asked under changes. */
  letGoWithout(current: ReadonlySet<string>): void {
    for (const [key, s] of this.submitted) {
      if (![...s.stageIds].every((id) => current.has(id))) this.letGo(key, s);
    }
  }

  releaseWithout(current: ReadonlySet<string>): void {
    const released = new Set<WebGLProgram>();
    for (const [key, s] of this.submitted) {
      if (![...s.stageIds].every((id) => current.has(id))) this.letGo(key, s);
    }
    for (const [key, ids] of this.programStages) {
      if ([...ids].every((id) => current.has(id))) continue;
      const entry = this.programs.get(key);
      if (entry) released.add(entry.program);
      this.programs.delete(key);
      this.failedBuilds.delete(key);
      this.programStages.delete(key);
    }
    this.deleteUnshared(released);
  }

  dispose(): void {
    for (const [key, s] of this.submitted) this.letGo(key, s);
    // Fallback entries can share a program under several sigs — dedupe.
    const programs = new Set<WebGLProgram>();
    for (const e of this.programs.values()) programs.add(e.program);
    for (const prog of programs) this.gl.deleteProgram(prog);
  }
}

// The key a develop program is cached under: pipeline, stage set, process version
// and a probe's or scene measurement's exit.
const cacheKeyOf = (
  p: ResolvedPipeline,
  built: BuiltStageInjection,
  variant: ShaderVariant,
  exit: ProgramExit | undefined,
): string => `${p.sig}|${built.sig}|${variantKey(variant)}${exit ? `|${exit}` : ""}`;

const developSource = (
  p: ResolvedPipeline,
  built: BuiltStageInjection,
  variant: ShaderVariant,
  exit: ProgramExit | undefined,
): string =>
  withProcessVersion(buildFragmentShader(p.glsl, built.injection, variant, exit, p.uniformDecls), variant.version);

const developName = (p: ResolvedPipeline, stageIds: ReadonlySet<string>): string =>
  `the develop program for "${p.id}" with ${stageIds.size} stages`;

// The most builds one failure may spend finding the stages it comes from: each is
// a whole develop program's compile.
const MAX_ISOLATION_BUILDS = 12;

export interface FailingStage<T> {
  stage: T;
  /** What the shortest build that took the stage in failed with. */
  log: string;
}

/** Which of `stages` keep a program from building, whose build with all of them
 *  failed with `error`. `build` builds it with only the stages it is handed (and
 *  whatever it always adds), answering null when that builds and the failure's
 *  message when it doesn't. None when it fails with none of them, or none was
 *  found within `maxBuilds`; a limit reached after some were found answers those.
 *  None, too, once `aborted` says the builds can no longer be trusted (a lost
 *  context fails every one).
 *
 *  A bisection over the stages' order for the shortest failing run from the
 *  first: its last stage is to blame, whether it is broken alone or the one that
 *  carries the set past the GPU's limits. Then again without it, until the rest
 *  build. */
export function isolateFailingStages<T>(
  stages: readonly T[],
  error: string,
  build: (subset: readonly T[]) => string | null,
  maxBuilds = MAX_ISOLATION_BUILDS,
  aborted: () => boolean = () => false,
): FailingStage<T>[] {
  let builds = 0;
  const attempt = (subset: readonly T[]): string | null => {
    builds++;
    return build(subset);
  };
  if (stages.length === 0 || attempt([]) !== null || aborted()) return [];
  const failing: FailingStage<T>[] = [];
  let kept = [...stages];
  let keptError = error;
  for (;;) {
    // The first `good` stages build; the first `bad` fail, with `badError`.
    let good = 0;
    let bad = kept.length;
    let badError = keptError;
    while (bad - good > 1) {
      if (builds >= maxBuilds) return failing;
      const mid = (good + bad) >> 1;
      const err = attempt(kept.slice(0, mid));
      if (aborted()) return [];
      if (err === null) {
        good = mid;
      } else {
        bad = mid;
        badError = err;
      }
    }
    failing.push({ stage: kept[bad - 1], log: badError });
    kept = kept.filter((_, i) => i !== bad - 1);
    if (kept.length === 0 || builds >= maxBuilds) return failing;
    const rest = attempt(kept);
    if (aborted()) return [];
    if (rest === null) return failing;
    keptError = rest;
  }
}

/** A program whose compile and link were asked of the driver and not yet waited
 *  on: the driver works on it while the caller goes on (finishProgram). */
export interface SubmittedProgram {
  program: WebGLProgram;
  vs: WebGLShader;
  fs: WebGLShader;
  /** Which program it is, for the slow-build warning. */
  name: string;
  /** The fragment source's length, for the same. */
  fsLength: number;
}

/** Ask the driver to build a program from `vsSrc` and `fsSrc` without waiting for
 *  it: nothing reads a status until finishProgram. `name` says which program it
 *  is in the slow-build warning. */
export function submitProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
  name = "a program",
): SubmittedProgram {
  const vs = submitShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = submitShader(gl, gl.FRAGMENT_SHADER, withHighpSamplers(fsSrc));
  const program = created(gl.createProgram());
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  // Pin attribute locations so the shared quad VAO is valid for every
  // pipeline variant of the program.
  gl.bindAttribLocation(program, ATTR_POS, "aPos");
  gl.bindAttribLocation(program, ATTR_UV, "aUv");
  gl.linkProgram(program);
  return { program, vs, fs, name, fsLength: fsSrc.length };
}

/** The built program, waiting for the driver where it isn't done, or the error
 *  it failed with: a shader's compile log, else the link log. Warns when the
 *  wait from `since` takes longer than SLOW_BUILD_MS. Either way the shaders
 *  are let go, and a failed program with them. */
export function finishProgram(
  gl: WebGL2RenderingContext,
  submitted: SubmittedProgram,
  since = performance.now(),
): WebGLProgram {
  const { program, vs, fs } = submitted;
  try {
    const shaderLog = compileLog(gl, vs) ?? compileLog(gl, fs);
    const linked = shaderLog === null && gl.getProgramParameter(program, gl.LINK_STATUS);
    if (linked) return program;
    const error =
      shaderLog === null
        ? `Program link failed: ${gl.getProgramInfoLog(program)}`
        : `Shader compile failed: ${shaderLog}`;
    gl.deleteProgram(program);
    throw new Error(error);
  } finally {
    // Attached shaders are freed with the program once flagged.
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    const ms = performance.now() - since;
    if (ms > SLOW_BUILD_MS) {
      const kb = (submitted.fsLength / 1024).toFixed(1);
      console.warn(`[renderer] ${submitted.name} took ${Math.round(ms)} ms to build (${kb} KB of fragment GLSL)`);
    }
  }
}

/** Build a program from `vsSrc` and `fsSrc`, warning when the driver takes longer
 *  than SLOW_BUILD_MS over it. `name` says which program it is in that warning. */
export function createProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
  name = "a program",
): WebGLProgram {
  const start = performance.now();
  return finishProgram(gl, submitProgram(gl, vsSrc, fsSrc, name), start);
}

// A fragment sampler2D is lowp by default, which drivers that lower lowp to fp16
// (Mesa's Asahi, freedreno, panfrost behind ANGLE) honour, clipping HDR values
// read through it. Added here rather than in the sources: the version 1 text and
// the program reference hashes are frozen.
function withHighpSamplers(src: string): string {
  if (/\bprecision\s+\w+\s+sampler2D\s*;/.test(src)) return src;
  return src.replace(/^(#version[^\n]*\n)/, "$1precision highp sampler2D;\n");
}

/** `src` defining SL_PROCESS_VERSION, the process version it renders, which an
 *  extension stage's glsl, helpers and passes test with `#if` (contributions.md).
 *  Added at compile time for the same reason as withHighpSamplers. */
export function withProcessVersion(src: string, version: ProcessVersion): string {
  return src.replace(/^(#version[^\n]*\n)/, `$1#define SL_PROCESS_VERSION ${version}\n`);
}

function submitShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = created(gl.createShader(type));
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  return shader;
}

// A shader's compile log once it failed, or null when it compiled.
function compileLog(gl: WebGL2RenderingContext, shader: WebGLShader): string | null {
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? null : gl.getShaderInfoLog(shader);
}

function uniformLocations(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  built: BuiltStageInjection,
  transformBindings: readonly ContributedBinding[] = [],
): Record<string, WebGLUniformLocation | null> {
  const u: Record<string, WebGLUniformLocation | null> = {};
  const names = [
    "uImage",
    "uOutSpace",
    "uOutMatrix",
    "uOutToLms",
    "uLmsToOut",
    "uProof",
    "uProofFits",
    "uProofMatrix",
    "uProofToLms",
    "uLmsToProof",
    "uProofToOut",
    "uOutsideColor",
    "uViewport",
    "uLinear",
    "uIsFallbackPreview",
    "uApplyBaseCurve",
    "uBaselineGain",
    "uBaselineShadows",
    "uApplyToneShoulder",
    "uRawHistogram",
    "uShowClipping",
    "uVizMask",
    "uVizColor",
    "uVizStrength",
    "uSharpenViz",
    VIEW_STAGES_UNIFORM,
    "uDenoiseReady",
    "uLuminanceNR",
    "uSkipCoreNR",
    "uLumNRDetail",
    "uLumNRContrast",
    "uLumNRShadows",
    "uLumNRHighlights",
    "uColorNR",
    "uColorNRDetail",
    "uColorNRSmooth",
    "uAsShotTemperature",
    "uClipThreshold",
    // Masks + retouch
    "uImageAspect",
    "uMaskTex",
    "uDevelopedSrc",
    "uHaveDeveloped",
    "uDetail",
    "uDetailOn",
    "uDetailRect",
    "uDetailAmount",
    "uApplyRetouch",
    "uPatchPass",
    "uSplitAt",
  ];
  for (const name of names) {
    u[name] = gl.getUniformLocation(program, name);
  }
  // Extension-contributed stage uniforms, then the display transform's params or
  // derived uniforms, keyed by the bag key each binds from, so render() can
  // resolve location + value together from the param bag.
  for (const b of [...built.bindings, ...transformBindings]) {
    u[b.qualifiedKey] = gl.getUniformLocation(program, b.glslName);
  }
  for (const ms of built.maskSlots) u[ms.glslName] = gl.getUniformLocation(program, ms.glslName);
  // Prepass results: a sampler per stage that has one, a layer uniform per
  // stage reading the shared array, and the array itself.
  for (const ps of built.prepass) {
    u[ps.resultUniform] = gl.getUniformLocation(program, ps.resultUniform);
    if (ps.layerUniform) u[ps.layerUniform] = gl.getUniformLocation(program, ps.layerUniform);
  }
  u[RESULT_ARRAY_UNIFORM] = gl.getUniformLocation(program, RESULT_ARRAY_UNIFORM);
  // Extension stage-texture samplers / coverage channel uniforms, keyed by
  // qualified key.
  for (const tb of built.textureBindings) {
    const name =
      tb.kind === "coverage" ? `${tb.glslName}_ch` : tb.kind === "paint" ? `${tb.glslName}_tex` : tb.glslName;
    u[tb.qualifiedKey] = gl.getUniformLocation(program, name);
  }
  return u;
}
