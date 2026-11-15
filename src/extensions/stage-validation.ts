// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { BUILTIN_DENOISE_ID } from "@/rendering/webgl/builtin-denoise";
import { isBuiltInStage, writesRawNames } from "@/rendering/webgl/builtin-stage";
import { OPEN_ANCHORS, STAGE_ANCHORS, isStageAnchor } from "@/rendering/webgl/stage-anchors";
import { CORE_EXTENSION_ID } from "./core-extension";
import { isUniformValue } from "./pipeline-validation";
import {
  MASKABLE_PHASES,
  PROCESSING_PHASE_ORDER,
  type InterStageVariable,
  type ProcessingPhase,
  type ProcessingStageContribution,
  type StagePass,
  type StageSpace,
  type TextureRequirement,
  type UniformDeclaration,
} from "./types";

interface StageContractCheck {
  /** Why the stage can't be registered, or null. */
  error: string | null;
  /** Why `reads: "current"` will be ignored, or null. */
  readsIgnored: string | null;
  /** Non-fatal notes for the author: parts of the contract the core will ignore. */
  warnings: string[];
}

// Compiler-checked tables for allowed values, so "toString" etc. never count as members.
const ENCODINGS: Record<StageSpace["encoding"], true> = { linear: true, perceptual: true };
const PRIMARIES: Record<NonNullable<StageSpace["primaries"]>, true> = { rec709: true, rec2020: true };
const READS: Record<NonNullable<ProcessingStageContribution["reads"]>, true> = { source: true, current: true };

const ISV_TYPES: Record<InterStageVariable["glslType"], true> = { float: true, vec2: true, vec3: true, vec4: true };
// No double underscore: GLSL ES reserves identifiers that contain one.
const ISV_NAME = /^[A-Za-z](?:[A-Za-z0-9]|_(?!_))*$/;

/** The most draws a bag-driven pass may take in one frame. */
export const MAX_PASS_DRAWS = 1024;

/** What a message quotes for a value no formatting path can print. */
const UNPRINTABLE = "[unprintable]";

/** `String(v)`, or the object's tag when it has no toString to call (an object made
 *  with Object.create(null) has none, and String() throws on it), or UNPRINTABLE when
 *  it refuses its tag too (a revoked or throwing Proxy, a throwing Symbol.toStringTag
 *  getter). Never throws: the messages quote untyped values from plain JavaScript. */
function describeValue(v: unknown): string {
  try {
    return String(v);
  } catch {
    try {
      return Object.prototype.toString.call(v);
    } catch {
      return UNPRINTABLE;
    }
  }
}

/** Safely format a value for error messages, handling JSON.stringify failures. */
function formatValue(v: unknown): string {
  // JSON.stringify throws on BigInt and circular values; this check takes arbitrary plain-JS input.
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return describeValue(v);
  }
}

/** Why `produces` or `consumes` can't be honoured, or null. */
function interStageError(c: ProcessingStageContribution): string | null {
  const produces: unknown = c.produces;
  if (produces !== undefined) {
    if (!Array.isArray(produces)) return "produces must be an array";
    const names = new Set<string>();
    for (const entry of produces as unknown[]) {
      if (typeof entry !== "object" || entry === null) return "each produces entry must be an object";
      const { name, glslType, producer } = entry as Record<string, unknown>;
      if (typeof name !== "string" || !ISV_NAME.test(name)) {
        return `produces name must be letters, digits and underscores starting with a letter, without "__", got ${formatValue(name)}`;
      }
      if (typeof glslType !== "string" || !Object.hasOwn(ISV_TYPES, glslType)) {
        return `produces "${name}" glslType must be "float", "vec2", "vec3" or "vec4", got ${formatValue(glslType)}`;
      }
      if (producer !== undefined && (typeof producer !== "string" || producer.trim() === "")) {
        return `produces "${name}" producer must be a non-empty GLSL expression`;
      }
      if (names.has(name)) return `produces "${name}" twice`;
      names.add(name);
    }
  }
  const consumes: unknown = c.consumes;
  if (consumes !== undefined) {
    if (!Array.isArray(consumes)) return "consumes must be an array of variable names";
    for (const name of consumes as unknown[]) {
      if (typeof name !== "string" || !ISV_NAME.test(name)) {
        return `consumes must hold variable names (letters, digits and underscores starting with a letter, without "__"), got ${formatValue(name)}`;
      }
    }
  }
  return null;
}

