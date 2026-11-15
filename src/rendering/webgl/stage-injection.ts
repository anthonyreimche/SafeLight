// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type {
  GlslType,
  InterStageVariable,
  ProcessingPhase,
  ProcessingStageContribution,
  StageAnchor,
  StagePass,
  StageSpace,
  TextureRequirement,
  UniformDeclaration,
  UniformValue,
} from "@/extensions/types";
import { MAX_PASS_DRAWS, declaredUniforms, dormancyIgnored } from "@/extensions/stage-validation";
import { BASELINE_TONE_GLSL } from "../baseline-tone";
import {
  STAGE_SPACE_GLSL,
  fromSpaceExpr,
  isIdentitySpace,
  spaceKey,
  toSpaceExpr,
  type StageDomain,
} from "../stage-space";
import { BUILTIN_DENOISE_ID } from "./builtin-denoise";
import { isCoreStage, writesRawNames } from "./builtin-stage";
import { isMaskInstance, type MaskInstanceStage } from "./mask-stage-instances";
import {
  uniformPrefix,
  helperPrefix,
  extractHelperNames,
  emitUniformDecl,
  mentionsIdentifier,
  rewriteGlsl,
  replaceIdentifiers,
} from "./shader-compiler";
import { simpleHash } from "./hash";
import type { DormantRule } from "./stage-coverage";
import { V1_VARIANT, type ShaderVariant, type StageInjection } from "./shaders";
import { sortStages } from "./stage-order";
import { STAGE_ANCHORS, anchorOf, openAnchorOf } from "./stage-anchors";
import { laterLineReads, standIns } from "./core-reads";

// ---------------------------------------------------------------------------
// Stage injection: build the GLSL strings that buildFragmentShader splices
// into the monolith from a set of processing stages.
// ---------------------------------------------------------------------------

/** A single extension-contributed uniform, resolved to its namespaced GLSL name
 *  so render() can bind its value generically from the contributed param bag. */
export interface ContributedBinding {
  /** Qualified key "{stageId}.{key}" — the param-bag key and uniform-cache key. */
  qualifiedKey: string;
  /** Namespaced GLSL identifier, e.g. "u_ab12_lumaAmount". */
  glslName: string;
  glslType: GlslType;
  /** An array uniform's length (UniformDeclaration.length). */
  length?: number;
  /** A mat3 whose value is an ImageSpaceMatrix, finished for the image's
   *  aspect at bind time (UniformDeclaration.space). */
  space?: "image";
  default: number | number[] | boolean;
}

/** A stage-declared texture, resolved to its namespaced GLSL identifier so
 *  render() can bind it each frame: a sampler for "lut"/"dynamic" data uploaded
 *  through setStageTexture, the brush-atlas channel uniform for "coverage"
 *  dabs painted into the param bag, or the `{glslName}_tex` sampler behind a
 *  "paint" key's helper. */
export interface StageTextureBinding {
  /** Qualified key "{stageId}.{key}" — also the stage-texture / param-bag key. */
  qualifiedKey: string;
  /** Namespaced identifier, e.g. "u_ab12_lut" (sampler) or the "u_ab12_mask"
   *  helper whose channel uniform is "u_ab12_mask_ch". */
  glslName: string;
  kind: TextureRequirement["kind"];
}

/** The GLSL behind a coverage-kind key: the stage calls `key(uv)` and reads the
 *  coverage painted for it out of the brush atlas channel bound per frame. */
function coverageHelperGlsl(name: string): string {
  return `float ${name}(vec2 uv) {
  int ch = ${name}_ch;
  if (ch < 0) return 0.0;
  vec4 t = texture(uMaskTex, uv);
  return ch == 0 ? t.r : ch == 1 ? t.g : ch == 2 ? t.b : t.a;
}`;
}

/** The GLSL behind a paint-kind key: the stage calls `key(layer, uv)` and reads
 *  the layer's tile of the paint texture (2×2 tiles, layer n in tile n). The
 *  uv is held half a texel inside the tile, so filtering never reads the next. */
function paintHelperGlsl(name: string): string {
  return `vec4 ${name}(int layer, vec2 uv) {
  if (layer < 0 || layer > 3) return vec4(0.0);
  vec2 inset = min(vec2(0.5), 1.0 / vec2(textureSize(${name}_tex, 0)));
  vec2 tile = vec2(float(layer % 2), float(layer / 2));
  return texture(${name}_tex, (tile + clamp(uv, inset, 1.0 - inset)) * 0.5);
}`;
}

// ---------------------------------------------------------------------------
// Phases, stage rules and pipeline order
// ---------------------------------------------------------------------------

export type InjectionGroup = "srcUv" | "noiseReduction" | "sceneLinear" | "effects";
export type ColourGroup = Exclude<InjectionGroup, "srcUv">;

/** What the injector wrote, recorded as it writes it, so describePipeline
 *  can't drift from the GLSL: a stage's block; the group's variable brought
 *  from one space into another (`elided` where it already held that space and
 *  nothing was written); a clip inserted ahead of a stage; a split exit. */
export type InjectionStep =
  | { kind: "stage"; group: InjectionGroup; stageId: string; anchor?: StageAnchor }
  | {
      kind: "convert";
      group: ColourGroup;
      domain: StageDomain;
      from: StageSpace | undefined;
      to: StageSpace | undefined;
      elided?: true;
    }
  | { kind: "clamp"; group: ColourGroup; reason: "legacy-display-stage"; stageId: string }
  | { kind: "exit"; group: ColourGroup; stageId: string; clamped: boolean };

interface PhaseInfo {
  /** The injection group the phase's blocks join. Linear-space phases operate on
   *  `lin` (the scene-linear working colour); display-space phases operate on `c`. */
  readonly group: InjectionGroup;
  /** Which values the phase's stages see: scene-linear `lin` before the display
   *  transform, its display-encoded output `c` after it. Geometry sees neither. */
  readonly domain: StageDomain | null;
  /** Effects and output-encode stages run in the output frame (vignette and
   *  grain read vUv), which a draw in source texels can't reproduce, so a split
   *  for one of them sits at the end of display-adjust. */
  readonly outputFrame: boolean;
}

/** One row per phase, so the group a phase's blocks join, the values its stages
 *  see and the frame it runs in cannot disagree. */
export const PHASES: Readonly<Record<ProcessingPhase, PhaseInfo>> = {
  geometry: { group: "srcUv", domain: null, outputFrame: false },
  decode: { group: "noiseReduction", domain: "scene", outputFrame: false },
  "noise-reduction": { group: "noiseReduction", domain: "scene", outputFrame: false },
  "scene-linear": { group: "sceneLinear", domain: "scene", outputFrame: false },
  "tone-map": { group: "sceneLinear", domain: "scene", outputFrame: false },
  "display-adjust": { group: "effects", domain: "display", outputFrame: false },
  effects: { group: "effects", domain: "display", outputFrame: true },
  "output-encode": { group: "effects", domain: "display", outputFrame: true },
};

// A stage can name a phase the table lacks: extensions are plain JavaScript and
// the registry only warns about it. Building must not throw for it, so it lands
// in effects, handled as scene values, as it always has.
const UNLISTED_PHASE: PhaseInfo = { group: "effects", domain: "scene", outputFrame: false };

export const phaseInfo = (phase: ProcessingPhase): PhaseInfo =>
  Object.hasOwn(PHASES, phase) ? PHASES[phase] : UNLISTED_PHASE;

const colourVariable = (domain: StageDomain): "lin" | "c" => (domain === "scene" ? "lin" : "c");

