// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type {
  GlslType,
  ProcessingPhase,
  ProcessingStageContribution,
  StagePass,
  StageSpace,
  TextureRequirement,
} from "@/extensions/types";
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
import { isCoreStage } from "./builtin-stage";
import {
  uniformPrefix,
  helperPrefix,
  extractHelperNames,
  emitUniformDecl,
  rewriteGlsl,
  replaceIdentifiers,
  simpleHash,
} from "./shader-compiler";
import { V1_VARIANT, type ShaderVariant, type StageInjection } from "./shaders";
import { sortStages } from "./stage-order";

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
  default: number | number[] | boolean;
}

/** A stage-declared texture, resolved to its namespaced GLSL identifier so
 *  render() can bind it each frame: a sampler for "lut"/"dynamic" data uploaded
 *  through setStageTexture, or the brush-atlas channel uniform for "coverage"
 *  dabs painted into the param bag. */
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

// ---------------------------------------------------------------------------
// Phases, stage rules and pipeline order
// ---------------------------------------------------------------------------

type InjectionGroup = "srcUv" | "noiseReduction" | "sceneLinear" | "effects";
type ColourGroup = Exclude<InjectionGroup, "srcUv">;

interface PhaseInfo {
  /** The injection group the phase's blocks join. Linear-space phases operate on
   *  `lin` (the scene-linear working color); display-space phases operate on `c`. */
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

const phaseInfo = (phase: ProcessingPhase): PhaseInfo =>
  Object.hasOwn(PHASES, phase) ? PHASES[phase] : UNLISTED_PHASE;

const colourVariable = (domain: StageDomain): "lin" | "c" => (domain === "scene" ? "lin" : "c");

// Rules about a single stage: whether it reads the current image (as it
// declares, or by the built-in denoiser's rule), whether it is a contributed
// noise-reduction stage, and whether version 2 clips its input. Each is decided
// here and nowhere else, so a rule that changes one of them has a single place
// to go. Whether a stage is a core stage is decided in builtin-stage.ts, which
// says how the built-in denoiser differs. Everything else (space, passes,
// textures, helpers) is read straight off the declaration where used.
const readsCurrent = (s: ProcessingStageContribution): boolean =>
  s.reads === "current" && (s.passes?.length ?? 0) > 0 && s.phase !== "geometry";

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
  const firstRead = converts ? toSpaceExpr(space, "scene", "toLin(s)") : "toLin(s)";
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

export interface PrepassPass {
  fragmentSource: string;
  iterations: number;
  bindings: ContributedBinding[];
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
  /** Sampler name the main shader reads stageResult from. */
  resultUniform: string;
  passes: PrepassPass[];
  split?: StageSplit;
}

/** Build a complete fragment program for one StagePass, namespacing its uniforms
 *  + helpers under the owning stage's prefix so they share the stage's param keys. */
function buildPassFragment(
  stageId: string,
  pass: StagePass,
  space: StageSpace | undefined,
): { fragmentSource: string; bindings: ContributedBinding[] } {
  const uPfx = uniformPrefix(stageId);
  const hPfx = helperPrefix(stageId);
  const uniforms = pass.uniforms ?? [];
  const bindings: ContributedBinding[] = uniforms.map((u) => ({
    qualifiedKey: `${stageId}.${u.key}`,
    glslName: uPfx + u.key,
    glslType: u.glslType,
    default: u.default,
  }));
  const uniformDecls = uniforms.map((u) => emitUniformDecl(u, uPfx)).join("\n");
  const helperNames = pass.helpers ? extractHelperNames(pass.helpers) : [];
  let helpers = "";
  if (pass.helpers) {
    let h = replaceIdentifiers(pass.helpers, helperNames, hPfx);
    h = replaceIdentifiers(h, uniforms.map((u) => u.key), uPfx);
    helpers = h;
  }
  const body = rewriteGlsl(pass.glsl, uniforms, uPfx, hPfx, helperNames);
  const fragmentSource = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
${uniformDecls}
${passSharedGlsl(space)}
${helpers}
void main() {
  vec3 c = readPrev(vUv);
  {
${body}
  }
  fragColor = vec4(c, 1.0);
}
`;
  return { fragmentSource, bindings };
}

export interface BuiltStageInjection {
  injection: StageInjection;
  /** The same for every variant: pass programs are keyed on it and don't
   *  depend on the variant, so photos of both versions share them. The
   *  renderer keys the develop program on the variant separately. */
  sig: string;
  bindings: ContributedBinding[];
  textureBindings: StageTextureBinding[];
  prepass: PrepassStage[];
  hasNoiseReduction: boolean;
}

/** Everything about a stage that the renderer derives state from, hashed.
 *  Deliberately wider than the GLSL (it takes in uniform defaults, labels and
 *  ranges, texture sizes): syncPipeline returns early on an equal signature, so
 *  a stage change reaches the bindings and prepass state only through this, and
 *  narrowing it to the shader text brings back stale defaults. */
export function stageSignature(s: ProcessingStageContribution): string {
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
    ]),
  );
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

  push(group: InjectionGroup, line: string): void {
    this.lines[group].push(line);
  }

  /** Brings the group's variable from the space it holds into `space`. */
  convert(group: ColourGroup, domain: StageDomain, space: StageSpace | undefined): void {
    const from = this.held[group];
    if (spaceKey(from, domain) === spaceKey(space, domain)) return;
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
    this.readers = ordered.filter((s) => readsCurrent(s) || keepsDecodeStages(s, ordered, variant));
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
    const input = needsClippedInput(reader, domain, this.variant) ? `clamp(${v}, 0.0, 1.0)` : v;
    const index = this.readers.indexOf(reader);
    const value = toSpaceExpr(reader.space, domain, input);
    if (!isIdentitySpace(reader.space, domain)) this.writer.markSpaceHelpers();
    const exit = `if (uSplitAt == ${index}) { fragColor = vec4(${value}, 1.0); return; }`;
    this.writer.push(group, exit);
    const cut: SplitCut = group === "noiseReduction" ? "decode" : domain;
    this.splits.set(reader.id, { index, cut, upstreamStageIds: [...this.upstream] });
  }
}

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
  const core = isCoreStage(s);
  if (!core && needsClippedInput(s, domain, variant)) {
    // Written for display values in [0, 1]: on a version 2 photo nothing
    // upstream clipped them, so this stage gets them clipped here.
    writer.convert(group, domain, undefined);
    writer.push(group, "c = clamp(c, 0.0, 1.0);");
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
}

/** The line that ends the core Vignette and Grain helpers; builtin.tsx writes it
 *  through this constant. Version 1 compiles it as written. Version 2 swaps it
 *  for `return c;`, so what these effects make reaches the stages after them with
 *  its full range. It is found as text: a helper that spells the line another
 *  way keeps its clamp. */
export const CORE_DISPLAY_CLAMP = "return clamp(c, 0.0, 1.0);";

/** Core stages (vignette/grain) keep raw uniform names: their values are bound
 *  by hand in render() from typed DevelopParams, not the param bag. Declares
 *  them as written and returns the stage's block. Under a full-information
 *  variant their helpers lose the closing clamp (CORE_DISPLAY_CLAMP). */
function emitCoreStage(
  s: ProcessingStageContribution,
  declared: Declared,
  variant: ShaderVariant,
): string {
  for (const u of s.uniforms) declared.uniforms.push(`uniform ${u.glslType} ${u.key};`);
  if (s.helpers) {
    declared.helpers.push(
      variant.fullInfo ? s.helpers.replaceAll(CORE_DISPLAY_CLAMP, "return c;") : s.helpers,
    );
  }
  return `{\n${s.glsl}\n}`;
}

/** Extension stages: namespace uniforms + helpers so two extensions never
 *  collide, and record bindings so render() can drive them from the bag.
 *  Returns the stage's block. */
function emitExtensionStage(
  s: ProcessingStageContribution,
  declared: Declared,
  split: StageSplit | undefined,
): string {
  const uPfx = uniformPrefix(s.id);
  const hPfx = helperPrefix(s.id);
  declareUniforms(s, uPfx, declared);
  declareTextures(s, uPfx, declared);
  const helperNames = declareHelpers(s, uPfx, hPfx, declared);
  const prelude = declarePrepass(s, uPfx, split, declared);
  let inline = rewriteGlsl(s.glsl, s.uniforms, uPfx, hPfx, helperNames);
  inline = replaceIdentifiers(inline, (s.textures ?? []).map((t) => t.key), uPfx);
  return `{\n${prelude}${inline}\n}`;
}

function declareUniforms(s: ProcessingStageContribution, uPfx: string, declared: Declared): void {
  for (const u of s.uniforms) {
    declared.uniforms.push(emitUniformDecl(u, uPfx));
    declared.bindings.push({
      qualifiedKey: `${s.id}.${u.key}`,
      glslName: uPfx + u.key,
      glslType: u.glslType,
      default: u.default,
    });
  }
}

/** Stage textures: LUT/dynamic kinds get a namespaced sampler bound from the
 *  uploaded data; coverage kinds ride the brush atlas (no texture unit) and
 *  are exposed to the inline glsl / helpers as a function under their `key`.
 *  The declarations are in the signature, so a change in the texture set
 *  recompiles, but a data swap or a new dab (same set) doesn't. */
function declareTextures(s: ProcessingStageContribution, uPfx: string, declared: Declared): void {
  for (const t of s.textures ?? []) {
    const glslName = uPfx + t.key;
    if (t.kind === "coverage") {
      declared.uniforms.push(`uniform int ${glslName}_ch;`);
      declared.helpers.push(coverageHelperGlsl(glslName));
    } else {
      declared.uniforms.push(`uniform sampler2D ${glslName};`);
    }
    declared.textureBindings.push({ qualifiedKey: `${s.id}.${t.key}`, glslName, kind: t.kind });
  }
}

/** Declares the stage's helpers under its prefixes and returns their original
 *  names, which the inline glsl is rewritten with. */
function declareHelpers(
  s: ProcessingStageContribution,
  uPfx: string,
  hPfx: string,
  declared: Declared,
): string[] {
  if (!s.helpers) return [];
  // Uniform + texture keys share the stage's uniform prefix; rewrite them in one
  // longest-first pass so a short key never partially matches inside a longer one.
  const uKeys = [...s.uniforms.map((u) => u.key), ...(s.textures ?? []).map((t) => t.key)];
  const helperNames = extractHelperNames(s.helpers);
  let h = replaceIdentifiers(s.helpers, helperNames, hPfx);
  h = replaceIdentifiers(h, uKeys, uPfx);
  declared.helpers.push(h);
  return helperNames;
}

/** Prepass-bearing stages: expose the prepass result to the inline glsl as
 *  `vec3 stageResult` and compile a program per pass. Pass uniforms join the
 *  same namespace so one param key can drive both the pass and the inline glsl.
 *  Returns the line that declares `stageResult` ("" for a stage without passes). */
function declarePrepass(
  s: ProcessingStageContribution,
  uPfx: string,
  split: StageSplit | undefined,
  declared: Declared,
): string {
  const stagePasses = s.passes ?? [];
  if (stagePasses.length === 0) return "";
  const resultUniform = `${uPfx}stageResult`;
  declared.uniforms.push(`uniform sampler2D ${resultUniform};`);
  const passes: PrepassPass[] = stagePasses.map((p) => {
    const built = buildPassFragment(s.id, p, s.space);
    for (const b of built.bindings) {
      if (!declared.bindings.some((x) => x.qualifiedKey === b.qualifiedKey)) {
        declared.bindings.push(b);
      }
    }
    return {
      fragmentSource: built.fragmentSource,
      iterations: Math.max(1, p.iterations ?? 1),
      bindings: built.bindings,
    };
  });
  declared.prepass.push({ stageId: s.id, resultUniform, passes, split });
  return `vec3 stageResult = texture(${resultUniform}, srcUv).rgb;\n`;
}

/** The injection, bindings and prepass programs for the stages passed in. It
 *  never consults the registry: the caller decides which stages are active.
 *  `variant` must be the one the program is assembled with: version 2 clips
 *  display values ahead of extension stages that declared no space, its core
 *  Vignette and Grain no longer clip their own output, and its built-in denoiser
 *  reads the image as the decode stages ahead of it left it. */
export function buildStageInjection(
  stages: readonly ProcessingStageContribution[],
  variant: ShaderVariant = V1_VARIANT,
): BuiltStageInjection {
  const ordered = sortStages(withoutSupersededDenoiser(stages));
  const writer = new GroupWriter();
  const exits = new SplitExits(ordered, variant, writer);
  const declared: Declared = {
    uniforms: [],
    helpers: [],
    bindings: [],
    textureBindings: [],
    prepass: [],
  };

  for (const stage of ordered) {
    const { group, domain } = phaseInfo(stage.phase);
    exits.beforeStage(stage);
    if (group !== "srcUv" && domain) prepareInput(writer, stage, group, domain, variant);
    const block = isCoreStage(stage)
      ? emitCoreStage(stage, declared, variant)
      : emitExtensionStage(stage, declared, exits.splitOf(stage.id));
    writer.push(group, block);
    exits.afterStage(stage);
  }
  if (exits.count > 0) declared.uniforms.push("uniform int uSplitAt;");
  const written = writer.finish();

  return {
    injection: {
      uniforms: declared.uniforms.join("\n"),
      helpers: declared.helpers.join("\n\n"),
      ...written,
      splitCount: exits.count,
    },
    sig: ordered.map((s) => `${s.id}:${stageSignature(s)}`).join("|"),
    bindings: declared.bindings,
    textureBindings: declared.textureBindings,
    prepass: declared.prepass,
    hasNoiseReduction: ordered.some(isContributedNR),
  };
}