const GLSL_COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const ISV_REFERENCE = /\bisv_([A-Za-z0-9_]+)/g;

/** The names `source` reads as `isv_<name>`, outside its comments. Whichever
 *  comment opener comes first wins, so `/*` inside a line comment opens nothing. */
function isvReads(source: unknown): string[] {
  if (typeof source !== "string") return [];
  return [...source.replace(GLSL_COMMENT, " ").matchAll(ISV_REFERENCE)].map((m) => m[1]);
}

/** The stage's passes that are objects, with their index; plain JavaScript may hand over anything else. */
function* eachPass(c: ProcessingStageContribution): Generator<[number, Record<string, unknown>]> {
  const passes: unknown = c.passes;
  if (!Array.isArray(passes)) return;
  for (const [index, pass] of (passes as unknown[]).entries()) {
    if (typeof pass !== "object" || pass === null) continue;
    yield [index, pass as Record<string, unknown>];
  }
}

/** Why the stage reads an inter-stage variable it doesn't list, or a pass reads
 *  one at all, or null. A read the stage doesn't list works while another stage
 *  produces the variable and fails the whole develop program once that stage
 *  goes, because only `consumes` tells the injection who needs a producer.
 *  Runs after interStageError, so `produces` and `consumes` are well formed. */
function isvReferenceError(c: ProcessingStageContribution): string | null {
  const produces = c.produces ?? [];
  const listed = new Set([...produces.map((v) => v.name), ...(c.consumes ?? [])]);
  const inline: [string, unknown][] = [
    ["glsl", c.glsl],
    ["helpers", c.helpers],
    ...produces.map((v): [string, unknown] => [`produces "${v.name}" producer`, v.producer]),
  ];
  for (const [where, source] of inline) {
    const name = isvReads(source).find((n) => !listed.has(n));
    if (name !== undefined) return `${where} reads isv_${name} but neither produces nor consumes "${name}"`;
  }
  for (const [index, pass] of eachPass(c)) {
    const { glsl, helpers } = pass;
    const [name] = [...isvReads(glsl), ...isvReads(helpers)];
    if (name !== undefined) return `passes[${index}] reads isv_${name}; inter-stage variables are not visible to passes`;
  }
  return null;
}

/** Why a pass's bag-driven draw count can't be honoured, or null. */
function passCountError(c: ProcessingStageContribution): string | null {
  const stageUniforms: unknown = c.uniforms;
  const inline = Array.isArray(stageUniforms) ? (stageUniforms as UniformDeclaration[]) : [];
  for (const [index, pass] of eachPass(c)) {
    const { iterations, uniforms } = pass;
    if (iterations === undefined || typeof iterations === "number") continue;
    const at = `passes[${index}].iterations`;
    if (typeof iterations !== "object" || iterations === null) return `${at} must be a number or { key, max }`;
    const { key, max } = iterations as Record<string, unknown>;
    if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > MAX_PASS_DRAWS) {
      return `${at}.max must be an integer from 1 to ${MAX_PASS_DRAWS}, got ${formatValue(max)}`;
    }
    const own = Array.isArray(uniforms) ? (uniforms as UniformDeclaration[]) : [];
    const declared = [...inline, ...own].find((u) => u.key === key);
    if (typeof key !== "string" || !declared) {
      return `${at}.key must name a uniform the stage declares, got ${formatValue(key)}`;
    }
    if (declared.glslType !== "int" && declared.glslType !== "float") {
      return `${at}.key "${key}" must name an int or float uniform`;
    }
  }
  return null;
}

/** Why a pass's `channels` can't be built, or null. */
function passChannelsError(c: ProcessingStageContribution): string | null {
  for (const [index, pass] of eachPass(c)) {
    const { channels } = pass;
    if (channels !== undefined && channels !== 3 && channels !== 4) return `passes[${index}].channels must be 3 or 4, got ${formatValue(channels)}`;
  }
  return null;
}

/** Why a pass's `region` can't be built, or null. */
function passRegionError(c: ProcessingStageContribution): string | null {
  for (const [index, pass] of eachPass(c)) {
    const { region } = pass;
    if (region !== undefined && (typeof region !== "string" || region.trim() === ""))
      return `passes[${index}].region must be GLSL text, got ${formatValue(region)}`;
  }
  return null;
}