// Rules about a single stage: whether it reads the current image (as it
// declares, or by the built-in denoiser's rule), whether it is a contributed
// noise-reduction stage, and whether version 2 clips its input. Each is decided
// here and nowhere else, so a rule that changes one of them has a single place
// to go. Whether a stage is a core stage is decided in builtin-stage.ts, which
// says how the built-in denoiser differs. Everything else (space, passes,
// textures, helpers) is read straight off the declaration where used.
const readsCurrent = (s: ProcessingStageContribution, variant: ShaderVariant): boolean =>
  s.reads === "current" &&
  variant.version >= (s.readsCurrentFrom ?? 1) &&
  (s.passes?.length ?? 0) > 0 &&
  s.phase !== "geometry";

/** The built-in denoiser swaps `lin` for its own result. Made from the source,
 *  as on version 1, that result drops whatever a decode stage did to `lin`, so
 *  on version 2 the denoiser reads the image as the decode stages left it. With
 *  none ahead of it, it reads the source as it always has and costs no split. */
const keepsDecodeStages = (
  s: ProcessingStageContribution,
  ordered: readonly ProcessingStageContribution[],
  variant: ShaderVariant,
): boolean =>
  variant.fullInfo &&
  s.id === BUILTIN_DENOISE_ID &&
  ordered.slice(0, ordered.indexOf(s)).some((t) => t.phase === "decode");

/** A noise-reduction stage from outside the core: the built-in denoiser, or an
 *  extension's. */
const isContributedNR = (s: ProcessingStageContribution): boolean =>
  !isCoreStage(s) && s.phase === "noise-reduction";

/** A display stage that declares no `space` was written for values clipped to
 *  [0, 1]. Version 2 clips nothing upstream of it, so it and its passes are
 *  handed them clipped. */
const needsClippedInput = (
  s: ProcessingStageContribution,
  domain: StageDomain,
  variant: ShaderVariant,
): boolean => variant.fullInfo && domain === "display" && !s.space;

/** The built-in denoiser bows out when a community extension owns the
 *  noise-reduction phase (an extension NR stage replaces it, not stacks). It goes
 *  before the stages are ordered, so a stage naming it in `after` names a stage
 *  that isn't there, and no cycle can run through it. */
function withoutSupersededDenoiser(
  stages: readonly ProcessingStageContribution[],
): readonly ProcessingStageContribution[] {
  const superseded = stages.some((s) => s.id !== BUILTIN_DENOISE_ID && isContributedNR(s));
  return superseded ? stages.filter((s) => s.id !== BUILTIN_DENOISE_ID) : stages;
}

// ---------------------------------------------------------------------------
// Inter-stage variables
// ---------------------------------------------------------------------------

/** Each inter-stage variable type's zero, its global's initializer. */
const ISV_ZERO: Readonly<Record<InterStageVariable["glslType"], string>> = {
  float: "0.0",
  vec2: "vec2(0.0)",
  vec3: "vec3(0.0)",
  vec4: "vec4(0.0)",
};

const warnedIsv = new Set<string>();

function warnIsvOnce(key: string, message: string): void {
  if (warnedIsv.has(key)) return;
  warnedIsv.add(key);
  console.warn(message);
}

/** The variables the stages produce and their types. The registry refuses a
 *  second producer of a name, so the first one's type is the only one. */
function producedTypes(
  stages: readonly ProcessingStageContribution[],
): Map<string, InterStageVariable["glslType"]> {
  const types = new Map<string, InterStageVariable["glslType"]>();
  for (const s of stages) {
    for (const v of s.produces ?? []) if (!types.has(v.name)) types.set(v.name, v.glslType);
  }
  return types;
}

/** A consumer of a variable no stage in the set produces would name an
 *  undeclared identifier and fail the whole program, so it is left out. A stage
 *  left out stops producing, so this repeats until no more consumers go. It runs
 *  before withoutSupersededDenoiser: a noise-reduction stage left out here must
 *  not take the built-in denoiser with it. */
function withoutOrphanConsumers(
  stages: readonly ProcessingStageContribution[],
): readonly ProcessingStageContribution[] {
  let kept = stages;
  for (;;) {
    const produced = producedTypes(kept);
    const next = kept.filter((s) => {
      const missing = (s.consumes ?? []).find((name) => !produced.has(name));
      if (missing === undefined) return true;
      warnIsvOnce(
        `orphan|${s.id}|${missing}`,
        `[render] stage '${s.id}' consumes '${missing}', which no stage left in the set produces; it is left out`,
      );
      return false;
    });
    if (next.length === kept.length) return kept;
    kept = next;
  }
}

/** A consumer ordered ahead of its producer reads the zero initializer. */
function warnConsumersAhead(ordered: readonly ProcessingStageContribution[]): void {
  const seen = new Set<string>();
  for (const s of ordered) {
    for (const name of s.consumes ?? []) {
      if (!seen.has(name)) {
        warnIsvOnce(
          `ahead|${s.id}|${name}`,
          `[render] stage '${s.id}' runs ahead of the producer of '${name}', so it reads zero`,
        );
      }
    }
    for (const v of s.produces ?? []) seen.add(v.name);
  }
}

/** The global each produced variable lives in, declared ahead of the helpers. */
function isvDeclarations(ordered: readonly ProcessingStageContribution[]): string[] {
  return [...producedTypes(ordered)].map(([name, type]) => `${type} isv_${name} = ${ISV_ZERO[type]};`);
}

// ---------------------------------------------------------------------------
// Multi-pass prepass framework
// ---------------------------------------------------------------------------

