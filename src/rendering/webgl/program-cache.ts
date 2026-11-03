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
import { RESULT_ARRAY_UNIFORM, type BuiltStageInjection, type ContributedBinding } from "./stage-injection";

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

  constructor(gl: WebGL2RenderingContext, maxPrograms = MAX_PROGRAMS) {
    this.gl = gl;
    this.maxPrograms = maxPrograms;
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
    const cacheKey = `${p.sig}|${built.sig}|${variantKey(variant)}${exit ? `|${exit}` : ""}`;
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
      const entry = this.buildEntry(p, built, variant, stageIds, exit);
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
    // A fallback entry shares the built-in entry's program under another key.
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

  private buildEntry(
    p: ResolvedPipeline,
    built: BuiltStageInjection,
    variant: ShaderVariant,
    stageIds: ReadonlySet<string>,
    exit: ProgramExit | undefined,
  ): PipelineProgram {
    try {
      const program = createProgram(
        this.gl,
        VERTEX_SHADER,
        withProcessVersion(buildFragmentShader(p.glsl, built.injection, variant, exit, p.uniformDecls), variant.version),
      );
      return {
        program,
        uniforms: uniformLocations(this.gl, program, built, p.bindings ?? []),
        skipBase: p.skipBaseCurve,
        skipShoulder: p.skipToneShoulder,
      };
    } catch (err) {
      if (!p.glsl) throw err; // built-in must compile
      // Said only once the built-in builds: when it doesn't either, the stages are
      // at fault, not the transform.
      const fallback = this.entryFor(BUILTIN_RESOLVED, built, variant, stageIds, exit);
      console.error(`[pipeline] "${p.id}" failed to compile; using built-in:`, err);
      return fallback;
    }
  }

  // Delete the programs, and forget the failures, built from a stage that isn't
  // in `current`: its extension was turned off, and should it come back its
  // stage set compiles again like any new one.
  releaseWithout(current: ReadonlySet<string>): void {
    const released = new Set<WebGLProgram>();
    for (const [key, ids] of this.programStages) {
      if ([...ids].every((id) => current.has(id))) continue;
      const entry = this.programs.get(key);
      if (entry) released.add(entry.program);
      this.programs.delete(key);
      this.failedBuilds.delete(key);
      this.programStages.delete(key);
    }
    // A fallback entry shares the built-in entry's program under another key.
    for (const e of this.programs.values()) released.delete(e.program);
    for (const program of released) this.gl.deleteProgram(program);
  }

  dispose(): void {
    // Fallback entries can share a program under several sigs — dedupe.
    const programs = new Set<WebGLProgram>();
    for (const e of this.programs.values()) programs.add(e.program);
    for (const prog of programs) this.gl.deleteProgram(prog);
  }
}

// The most builds one failure may spend finding the stages it comes from: each is
// a whole develop program's compile.
export const MAX_ISOLATION_BUILDS = 12;

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

export function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  let fs: WebGLShader;
  try {
    fs = compileShader(gl, gl.FRAGMENT_SHADER, withHighpSamplers(fsSrc));
  } catch (err) {
    // A contributed stage with bad GLSL fails here on every attempt (each
    // pipeline switch, each dev-folder reload), so the already-compiled
    // vertex shader must not be stranded on the way out.
    gl.deleteShader(vs);
    throw err;
  }
  const program = created(gl.createProgram());
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  // Pin attribute locations so the shared quad VAO is valid for every
  // pipeline variant of the program.
  gl.bindAttribLocation(program, ATTR_POS, "aPos");
  gl.bindAttribLocation(program, ATTR_UV, "aUv");
  gl.linkProgram(program);
  // Attached shaders are freed with the program once flagged, so release them
  // before the link check — otherwise a link failure strands both.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed: ${log}`);
  }
  return program;
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

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = created(gl.createShader(type));
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return shader;
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
    "uApplyRetouch",
    "uPatchPass",
    "uSplitAt",
  ];
  for (const name of names) {
    u[name] = gl.getUniformLocation(program, name);
  }
  // Extension-contributed stage uniforms, keyed by qualified key so render()
  // can resolve location + value together from the param bag.
  for (const b of built.bindings) {
    u[b.qualifiedKey] = gl.getUniformLocation(program, b.glslName);
  }
  // The display transform's params or derived uniforms, keyed by the bag key
  // each binds from.
  for (const b of transformBindings) {
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
    const name = tb.kind === "coverage" ? `${tb.glslName}_ch` : tb.glslName;
    u[tb.qualifiedKey] = gl.getUniformLocation(program, name);
  }
  return u;
}