/** Why a pass's `keep` can't be built, or null. */
function passKeepError(c: ProcessingStageContribution): string | null {
  for (const [index, pass] of eachPass(c)) {
    const { keep } = pass;
    if (keep !== undefined && typeof keep !== "boolean") return `passes[${index}].keep must be true or false, got ${formatValue(keep)}`;
  }
  return null;
}

/** Notes on the fixed draw counts the renderer clamps to 1…MAX_PASS_DRAWS (a
 *  count that isn't finite becomes 1). They stay registrable: refusing them
 *  would stop an extension written before the bound from loading. */
function fixedCountWarnings(c: ProcessingStageContribution, stagePrefix: string): string[] {
  const warnings: string[] = [];
  for (const [index, pass] of eachPass(c)) {
    const { iterations } = pass;
    if (typeof iterations !== "number") continue;
    if (Number.isFinite(iterations) && iterations >= 1 && iterations <= MAX_PASS_DRAWS) continue;
    warnings.push(
      `${stagePrefix}: passes[${index}].iterations ${iterations} is out of range; it is clamped to 1…${MAX_PASS_DRAWS}`,
    );
  }
  return warnings;
}

const FRAGMENT_ONLY = ["gl_FragCoord", "discard", "dFdx", "dFdy", "fwidth"];
const CONST_ARRAY = /\bconst\s+(?:\w+\s+)*\w+\s*\[/;

function withoutComments(source: unknown): string {
  return typeof source === "string" ? source.replace(GLSL_COMMENT, " ") : "";
}

/** A region pass's helpers and region also compile into the vertex program that
 *  places the region, where the fragment-only built-ins don't exist. The stage
 *  stays registrable; the build is what fails. */
function regionBuiltinWarnings(c: ProcessingStageContribution, stagePrefix: string): string[] {
  const warnings: string[] = [];
  for (const [index, pass] of eachPass(c)) {
    const { region, helpers } = pass;
    if (typeof region !== "string") continue;
    const text = `${withoutComments(helpers)}\n${withoutComments(region)}`;
    const found = FRAGMENT_ONLY.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
    if (found.length === 0) continue;
    warnings.push(
      `${stagePrefix}: passes[${index}] uses ${found.join(", ")} in its helpers or region, which also compile ` +
        `into the vertex program that places the region, where that built-in doesn't exist, so the stage will fail to build`,
    );
  }
  return warnings;
}

/** Direct3D 11 copies a constant array into every pixel's scratch memory on
 *  every draw. */
function constArrayWarnings(c: ProcessingStageContribution, stagePrefix: string): string[] {
  const texts: [string, unknown][] = [
    ["glsl", c.glsl],
    ["helpers", c.helpers],
  ];
  for (const [index, pass] of eachPass(c)) {
    const { glsl, helpers, region } = pass;
    texts.push([`passes[${index}].glsl`, glsl], [`passes[${index}].helpers`, helpers], [`passes[${index}].region`, region]);
  }
  return texts
    .filter(([, source]) => CONST_ARRAY.test(withoutComments(source)))
    .map(
      ([where]) =>
        `${stagePrefix}: ${where} declares a constant array, which Direct3D 11 copies into every pixel's scratch memory on every draw; compute the values in the shader or pass them as a uniform array`,
    );
}

const UNARRAYABLE: ReadonlySet<string> = new Set(["mat3", "mat4", "sampler2D"]);
const MAX_UNIFORM_LENGTH = 64;
/** An official stage's arrays may run longer (Masking's HSL bands, 96 vec4s). */
const MAX_OFFICIAL_UNIFORM_LENGTH = 256;

/** An array uniform the program can't declare: one of a matrix or sampler, or a
 *  length that isn't a whole number from 1 to MAX_UNIFORM_LENGTH. */
function uniformShapeError(c: ProcessingStageContribution, extensionId?: string): string | null {
  const uniforms: unknown = c.uniforms;
  if (!Array.isArray(uniforms)) return null;
  for (const u of uniforms as UniformDeclaration[]) {
    const length: unknown = u?.length;
    if (length === undefined) continue;
    if (UNARRAYABLE.has(u.glslType)) return `uniform "${u.key}" is a ${u.glslType}, which can't be an array`;
    const official = typeof c.id === "string" && writesRawNames({ id: c.id, extensionId });
    const max = official ? MAX_OFFICIAL_UNIFORM_LENGTH : MAX_UNIFORM_LENGTH;
    if (typeof length !== "number" || !Number.isInteger(length) || length < 1 || length > max) {
      return `uniform "${u.key}" has length ${formatValue(length)}, which must be a whole number from 1 to ${max}`;
    }
  }
  return null;
}

/** A photo texture nothing would fill: only a stage of Safelight's own or an
 *  official extension's has a derive that runs. */
function photoTextureError(c: ProcessingStageContribution, extensionId?: string): string | null {
  const textures: unknown = c.textures;
  if (!Array.isArray(textures)) return null;
  const fills = typeof c.derive === "function" && writesRawNames({ id: c.id, extensionId });
  const photo = (textures as TextureRequirement[]).find((t) => t?.kind === "photo" || t?.kind === "atlas");
  if (!photo || fills) return null;
  return `texture "${photo.key}" is a ${photo.kind} texture, which only a stage of Safelight's own fills (derive)`;
}

/** More than one paint texture on a stage: its layers already share one. */
function paintTextureError(c: ProcessingStageContribution): string | null {
  const textures: unknown = c.textures;
  if (!Array.isArray(textures)) return null;
  const paint = (textures as TextureRequirement[]).filter((t) => t?.kind === "paint");
  if (paint.length < 2) return null;
  return `declares ${paint.length} paint textures; a stage has at most one paint texture, whose layers hold every stroke`;
}

/** The uniforms a stage declares, inline and in its passes, as plain JS hands them over. */
export function declaredUniforms(c: ProcessingStageContribution): UniformDeclaration[] {
  const inline: unknown = c.uniforms;
  const passes: unknown = c.passes;
  const own = Array.isArray(inline) ? (inline as UniformDeclaration[]) : [];
  const passUniforms = Array.isArray(passes)
    ? (passes as unknown[]).flatMap((p) => {
        const uniforms: unknown = typeof p === "object" && p !== null ? (p as StagePass).uniforms : undefined;
        return Array.isArray(uniforms) ? (uniforms as UniformDeclaration[]) : [];
      })
    : [];
  return [...own, ...passUniforms].filter((u) => typeof u === "object" && u !== null);
}

/** Why `dormantWhen` can't be read, or null. */
function dormantWhenError(c: ProcessingStageContribution): string | null {
  const rule: unknown = c.dormantWhen;
  if (rule === undefined) return null;
  if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
    return "dormantWhen must be an object of uniform keys and values";
  }
  const entries = Object.entries(rule);
  if (entries.length === 0) return "dormantWhen must name at least one uniform";
  const uniforms = declaredUniforms(c);
  for (const [key, value] of entries) {
    const u = uniforms.find((d) => d.key === key);
    if (!u) return `dormantWhen names "${key}", which isn't a uniform the stage declares`;
    if (u.length !== undefined) return `dormantWhen names "${key}", an array uniform`;
    if (!isUniformValue(value, u.glslType)) {
      return `dormantWhen "${key}": ${formatValue(value)} doesn't fit ${describeValue(u.glslType)}`;
    }
  }
  return null;
}