// Passes render a plain fullscreen quad in SOURCE-UV space — no V flip — so that
// stageResult sampled at srcUv in the main shader aligns with uImage[srcUv].
export const PASS_VERTEX_SHADER = `#version 300 es
in vec2 aPos;
in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

// The prelude every pass program gets. It reproduces the main shader's pre-NR
// transform (linearize + RAW base curve) so a prepass result lives in the same
// tonal space as `lin` at the NR marker — then the stage's inline glsl can blend
// stageResult into lin without a tone shift. For a stage that declares a space,
// the first read converts the linearized source into that space's encoding and
// primaries, the ones its inline glsl works in; a display stage's passes still
// see the source from before the display transform. A stage without a space
// must get this prelude byte-identical to the version 1 freeze
// (v1-identity.test.tsx).
function passSharedGlsl(space: StageSpace | undefined): string {
  const converts = !isIdentitySpace(space, "scene");
  const firstRead = sourceRead(space, "s");
  return `
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 linearToSrgbU(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
${BASELINE_TONE_GLSL}
${converts ? STAGE_SPACE_GLSL : ""}uniform sampler2D uPrevPass;
uniform vec2 uTexel;
uniform int uPassIndex;
uniform int uPassCount;
uniform bool uPrevRaw;            // true only for the first read of the source
uniform bool uSrcLinear;
uniform bool uIsFallbackPreview;
uniform bool uApplyBaseCurve;
vec3 toLin(vec3 src) {
  vec3 lin = uSrcLinear ? src : (uIsFallbackPreview ? src : srgbToLinear(src));
  return uApplyBaseCurve ? baselineTone(lin) : lin;
}
vec3 readPrev(vec2 uv) {
  vec3 s = texture(uPrevPass, uv).rgb;
  return uPrevRaw ? ${firstRead} : s;
}
`;
}

/** A source texel `texel` as a pass's first read hands it over: linearized,
 *  base-curved, in the stage's space. */
function sourceRead(space: StageSpace | undefined, texel: string): string {
  return isIdentitySpace(space, "scene") ? `toLin(${texel})` : toSpaceExpr(space, "scene", `toLin(${texel})`);
}

/** The sampler a pass's readSource reads: the decoded source, which the
 *  runner binds at the scratch unit. */
export const SOURCE_IMAGE_UNIFORM = "uSourceImage";

/** The sampler fetchInput reads while the stage's input isn't the source as
 *  uploaded (INPUT_IS_SOURCE_UNIFORM false): the input the runner drew. */
export const INPUT_IMAGE_UNIFORM = "uInputImage";
export const INPUT_IS_SOURCE_UNIFORM = "uInputIsSource";

/** A pass's fetchInput. From the source, a pass texel maps to the source texel
 *  it falls in, which is itself at the pass size the runner draws the input at
 *  otherwise; only a GPU without float render targets reads another size here. */
function fetchInputGlsl(space: StageSpace | undefined): string {
  const fetched = sourceRead(space, `texelFetch(${SOURCE_IMAGE_UNIFORM}, t, 0).rgb`);
  return `uniform sampler2D ${INPUT_IMAGE_UNIFORM}; // the stage's input, drawn at pass size
uniform bool ${INPUT_IS_SOURCE_UNIFORM};
vec3 fetchInput(ivec2 texel) {
  if (${INPUT_IS_SOURCE_UNIFORM}) {
    vec2 pass = floor(1.0 / uTexel + 0.5);
    vec2 size = vec2(textureSize(${SOURCE_IMAGE_UNIFORM}, 0));
    ivec2 t = ivec2((vec2(clamp(texel, ivec2(0), ivec2(pass) - 1)) + 0.5) * size / pass);
    return ${fetched};
  }
  return texelFetch(${INPUT_IMAGE_UNIFORM}, clamp(texel, ivec2(0), textureSize(${INPUT_IMAGE_UNIFORM}, 0) - 1), 0).rgb;
}`;
}

/** A pass whose draw count comes from the bag (StagePass.iterations `{ key, max }`). */
export interface DrawCountBinding {
  /** "{stageId}.{key}", the bag entry the count is read from. */
  qualifiedKey: string;
  max: number;
  /** The uniform's declared default, used while the bag has no number. */
  fallback: number;
}

export interface PrepassPass {
  fragmentSource: string;
  /** A pass that names its region (StagePass.region): the vertex program that
   *  places each draw's quad over it, while uWholeDraw is false. */
  vertexSource?: string;
  /** The fixed draw count; with `drawCount`, the most draws a frame takes. */
  iterations: number;
  /** Set when the count comes from the bag; passDraws() resolves it per frame. */
  drawCount?: DrawCountBinding;
  bindings: ContributedBinding[];
  /** The pass names fetchInput, so its draws need the stage's input. */
  fetchesInput?: true;
  /** The state after the pass is checkpointed (StagePass.keep). */
  keep?: true;
}

/** Where a split stops the develop program. "decode": among the decode and
 *  noise-reduction stages, ahead of every core edit (noise reduction, white
 *  balance, exposure, masks). "scene": later, before the display transform.
 *  "display": after it. */
export type SplitCut = "decode" | StageDomain;

/** A stage that reads the current image: the develop program stops at its
 *  input when drawn with uSplitAt = index. */
export interface StageSplit {
  index: number;
  /** Decides what feeds the split (split-signature.ts). */
  cut: SplitCut;
  /** Stages whose params feed the split, in pipeline order. */
  upstreamStageIds: string[];
}

export interface PrepassStage {
  stageId: string;
  /** The stage's result sampler, which the main shader reads stageResult from.
   *  A layered stage (layerUniform set) doesn't declare it. */
  resultUniform: string;
  /** A layered program's (see layersResults): the int uniform holding the
   *  stage's layer of RESULT_ARRAY_UNIFORM (−1 while it has none). Absent for a
   *  stage that reads its own result sampler, as every stage of a program that
   *  isn't layered does. */
  layerUniform?: string;
  passes: PrepassPass[];
  split?: StageSplit;
  /** A mask copy's: the stage whose pass programs it draws with. Its passes
   *  compile to the same programs, bound with the copy's values. */
  passesOf?: string;
  /** The stage's dormantWhen (dormantRule): its passes don't run while it holds. */
  dormant?: DormantRule;
  /** A view-only stage's (ProcessingStageContribution.viewOnly): its passes
   *  run only for a frame that draws view stages (PrepassFrame.viewStages). */
  viewOnly?: true;
  /** Set when a pass fetches the input: the program that draws the source at
   *  pass size as the first draw reads it, for a source of another size. */
  inputSource?: string;
}

/** The uniform holding a mask copy's coverage slot (its mask's index, or -1
 *  while the mask applies nothing), which render() binds per frame. */
export interface MaskSlotBinding {
  stageId: string;
  glslName: string;
}

/** The array a layered program reads every layered stage result from. */
export const RESULT_ARRAY_UNIFORM = "uStageResults";

/** The samplers the stages add to the develop program while each keeps its own:
 *  one per prepass result, and one per lut, dynamic or paint texture
 *  (coverage rides the brush atlas; an official stage's per-photo textures take units the
 *  develop program counts as its own, DEVELOP_SAMPLERS). A core stage declares
 *  neither. */
const OWN_SAMPLER_KINDS: ReadonlySet<TextureRequirement["kind"]> = new Set(["lut", "dynamic", "paint"]);

function stageSamplers(ordered: readonly ProcessingStageContribution[]): number {
  let samplers = 0;
  for (const s of ordered) {
    if (isCoreStage(s)) continue;
    if ((s.passes?.length ?? 0) > 0) samplers++;
    samplers += (s.textures ?? []).filter((t) => OWN_SAMPLER_KINDS.has(t.kind)).length;
  }
  return samplers;
}

// Whether the program reads its stage results from layers of one shared array
// rather than a sampler each. A sampler per stage is a texture per stage, each
// a separate small resource. The array is one large one, which D3D11 (ANGLE on
// Windows) only guarantees up to min(max(128 MB, a quarter of dedicated VRAM),
// 2048 MB); an RGBA16F layer at the 4096 px develop edge is about 90 MB, so two
// stages can pass that on an integrated GPU. The array is therefore kept for a
// set that a sampler per stage would take past the shader's sampler limit.
// Version 1 never layers: its text is frozen.
const layersResults = (
  ordered: readonly ProcessingStageContribution[],
  variant: ShaderVariant,
  samplerBudget: number,
): boolean => variant.fullInfo && stageSamplers(ordered) > samplerBudget;

/** Build a complete fragment program for one StagePass, namespacing its uniforms
 *  + helpers under the owning stage's prefix so they share the stage's param keys,
 *  and, for a pass that names its region, the vertex program that places each
 *  draw's quad over it. A mask copy passes its stage's id as `prefixId`: same
 *  programs, its own keys. */
function buildPassPrograms(
  stageId: string,
  pass: StagePass,
  space: StageSpace | undefined,
  prefixId = stageId,
): { fragmentSource: string; vertexSource?: string; bindings: ContributedBinding[]; fetchesInput: boolean } {
  const uPfx = uniformPrefix(prefixId);
  const hPfx = helperPrefix(prefixId);
  const uniforms = pass.uniforms ?? [];
  const bindings: ContributedBinding[] = uniforms.map((u) => bindingOf({ id: stageId }, u, uPfx));
  const uniformDecls = uniforms.map((u) => emitUniformDecl(u, uPfx)).join("\n");
  const helperNames = pass.helpers ? extractHelperNames(pass.helpers) : [];
  let helpers = "";
  if (pass.helpers) {
    let h = replaceIdentifiers(pass.helpers, helperNames, hPfx);
    h = replaceIdentifiers(h, uniforms.map((u) => u.key), uPfx);
    helpers = h;
  }
  const body = rewriteGlsl(pass.glsl, uniforms, uPfx, hPfx, helperNames);
  const region = pass.region === undefined ? undefined : rewriteGlsl(pass.region, uniforms, uPfx, hPfx, helperNames);
  // uSourceSize and readSource are part of the pass contract (types.ts
  // StagePass) but are declared only where named: the version 1 freeze
  // (v1-identity.test.tsx) pins the prelude every older pass gets, and none of
  // those name them.
  const named = body + helpers + (region ?? "");
  const readsSource = /\breadSource\b/.test(named);
  const fetchesInput = /\bfetchInput\b/.test(named);
  const sourceSampler = `\nuniform sampler2D ${SOURCE_IMAGE_UNIFORM}; // the decoded source, whatever the stage reads\n`;
  const readSource =
    (readsSource ? sourceSampler + `vec3 readSource(vec2 uv) { return ${sourceRead(space, `texture(${SOURCE_IMAGE_UNIFORM}, uv).rgb`)}; }` : "") +
    (fetchesInput ? (readsSource ? "\n" : sourceSampler) + fetchInputGlsl(space) : "");
  // Every draw after the first starts from its own texel fetched exactly: a
  // filtered read at vUv can mix in a trace of the neighbours (SwiftShader
  // does), which a long chain compounds. The stage's input may be the source
  // at another size, so the first draw still samples it. A four-channel pass
  // also stores its alpha (StagePass.channels). Its reads take the pass texel
  // as their gradient, the level texture() picks for a read that follows the
  // fragment, and use no implicit-derivative op: ANGLE on D3D11 flattens every
  // branch around a loop that reaches one, so each draw would run them all.
  const four = pass.channels === 4;
  const readPrev4 = four
    ? `\nvec4 readPrev4(vec2 uv) {\n  vec4 s = textureGrad(uPrevPass, uv, vec2(uTexel.x, 0.0), vec2(0.0, uTexel.y));\n  return uPrevRaw ? vec4(${sourceRead(space, "s.rgb")}, 1.0) : s;\n}` +
      `\nvec4 fetchPrev4(ivec2 texel) {\n  return uPrevRaw ? readPrev4((vec2(texel) + 0.5) * uTexel) : texelFetch(uPrevPass, texel, 0);\n}`
    : "";
  const declarations = `${uniformDecls}
${passSharedGlsl(space)}
${/\buSourceSize\b/.test(named) ? "uniform vec2 uSourceSize; // the decoded source's size before the upload cap" : ""}${readSource}${readPrev4}
${helpers}`;
  const fragmentSource = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
${declarations}
void main() {
  ${four ? "vec4 c = fetchPrev4(ivec2(gl_FragCoord.xy));" : "vec3 c = uPrevRaw ? readPrev(vUv) : texelFetch(uPrevPass, ivec2(gl_FragCoord.xy), 0).rgb;"}
  {
${body}
  }
  fragColor = ${four ? "c" : "vec4(c, 1.0)"};
}
`;
  if (region === undefined) return { fragmentSource, bindings, fetchesInput };
  // The fragment program's integers are mediump by default; a uniform both
  // programs declare must agree, or the program doesn't link.
  const vertexSource = `#version 300 es
precision highp float;
precision mediump int;
in vec2 aPos;
in vec2 aUv;
out vec2 vUv;
${declarations}
uniform bool uWholeDraw;
ivec4 passRegion() {
${region}
}
void main() {
  if (uWholeDraw) {
    vUv = aUv;
    gl_Position = vec4(aPos, 0.0, 1.0);
    return;
  }
  vec2 size = floor(1.0 / uTexel + 0.5);
  vec4 r = clamp(vec4(passRegion()), vec4(0.0), size.xyxy);
  vUv = mix(r.xy, max(r.zw, r.xy), aUv) * uTexel;
  gl_Position = vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
}
`;
  return { fragmentSource, vertexSource, bindings, fetchesInput };
}

export interface BuiltStageInjection {
  injection: StageInjection;
  /** The same for every variant: a pass's source doesn't depend on it. Pass
   *  programs are keyed on it and on the process version, which they are
   *  compiled with (SL_PROCESS_VERSION), as the develop program is. */
  sig: string;
  bindings: ContributedBinding[];
  textureBindings: StageTextureBinding[];
  prepass: PrepassStage[];
  maskSlots: MaskSlotBinding[];
  hasNoiseReduction: boolean;
  /** The stages, other than core's own, the built-in denoiser and those that
   *  declare keepsDetail, that write the colour in the decode or
   *  noise-reduction phase. While one of them is
   *  at work `lin` may be a picture rebuilt from base-resolution passes, which
   *  a detail gain must not scale (detail-gain.ts rebuildsSource). */
  rebuilders: readonly Rebuilder[];
  /** In the order written. Kept out of `injection`, whose every field the
   *  version 2 freeze hashes. */
  steps: readonly InjectionStep[];
}

/** A stage that writes the colour ahead of the detail gain, with the value
 *  each of its uniforms starts at, under the key the bag holds it by. */
export interface Rebuilder {
  id: string;
  defaults: Readonly<Record<string, UniformValue>>;
}

function rebuilderOf(s: ProcessingStageContribution): Rebuilder {
  const defaults: Record<string, UniformValue> = {};
  for (const u of [...s.uniforms, ...(s.passes ?? []).flatMap((p) => p.uniforms ?? [])]) {
    if (u.default !== undefined) defaults[`${s.id}.${u.key}`] = u.default;
  }
  return { id: s.id, defaults };
}

/** Everything about a stage that the renderer derives state from, hashed.
 *  Deliberately wider than the GLSL (it takes in uniform defaults, labels and
 *  ranges, texture sizes): syncPipeline returns early on an equal signature, so
 *  a stage change reaches the bindings and prepass state only through this, and
 *  narrowing it to the shader text brings back stale defaults. */
export function stageSignature(s: ProcessingStageContribution): string {
  const handoff = s.produces || s.consumes ? [s.produces ?? [], s.consumes ?? []] : [];
  return simpleHash(
    JSON.stringify([
      s.phase,
      s.priority ?? 100,
      s.glsl,
      s.helpers ?? "",
      s.uniforms,
      s.textures ?? [],
      s.passes ?? [],
      s.space ?? null,
      s.reads ?? "source",
      ...handoff,
      ...(s.readsCurrentFrom === undefined ? [] : [{ readsCurrentFrom: s.readsCurrentFrom }]),
      ...(s.dormantWhen === undefined ? [] : [{ dormantWhen: s.dormantWhen }]),
      ...(s.viewOnly === true ? [{ viewOnly: true }] : []),
    ]),
  );
}

/** A stage as builds and draws report it, and the GPU crash guard keeps it: "{id}:{signature}". */
export const stageKey = (s: ProcessingStageContribution): string => `${s.id}:${stageSignature(s)}`;

const dormantRules =new WeakMap<ProcessingStageContribution, DormantRule | null>();

/** The stage's dormantWhen as the bindings its values are read through, under
 *  the stage's own id, so a mask copy's rule reads its mask's values. Null for
 *  a stage that declares none, or one whose absence would change the frame
 *  anyway (dormancyIgnored), or whose rule names a uniform it doesn't hold. */
export function dormantRule(s: ProcessingStageContribution): DormantRule | null {
  if (!s.dormantWhen) return null;
  const known = dormantRules.get(s);
  if (known !== undefined) return known;
  const declared = declaredUniforms(s);
  const rule: { binding: ContributedBinding; value: UniformValue }[] = [];
  for (const [key, value] of Object.entries(s.dormantWhen)) {
    const u = declared.find((d) => d.key === key && d.length === undefined);
    if (!u) break;
    rule.push({ binding: bindingOf(s, u, ""), value });
  }
  const whole = rule.length > 0 && rule.length === Object.keys(s.dormantWhen).length;
  const resolved = whole && dormancyIgnored(s) === null ? rule : null;
  dormantRules.set(s, resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// Building the injection
// ---------------------------------------------------------------------------

/** Writes the GLSL lines of each injection group, and keeps each colour group's
 *  variable in the space the next block expects. */
class GroupWriter {
  private readonly lines: Record<InjectionGroup, string[]> = {
    srcUv: [],
    noiseReduction: [],
    sceneLinear: [],
    effects: [],
  };
  // The space each colour group's variable holds between stage blocks.
  // Adjacent stages declaring one space convert once rather than per stage,
  // and every group hands the core back its working values.
  private readonly held: Record<ColourGroup, StageSpace | undefined> = {
    noiseReduction: undefined,
    sceneLinear: undefined,
    effects: undefined,
  };
  private needsSpaceHelpers = false;
  readonly steps: InjectionStep[] = [];

  push(group: InjectionGroup, line: string): void {
    this.lines[group].push(line);
  }

  /** Brings the group's variable from the space it holds into `space`. */
  convert(group: ColourGroup, domain: StageDomain, space: StageSpace | undefined): void {
    const from = this.held[group];
    if (spaceKey(from, domain) === spaceKey(space, domain)) {
      if (!isIdentitySpace(space, domain)) {
        this.steps.push({ kind: "convert", group, domain, from, to: space, elided: true });
      }
      return;
    }
    this.steps.push({ kind: "convert", group, domain, from, to: space });
    const v = colourVariable(domain);
    if (!isIdentitySpace(from, domain)) {
      this.push(group, `${v} = ${fromSpaceExpr(from, domain, v)};`);
    }
    if (!isIdentitySpace(space, domain)) {
      this.push(group, `${v} = ${toSpaceExpr(space, domain, v)};`);
      this.markSpaceHelpers();
    }
    this.held[group] = space;
  }

  /** `block` with the group's variable brought into `space` ahead of it, clipped
   *  to [0, 1] first when `clip`, and back after it, so what the group holds
   *  between blocks stays as it was: for a block that may not run (a view-only
   *  stage's), whose input must not reach the frame without it. */
  within(group: ColourGroup, domain: StageDomain, space: StageSpace | undefined, clip: boolean, block: string): string {
    const from = this.held[group];
    if (!clip && spaceKey(from, domain) === spaceKey(space, domain)) return block;
    const v = colourVariable(domain);
    const into: string[] = [];
    const back: string[] = [];
    if (!isIdentitySpace(from, domain)) {
      into.push(`${v} = ${fromSpaceExpr(from, domain, v)};`);
      back.unshift(`${v} = ${toSpaceExpr(from, domain, v)};`);
    }
    if (clip) into.push(LEGACY_DISPLAY_CLAMP);
    if (!isIdentitySpace(space, domain)) {
      into.push(`${v} = ${toSpaceExpr(space, domain, v)};`);
      back.unshift(`${v} = ${fromSpaceExpr(space, domain, v)};`);
    }
    if (!isIdentitySpace(from, domain) || !isIdentitySpace(space, domain)) this.markSpaceHelpers();
    return `{\n${[...into, block, ...back].join("\n")}\n}`;
  }

  /** Notes that written GLSL calls the space helpers, so they get compiled in. */
  markSpaceHelpers(): void {
    this.needsSpaceHelpers = true;
  }

  /** Hands every colour group back to working values, then returns the groups'
   *  GLSL and whether any of it needs the space helpers compiled in. */
  finish(): Record<InjectionGroup, string> & { needsSpaceHelpers: boolean } {
    this.convert("noiseReduction", "scene", undefined);
    this.convert("sceneLinear", "scene", undefined);
    this.convert("effects", "display", undefined);
    const text = (group: InjectionGroup): string => this.lines[group].join("\n  ");
    return {
      srcUv: text("srcUv"),
      noiseReduction: text("noiseReduction"),
      sceneLinear: text("sceneLinear"),
      effects: text("effects"),
      needsSpaceHelpers: this.needsSpaceHelpers,
    };
  }
}

/** The exits of the stages that read the current image: drawn with uSplitAt set
 *  to a reader's index, the develop program stops at that reader's input. */
class SplitExits {
  private readonly variant: ShaderVariant;
  private readonly writer: GroupWriter;
  /** The readers in pipeline order; a reader's position is its uSplitAt index. */
  private readonly readers: ProcessingStageContribution[];
  /** Output-frame readers (PhaseInfo.outputFrame) whose exits are not emitted yet. */
  private deferred: ProcessingStageContribution[];
  /** The stages emitted so far whose params feed a split drawn from here on. */
  private readonly upstream: string[] = [];
  private readonly splits = new Map<string, StageSplit>();

  constructor(
    ordered: readonly ProcessingStageContribution[],
    variant: ShaderVariant,
    writer: GroupWriter,
  ) {
    this.variant = variant;
    this.writer = writer;
    this.readers = ordered.filter((s) => readsCurrent(s, variant) || keepsDecodeStages(s, ordered, variant));
    this.deferred = this.readers.filter((s) => phaseInfo(s.phase).outputFrame);
  }

  /** How many exits the program carries; none leaves its text untouched. */
  get count(): number {
    return this.readers.length;
  }

  /** The split a reader's prepass is drawn for, once its exit is emitted. */
  splitOf(stageId: string): StageSplit | undefined {
    return this.splits.get(stageId);
  }

  /** Writes the exits that go ahead of `s`. Output-frame readers (effects and
   *  output-encode) all exit together, ahead of the first output-frame stage,
   *  which is the end of display-adjust. Any other reader exits right ahead of
   *  its own block. */
  beforeStage(s: ProcessingStageContribution): void {
    const { group, domain, outputFrame } = phaseInfo(s.phase);
    if (outputFrame) {
      for (const reader of this.deferred) this.emitExit("effects", "display", reader);
      this.deferred = [];
    }
    if (group !== "srcUv" && domain && !outputFrame && this.readers.includes(s)) {
      this.emitExit(group, domain, s);
    }
  }

  /** Counts `s` as feeding every split drawn after it. A split draw skips
   *  geometry, so a geometry stage never feeds one, and a core stage's values
   *  come from typed params, so no bag entry of its can. */
  afterStage(s: ProcessingStageContribution): void {
    if (phaseInfo(s.phase).domain && !isCoreStage(s)) this.upstream.push(s.id);
  }

  private emitExit(
    group: ColourGroup,
    domain: StageDomain,
    reader: ProcessingStageContribution,
  ): void {
    this.writer.convert(group, domain, undefined);
    const v = colourVariable(domain);
    // A legacy display stage's passes see what its inline glsl sees: on
    // version 2, values clipped to [0, 1].
    const clamped = needsClippedInput(reader, domain, this.variant);
    const input = clamped ? `clamp(${v}, 0.0, 1.0)` : v;
    const index = this.readers.indexOf(reader);
    const value = toSpaceExpr(reader.space, domain, input);
    if (!isIdentitySpace(reader.space, domain)) this.writer.markSpaceHelpers();
    const exit = `if (uSplitAt == ${index}) { fragColor = vec4(${value}, 1.0); return; }`;
    this.writer.push(group, exit);
    this.writer.steps.push({ kind: "exit", group, stageId: reader.id, clamped });
    const cut: SplitCut = group === "noiseReduction" ? "decode" : domain;
    this.splits.set(reader.id, { index, cut, upstreamStageIds: [...this.upstream] });
  }
}

/** The clip ahead of a display stage that declares no space, on version 2. */
const LEGACY_DISPLAY_CLAMP = "c = clamp(c, 0.0, 1.0);";

/** Leaves the group's variable as the stage's block expects to receive it: a core
 *  stage gets working values, any other stage its declared space (clipped first
 *  for a legacy display stage on version 2). */
function prepareInput(
  writer: GroupWriter,
  s: ProcessingStageContribution,
  group: ColourGroup,
  domain: StageDomain,
  variant: ShaderVariant,
): void {
  const core = writesRawNames(s);
  if (!core && needsClippedInput(s, domain, variant)) {
    // Written for display values in [0, 1]: on a version 2 photo nothing
    // upstream clipped them, so this stage gets them clipped here. A mask
    // copy clips inside its coverage instead (emitMaskCopy): pixels its mask
    // leaves alone keep what the stage before it made.
    writer.convert(group, domain, undefined);
    if (!isMaskInstance(s)) {
      writer.push(group, LEGACY_DISPLAY_CLAMP);
      writer.steps.push({ kind: "clamp", group, reason: "legacy-display-stage", stageId: s.id });
    }
  }
  writer.convert(group, domain, core ? undefined : s.space);
}

/** What the stages declare outside their own blocks: global GLSL, and the
 *  bindings and prepass layout the renderer drives it with. */
interface Declared {
  uniforms: string[];
  helpers: string[];
  bindings: ContributedBinding[];
  textureBindings: StageTextureBinding[];
  prepass: PrepassStage[];
  maskSlots: MaskSlotBinding[];
  /** Whether a stage reads RESULT_ARRAY_UNIFORM, which is then declared. */
  readsArray: boolean;
}

/** Core stages and official extensions' stages keep raw
 *  uniform names, bound from the frame's bag under their qualified keys: the
 *  values they derive from the photo's params (stage-derive.ts), or what the
 *  photo's paramBag holds. Declares them as written, with `helpers` as the
 *  program compiles them. */
function declareRawStage(s: ProcessingStageContribution, declared: Declared, helpers: string | undefined): void {
  for (const [name, value] of Object.entries(s.defines ?? {})) declared.uniforms.push(`#define ${name} ${value}`);
  for (const u of s.uniforms) {
    declared.uniforms.push(emitUniformDecl(u, ""));
    declared.bindings.push(bindingOf(s, u, ""));
  }
  declareTextures(s, "", declared);
  if (helpers) declared.helpers.push(helpers);
}

/** How render() binds one of a stage's uniforms from the bag. */
const bindingOf = (s: Pick<ProcessingStageContribution, "id">, u: UniformDeclaration, uPfx: string): ContributedBinding => ({
  qualifiedKey: `${s.id}.${u.key}`,
  glslName: uPfx + u.key,
  glslType: u.glslType,
  ...(u.length === undefined ? {} : { length: u.length }),
  ...(u.space === "image" && u.glslType === "mat3" ? { space: "image" as const } : {}),
  default: u.default,
});

/** True while the program draws a frame for the eye, which only the live
 *  view's renderer does (WebGLRendererOpts.drawsViewStages). */
export const VIEW_STAGES_UNIFORM = "uViewStages";

/** A view-only stage's block (ProcessingStageContribution.viewOnly), run only
 *  while VIEW_STAGES_UNIFORM is on; the switch is declared once per program. */
function viewOnlyBlock(block: string, declared: Declared): string {
  const decl = `uniform bool ${VIEW_STAGES_UNIFORM};`;
  if (!declared.uniforms.includes(decl)) declared.uniforms.push(decl);
  return `if (${VIEW_STAGES_UNIFORM}) ${block}`;
}

/** A raw-name stage in its phase's group: its block, braced. */
function emitCoreStage(s: ProcessingStageContribution, declared: Declared): string {
  declareRawStage(s, declared, s.helpers);
  return `{\n${s.glsl}\n}`;
}