const DISPLAY_PHASES: readonly ProcessingPhase[] = ["display-adjust", "effects", "output-encode"];

/** Why the renderer can't leave the stage out while `dormantWhen` holds,
 *  because the frame would change without it all the same, or null when it
 *  can. The renderer reads its rule only when this is null. `extensionId`: who
 *  registered it; a stage that writes raw names (core's, an official
 *  extension's) never has its input clipped, so its absence clips nothing. */
export function dormancyIgnored(
  c: ProcessingStageContribution & { extensionId?: unknown },
  extensionId: unknown = c.extensionId,
): string | null {
  if (c.phase === "geometry" || c.geometry !== undefined) {
    return "geometry stages decide where every pixel is read from";
  }
  if (c.phase === "noise-reduction") {
    return "noise-reduction stages decide whether the built-in denoiser runs";
  }
  if (DISPLAY_PHASES.includes(c.phase) && !c.space && !writesRawNames({ id: c.id, extensionId })) {
    return "a display stage without space has its input clipped on version 2 photos";
  }
  if ((c.produces?.length ?? 0) > 0) return "stages after it read what it produces";
  if (c.patch !== undefined) return "a stage that patches the source decides what every pass reads";
  return null;
}

/** Runtime check of the stage's contract, and of who may register it: ids under
 *  "core." and the built-in denoiser's belong to the core extension, so any other
 *  `extensionId` is refused them. Without one, the stage is checked as an
 *  extension's. */