/** A stage at an anchor: declared as a raw-name stage is, its block and
 *  helpers written as they read so the program around them keeps its text. */
function emitAnchoredStage(s: ProcessingStageContribution, declared: Declared): string {
  declareRawStage(s, declared, s.helpers);
  return s.glsl;
}

/** Version 1's frozen tone block can't record the scene's headroom, so a
 *  display stage that names slSceneLuma gets the luminance it does have. */
const V1_SCENE_LUMA = "float slSceneLuma = max(luma(lin), 0.0);\n";

/** Extension stages: namespace uniforms + helpers so two extensions never
 *  collide, and record bindings so render() can drive them from the bag.
 *  Returns the stage's block. */
function emitExtensionStage(
  s: ProcessingStageContribution,
  declared: Declared,
  split: StageSplit | undefined,
  layered: boolean,
  variant: ShaderVariant,
  domain: StageDomain | null,
): string {
  if (isMaskInstance(s) && domain) return emitMaskCopy(s, declared, split, layered, variant, domain);
  const uPfx = uniformPrefix(s.id);
  const hPfx = helperPrefix(s.id);
  declareUniforms(s, uPfx, declared);
  declareTextures(s, uPfx, declared);
  const helperNames = declareHelpers(s, uPfx, hPfx, declared);
  const prelude = declarePrepass(s, uPfx, split, declared, layered);
  const textureKeys = (s.textures ?? []).map((t) => t.key);
  const rewrite = (src: string): string =>
    replaceIdentifiers(rewriteGlsl(src, s.uniforms, uPfx, hPfx, helperNames), textureKeys, uPfx);
  const inline = rewrite(s.glsl);
  const sceneLuma =
    !variant.fullInfo && domain === "display" && /\bslSceneLuma\b/.test(s.glsl) ? V1_SCENE_LUMA : "";
  const produced = (s.produces ?? [])
    .flatMap((v) => {
      if (v.producer === undefined) return [];
      return [`\nisv_${v.name} = (${rewrite(v.producer)}\n);`];
    })
    .join("");
  // A view-only block runs in every live frame, the aid off included: one that
  // reads its result through its own sampler pays no fetch per pixel for it.
  const fetched = s.viewOnly === true && !/\bstageResult\b/.test(withoutComments(s.glsl)) ? "" : prelude;
  return `{\n${sceneLuma}${fetched}${inline}${produced}\n}`;
}

/** GLSL with its comments blanked out, for telling what the code names. */
export const withoutComments = (glsl: string): string => glsl.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");

/** A stage's copy for one mask (mask-stage-instances.ts): the stage's block
 *  under the copy's own uniforms, run where the mask covers and blended in by
 *  its coverage (`mcovs`, which main() fills ahead of every maskable phase).
 *  The copy samples the stage's lookup textures, calls its helpers when they
 *  read no uniform, and draws its pass programs with its own values. What the
 *  stage produces stays local to the copy, so consumers still read the stage.
 *  A display stage that declares no space has its input clipped inside the
 *  coverage, so the pixels the mask leaves alone keep their full range.
 *  Copies run on version 2 or later only, so the version 1 scene-luma line
 *  never applies. Returns the copy's block. */
function emitMaskCopy(
  s: MaskInstanceStage,
  declared: Declared,
  split: StageSplit | undefined,
  layered: boolean,
  variant: ShaderVariant,
  domain: StageDomain,
): string {
  const uPfx = uniformPrefix(s.id);
  const stagePfx = uniformPrefix(s.instanceOf);
  // Glsl that names the stage's result sampler (to texelFetch it) reads the copy's.
  const ownResult = (src: string): string =>
    src.replaceAll(`${stagePfx}stageResult`, `${uPfx}stageResult`);
  const copy: MaskInstanceStage = {
    ...s,
    glsl: ownResult(s.glsl),
    ...(s.helpers ? { helpers: ownResult(s.helpers) } : {}),
  };
  declareUniforms(copy, uPfx, declared);
  const uniformKeys = copy.uniforms.map((u) => u.key);
  const sharesHelpers =
    copy.helpers === s.helpers && !mentionsIdentifier(withoutComments(copy.helpers ?? ""), uniformKeys);
  const hPfx = helperPrefix(sharesHelpers ? s.instanceOf : s.id);
  const helperNames = sharesHelpers
    ? extractHelperNames(copy.helpers ?? "")
    : declareHelpers(copy, uPfx, hPfx, declared, stagePfx);
  const prelude = declarePrepass(copy, uPfx, split, declared, layered, s.instanceOf);
  const textureKeys = (copy.textures ?? []).map((t) => t.key);
  const inline = replaceIdentifiers(
    rewriteGlsl(copy.glsl, copy.uniforms, uPfx, hPfx, helperNames),
    textureKeys,
    stagePfx,
  );
  const slot = `${uPfx}slMaskSlot`;
  declared.uniforms.push(`uniform int ${slot};`);
  declared.maskSlots.push({ stageId: s.id, glslName: slot });
  const local = (copy.produces ?? [])
    .map((v) => `${v.glslType} isv_${v.name} = isv_${v.name};\n`)
    .join("");
  const v = colourVariable(domain);
  // A legacy display stage's copy gets its input clipped here, inside its
  // coverage, rather than ahead of it (prepareInput).
  const clip = needsClippedInput(s, domain, variant) ? `${LEGACY_DISPLAY_CLAMP}\n` : "";
  return (
    `{\nint slInstSlot = ${slot};\n` +
    `if (slInstSlot >= 0 && mcovs[slInstSlot] > 0.0) {\n` +
    `vec3 slInstPre = ${v};\n${clip}${local}{\n${prelude}${inline}\n}\n` +
    `${v} = mix(slInstPre, ${v}, mcovs[slInstSlot]);\n}\n}`
  );
}