export function checkStageContract(
  c: ProcessingStageContribution,
  extensionId?: string,
): StageContractCheck {
  const stagePrefix = `stage "${describeValue(c.id)}"`;
  const fail = (why: string): StageContractCheck => ({
    error: `${stagePrefix}: ${why}`,
    readsIgnored: null,
    warnings: [],
  });
  // Plain JavaScript can pass any id; one that isn't text can't be a reserved one.
  if (typeof c.id === "string" && isBuiltInStage(c) && extensionId !== CORE_EXTENSION_ID) {
    return fail(
      `ids under "core." and "${BUILTIN_DENOISE_ID}" are reserved for Safelight's own stages`,
    );
  }
  // Mask copies are named "{stageId}@{n}" (mask-stage-instances.ts), and their
  // GLSL names follow: a stage named so would share a copy's.
  const copySuffix = typeof c.id === "string" ? /@(\d+)$/.exec(c.id) : null;
  if (copySuffix) {
    return fail(`the id ends in "@${copySuffix[1]}", which mask copies of stages are named with`);
  }
  const warnings: string[] = [];

  if (c.anchor !== undefined) {
    if (!isStageAnchor(c.anchor)) {
      return fail(
        `anchor ${formatValue(c.anchor)} is not one of ${Object.keys(STAGE_ANCHORS).join(", ")}`,
      );
    }
    const own = writesRawNames({ id: c.id, extensionId });
    if (!own && OPEN_ANCHORS.has(c.anchor)) {
      if (c.phase !== "scene-linear") return fail("a stage at the tone anchor must be in the scene-linear phase");
      const refused: [string, boolean][] = [
        ["passes", (c.passes?.length ?? 0) > 0],
        ["a space", c.space !== undefined],
        ["a mask", c.mask !== undefined],
        ["reads", c.reads !== undefined],
        ["produces", (c.produces?.length ?? 0) > 0],
      ];
      const what = refused.find(([, declared]) => declared)?.[0];
      if (what) return fail(`a stage at the tone anchor can't declare ${what}`);
    } else if (!own) {
      warnings.push(`${stagePrefix}: anchor is for Safelight's own stages, so it is ignored`);
    }
  }
  if (c.derive !== undefined && !writesRawNames({ id: c.id, extensionId })) {
    warnings.push(`${stagePrefix}: derive is for Safelight's own stages, so it is ignored`);
  }

  // Extensions are plain JavaScript, so these fields arrive untyped.
  const space: unknown = c.space;
  if (space !== undefined) {
    if (typeof space !== "object" || space === null) return fail("space must be an object");
    const spaceObj = space as Record<string, unknown>;
    const { encoding, primaries } = spaceObj;
    if (typeof encoding !== "string" || !Object.hasOwn(ENCODINGS, encoding))
      return fail(`space.encoding must be "linear" or "perceptual", got ${formatValue(encoding)}`);
    if (primaries !== undefined && (typeof primaries !== "string" || !Object.hasOwn(PRIMARIES, primaries)))
      return fail(`space.primaries must be "rec709" or "rec2020", got ${formatValue(primaries)}`);
    for (const key of Object.keys(spaceObj)) {
      if (key !== "encoding" && key !== "primaries") {
        warnings.push(`${stagePrefix}: unknown key "space.${key}" will be ignored`);
      }
    }
    if (c.phase === "geometry") {
      warnings.push(`${stagePrefix}: geometry stages run before the image is sampled, so space is ignored`);
    }
  }
  const shape = uniformShapeError(c, extensionId) ?? photoTextureError(c, extensionId) ?? paintTextureError(c);
  if (shape) return fail(shape);
  const reads: unknown = c.reads;
  if (reads !== undefined && (typeof reads !== "string" || !Object.hasOwn(READS, reads)))
    return fail(`reads must be "source" or "current", got ${formatValue(reads)}`);
  const readsCurrentFrom: unknown = c.readsCurrentFrom;
  if (readsCurrentFrom !== undefined) {
    if (typeof readsCurrentFrom !== "number" || !Number.isInteger(readsCurrentFrom) || readsCurrentFrom < 1)
      return fail(`readsCurrentFrom must be a whole process version from 1, got ${formatValue(readsCurrentFrom)}`);
    if (reads !== "current")
      warnings.push(`${stagePrefix}: readsCurrentFrom only applies with reads "current", so it is ignored`);
  }
  const contractError =
    interStageError(c) ??
    isvReferenceError(c) ??
    passCountError(c) ??
    passChannelsError(c) ??
    passRegionError(c) ??
    passKeepError(c);
  if (contractError) return fail(contractError);
  warnings.push(...fixedCountWarnings(c, stagePrefix));
  warnings.push(...regionBuiltinWarnings(c, stagePrefix), ...constArrayWarnings(c, stagePrefix));

  let readsIgnored: string | null = null;
  if (reads === "current") {
    if (c.phase === "geometry")
      readsIgnored = `${stagePrefix}: geometry stages run before the image is sampled, so reads "current" is ignored`;
    else if (!c.passes || c.passes.length === 0)
      readsIgnored = `${stagePrefix}: reads "current" only feeds passes and this stage has none, so it is ignored`;
  }

  const viewOnly: unknown = c.viewOnly;
  if (viewOnly !== undefined) {
    if (typeof viewOnly !== "boolean") return fail(`viewOnly must be true or false, got ${formatValue(viewOnly)}`);
    if (viewOnly && c.phase === "geometry")
      return fail("geometry stages move what every frame samples, so they can't be viewOnly");
    if (viewOnly && (c.produces?.length ?? 0) > 0)
      return fail("a viewOnly stage can't produce values: exports would hand other stages different ones");
    if (viewOnly && c.mask !== undefined) return fail("a viewOnly stage can't run inside masks");
    if (viewOnly && c.phase === "noise-reduction")
      return fail("a noise-reduction stage replaces the built-in denoiser in exports too, so it can't be viewOnly");
    if (viewOnly && c.anchor !== undefined) return fail("an anchored stage can't be viewOnly");
    if (viewOnly && c.reads === "current")
      return fail('a viewOnly stage can\'t set reads: "current": the point it reads at is written into exports too');
  }

  const keepsDetail: unknown = c.keepsDetail;
  if (keepsDetail !== undefined && typeof keepsDetail !== "boolean")
    return fail(`keepsDetail must be true or false, got ${formatValue(keepsDetail)}`);

  const mask: unknown = c.mask;
  if (mask !== undefined) {
    if (typeof mask !== "object" || mask === null || (mask as { maskable?: unknown }).maskable !== true) {
      warnings.push(`${stagePrefix}: mask must be { maskable: true }, so it is ignored`);
    } else if (!MASKABLE_PHASES.includes(c.phase)) {
      warnings.push(
        `${stagePrefix}: ${describeValue(c.phase)} stages run before mask coverage is known, so mask is ignored`,
      );
    }
  }
  const dormant = dormantWhenError(c);
  if (dormant) return fail(dormant);
  const dormancy = c.dormantWhen === undefined ? null : dormancyIgnored(c, extensionId);
  if (dormancy) warnings.push(`${stagePrefix}: ${dormancy}, so dormantWhen is ignored`);
  // The ordering reads `after` as a list of ids; whatever else is there is skipped.
  const after: unknown = c.after;
  if (after !== undefined && !Array.isArray(after)) {
    warnings.push(`${stagePrefix}: after must be an array of stage ids, so it is ignored`);
  } else if (Array.isArray(after) && after.some((id: unknown) => typeof id !== "string")) {
    warnings.push(
      `${stagePrefix}: after must hold stage ids (strings) only, so the other entries are ignored`,
    );
  }
  const phase: unknown = c.phase;
  if (!PROCESSING_PHASE_ORDER.some((p) => p === phase)) {
    const listed = PROCESSING_PHASE_ORDER.join(", ");
    warnings.push(
      `${stagePrefix}: phase ${formatValue(phase)} is not one of ${listed}, ` +
        `so the stage is placed after all of them`,
    );
  }

  return { error: null, readsIgnored, warnings };
}