function declareUniforms(s: ProcessingStageContribution, uPfx: string, declared: Declared): void {
  for (const u of s.uniforms) {
    declared.uniforms.push(emitUniformDecl(u, uPfx));
    declared.bindings.push(bindingOf(s, u, uPfx));
  }
}

/** Stage textures: LUT/dynamic kinds get a namespaced sampler bound from the
 *  uploaded data; coverage kinds ride the brush atlas (no texture unit) and
 *  paint kinds get a sampler of their own, both exposed to the inline glsl /
 *  helpers as a function under their `key`.
 *  The declarations are in the signature, so a change in the texture set
 *  recompiles, but a data swap or a new dab (same set) doesn't. */
function declareTextures(s: ProcessingStageContribution, uPfx: string, declared: Declared): void {
  for (const t of s.textures ?? []) {
    const glslName = uPfx + t.key;
    if (t.kind === "coverage") {
      declared.uniforms.push(`uniform int ${glslName}_ch;`);
      declared.helpers.push(coverageHelperGlsl(glslName));
    } else if (t.kind === "paint") {
      declared.uniforms.push(`uniform sampler2D ${glslName}_tex;`);
      declared.helpers.push(paintHelperGlsl(glslName));
    } else {
      declared.uniforms.push(`uniform sampler2D ${glslName};`);
    }
    declared.textureBindings.push({ qualifiedKey: `${s.id}.${t.key}`, glslName, kind: t.kind });
  }
}

/** Declares the stage's helpers under its prefixes and returns their original
 *  names, which the inline glsl is rewritten with. A mask copy's texture keys
 *  take its stage's prefix (`texturePfx`), whose textures it samples. */
function declareHelpers(
  s: ProcessingStageContribution,
  uPfx: string,
  hPfx: string,
  declared: Declared,
  texturePfx = uPfx,
): string[] {
  if (!s.helpers) return [];
  const uniformKeys = s.uniforms.map((u) => u.key);
  const textureKeys = (s.textures ?? []).map((t) => t.key);
  const helperNames = extractHelperNames(s.helpers);
  let h = replaceIdentifiers(s.helpers, helperNames, hPfx);
  // Uniform + texture keys share the stage's uniform prefix; rewrite them in one
  // longest-first pass so a short key never partially matches inside a longer one.
  h =
    texturePfx === uPfx
      ? replaceIdentifiers(h, [...uniformKeys, ...textureKeys], uPfx)
      : replaceIdentifiers(replaceIdentifiers(h, uniformKeys, uPfx), textureKeys, texturePfx);
  declared.helpers.push(h);
  return helperNames;
}

/** A fixed draw count as the renderer takes it: a whole number from 1 to
 *  MAX_PASS_DRAWS, or 1 when the count isn't finite. The worker loops once per
 *  draw, so nothing unbounded may reach it. */
function fixedDraws(count: number | undefined): number {
  if (count === undefined || !Number.isFinite(count)) return 1;
  return Math.min(MAX_PASS_DRAWS, Math.max(1, Math.floor(count)));
}

/** A pass's draws: a fixed count, or the bag entry the renderer reads it from. */
function passCount(
  s: ProcessingStageContribution,
  p: StagePass,
): Pick<PrepassPass, "iterations" | "drawCount"> {
  const count = p.iterations;
  if (typeof count !== "object") return { iterations: fixedDraws(count) };
  const declared = [...s.uniforms, ...(p.uniforms ?? [])].find((u) => u.key === count.key);
  const fallback =
    typeof declared?.default === "number" && Number.isFinite(declared.default) ? declared.default : 0;
  return {
    iterations: count.max,
    drawCount: { qualifiedKey: `${s.id}.${count.key}`, max: count.max, fallback },
  };
}

/** Prepass-bearing stages: expose the prepass result to the inline glsl as
 *  `vec3 stageResult` and compile a program per pass. Pass uniforms join the
 *  same namespace so one param key can drive both the pass and the inline glsl.
 *  In a layered program the stage reads its layer of the shared result array,
 *  unless its own glsl names its result sampler (to texelFetch it, say), which
 *  then stays. A mask copy names its stage as `passesOf`: its passes compile to
 *  the stage's programs, and only its result and keys are its own. Returns the
 *  line that declares `stageResult` ("" for a stage without passes). */
function declarePrepass(
  s: ProcessingStageContribution,
  uPfx: string,
  split: StageSplit | undefined,
  declared: Declared,
  layered: boolean,
  passesOf?: string,
): string {
  const stagePasses = s.passes ?? [];
  if (stagePasses.length === 0) return "";
  const resultUniform = `${uPfx}stageResult`;
  const named = s.glsl.includes(resultUniform) || (s.helpers ?? "").includes(resultUniform);
  const layerUniform = layered && !named ? `${uPfx}stageResultLayer` : undefined;
  if (layerUniform) {
    declared.uniforms.push(`uniform int ${layerUniform};`);
    declared.readsArray = true;
  } else {
    declared.uniforms.push(`uniform sampler2D ${resultUniform};`);
  }
  const passes: PrepassPass[] = stagePasses.map((p) => {
    const built = buildPassPrograms(s.id, p, s.space, passesOf);
    // A copy's pass bindings name its stage's uniforms, which the develop
    // program may declare too: binding a copy's value there would edit the stage.
    for (const b of passesOf ? [] : built.bindings) {
      if (!declared.bindings.some((x) => x.qualifiedKey === b.qualifiedKey)) {
        declared.bindings.push(b);
      }
    }
    return {
      fragmentSource: built.fragmentSource,
      ...(built.vertexSource === undefined ? {} : { vertexSource: built.vertexSource }),
      bindings: built.bindings,
      ...passCount(s, p),
      ...(built.fetchesInput ? { fetchesInput: true as const } : {}),
      ...(p.keep === true ? { keep: true as const } : {}),
    };
  });
  const dormant = dormantRule(s);
  // The input drawn as the first draw reads it: an empty pass of the first
  // pass's channel count.
  const input = passes.some((p) => p.fetchesInput)
    ? buildPassPrograms(s.id, { glsl: "", ...(stagePasses[0].channels === 4 ? { channels: 4 } : {}) }, s.space, passesOf)
    : undefined;
  declared.prepass.push({
    stageId: s.id,
    resultUniform,
    passes,
    split,
    ...(layerUniform ? { layerUniform } : {}),
    ...(passesOf ? { passesOf } : {}),
    ...(dormant ? { dormant } : {}),
    ...(s.viewOnly === true ? { viewOnly: true as const } : {}),
    ...(input ? { inputSource: input.fragmentSource } : {}),
  });
  if (!layerUniform) return `vec3 stageResult = texture(${resultUniform}, srcUv).rgb;\n`;
  return (
    `vec3 stageResult = ${layerUniform} < 0 ? texture(uImage, srcUv).rgb : ` +
    `texture(${RESULT_ARRAY_UNIFORM}, vec3(srcUv, float(${layerUniform}))).rgb;\n`
  );
}

const ANCHOR_RANK = new Map(Object.keys(STAGE_ANCHORS).map((a, i) => [a, i]));
const anchorRank = (s: ProcessingStageContribution): number =>
  ANCHOR_RANK.get(anchorOf(s) ?? openAnchorOf(s) ?? "") ?? -1;

/** `ordered` with its anchored stages, in the places they hold, put in the
 *  order their anchors have in main(): an official extension's stage registers
 *  after core's, but runs where its anchor is. */
function inAnchorOrder(ordered: ProcessingStageContribution[]): ProcessingStageContribution[] {
  const anchored = ordered.filter((s) => anchorRank(s) >= 0).sort((a, b) => anchorRank(a) - anchorRank(b));
  let next = 0;
  return ordered.map((s) => (anchorRank(s) >= 0 ? anchored[next++] : s));
}

/** The injection, bindings and prepass programs for the stages passed in. It
 *  never consults the registry: the caller decides which stages are active.
 *  `variant` must be the one the program is assembled with: version 2 clips
 *  display values ahead of extension stages that declared no space, and its built-in denoiser
 *  reads the image as the decode stages ahead of it left it. `samplerBudget` is
 *  how many samplers the shader's limit leaves the stages; a version 2 set that
 *  would pass it reads its results from one array (layersResults). */
export function buildStageInjection(
  stages: readonly ProcessingStageContribution[],
  variant: ShaderVariant = V1_VARIANT,
  samplerBudget = Infinity,
): BuiltStageInjection {
  const registered = new Map(stages.map((s) => [s.id, s]));
  const ordered = inAnchorOrder(sortStages(withoutSupersededDenoiser(withoutOrphanConsumers(stages))));
  warnConsumersAhead(ordered);
  const layered = layersResults(ordered, variant, samplerBudget);
  const writer = new GroupWriter();
  const exits = new SplitExits(ordered, variant, writer);
  const declared: Declared = {
    uniforms: [],
    helpers: [],
    bindings: [],
    textureBindings: [],
    prepass: [],
    maskSlots: [],
    readsArray: false,
  };

  const anchored: Partial<Record<StageAnchor, string[]>> = {};

  for (const stage of ordered) {
    const anchor = anchorOf(stage);
    if (anchor) {
      (anchored[anchor] ??= []).push(emitAnchoredStage(stage, declared));
      const { domain, group: listed } = STAGE_ANCHORS[anchor];
      const group = listed ?? (domain === "scene" ? "sceneLinear" : "effects");
      writer.steps.push({ kind: "stage", group, stageId: stage.id, anchor });
      continue;
    }
    // An extension's stage at an open anchor: its own namespaced block, on
    // `lin` as the anchor has it (linear Rec.709), so no space to convert.
    const open = openAnchorOf(stage);
    if (open) {
      (anchored[open] ??= []).push(emitExtensionStage(stage, declared, undefined, layered, variant, "scene"));
      writer.steps.push({ kind: "stage", group: "sceneLinear", stageId: stage.id, anchor: open });
      continue;
    }
    const { group, domain } = phaseInfo(stage.phase);
    exits.beforeStage(stage);
    const core = writesRawNames(stage);
    // A view-only stage's input is prepared inside its switch, so nothing of it
    // reaches a frame that leaves it out.
    const viewOnly = stage.viewOnly === true;
    if (group !== "srcUv" && domain && !viewOnly) prepareInput(writer, stage, group, domain, variant);
    let block = core
      ? emitCoreStage(stage, declared)
      : emitExtensionStage(stage, declared, exits.splitOf(stage.id), layered, variant, domain);
    if (viewOnly) {
      if (group !== "srcUv" && domain) {
        const clip = !core && needsClippedInput(stage, domain, variant);
        block = writer.within(group, domain, core ? undefined : stage.space, clip, block);
      }
      block = viewOnlyBlock(block, declared);
    }
    writer.push(group, block);
    writer.steps.push({ kind: "stage", group, stageId: stage.id });
    exits.afterStage(stage);
  }
  if (exits.count > 0) declared.uniforms.push("uniform int uSplitAt;");
  const blocks = [
    ...ordered.filter((s) => anchorOf(s)).map((s) => s.glsl),
    ...ordered.filter((s) => writesRawNames(s)).map((s) => s.helpers ?? ""),
  ];
  const bound = new Set([...declared.bindings, ...declared.textureBindings].map((b) => b.glslName));
  declared.uniforms.push(...standIns(bound, blocks, variant));
  const later = laterLineReads(blocks, variant);
  declared.uniforms.push(...later.defines);
  if (declared.readsArray) {
    declared.uniforms.push(`uniform highp sampler2DArray ${RESULT_ARRAY_UNIFORM};`);
  }
  const written = writer.finish();
  const anchors = Object.entries(anchored).map(([a, blocks]) => [a, blocks.join("\n")]);

  return {
    injection: {
      uniforms: declared.uniforms.join("\n"),
      helpers: [...later.helpers, ...isvDeclarations(ordered), ...declared.helpers].join("\n\n"),
      ...written,
      splitCount: exits.count,
      ...(anchors.length > 0 ? { anchors: Object.fromEntries(anchors) } : {}),
    },
    // Signed as registered, not as this version's text, so the sig is the
    // same for every variant.
    sig: ordered.map((s) => stageKey(registered.get(s.id) ?? s)).join("|"),
    bindings: declared.bindings,
    textureBindings: declared.textureBindings,
    prepass: declared.prepass,
    maskSlots: declared.maskSlots,
    hasNoiseReduction: ordered.some(isContributedNR),
    rebuilders: ordered
      .filter(
        (s) =>
          !isCoreStage(s) &&
          s.id !== BUILTIN_DENOISE_ID &&
          !anchorOf(s) &&
          s.keepsDetail !== true &&
          phaseInfo(s.phase).group === "noiseReduction",
      )
      .map(rebuilderOf),
    steps: writer.steps,
  };
}
