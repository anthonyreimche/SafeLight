import type {
  ProcessingStageContribution,
  ProcessingPhase,
  UniformDeclaration,
  InterStageVariable,
  GlslType,
} from "@/extensions/types";
import { PROCESSING_PHASE_ORDER } from "@/extensions/types";
import { useRegistry } from "@/extensions/registry";
import { VERTEX_SHADER, buildFragmentShader as legacyBuildFragmentShader } from "./shaders";

// ---------------------------------------------------------------------------
// Deterministic prefix for GLSL names contributed by each stage
// ---------------------------------------------------------------------------

function hashStageId(stageId: string): string {
  let h = 0;
  for (let i = 0; i < stageId.length; i++)
    h = ((h << 5) - h + stageId.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).slice(0, 4);
}

export function uniformPrefix(stageId: string): string {
  return `u_${hashStageId(stageId)}_`;
}

export function helperPrefix(stageId: string): string {
  return `_${hashStageId(stageId)}_`;
}

// ---------------------------------------------------------------------------
// Stage sorting
// ---------------------------------------------------------------------------

const phaseIndex = new Map<ProcessingPhase, number>(
  PROCESSING_PHASE_ORDER.map((p, i) => [p, i]),
);

function stageOrder(
  a: ProcessingStageContribution,
  b: ProcessingStageContribution,
): number {
  const pi = (phaseIndex.get(a.phase) ?? 99) - (phaseIndex.get(b.phase) ?? 99);
  if (pi !== 0) return pi;
  return (a.priority ?? 100) - (b.priority ?? 100);
}

// ---------------------------------------------------------------------------
// GLSL rewriting: prefix uniform and helper references in stage code
// ---------------------------------------------------------------------------

export function rewriteGlsl(
  glsl: string,
  uniforms: UniformDeclaration[],
  uPrefix: string,
  hPrefix: string,
  helperNames: string[],
): string {
  let out = glsl;
  for (const u of uniforms) {
    out = out.replaceAll(u.key, uPrefix + u.key);
  }
  for (const name of helperNames) {
    out = out.replaceAll(name, hPrefix + name);
  }
  return out;
}

export function extractHelperNames(helpers: string): string[] {
  const names: string[] = [];
  const re = /\b(?:float|vec[234]|mat[34]|int|bool|void)\s+([a-zA-Z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(helpers)) !== null) {
    names[names.length] = m[1];
  }
  return names;
}

// ---------------------------------------------------------------------------
// Uniform declaration emission
// ---------------------------------------------------------------------------

export function emitUniformDecl(u: UniformDeclaration, prefix: string): string {
  const name = prefix + u.key;
  if (u.glslType === "sampler2D") return `uniform sampler2D ${name};`;
  return `uniform ${u.glslType} ${name};`;
}

// ---------------------------------------------------------------------------
// Inter-stage variable emission
// ---------------------------------------------------------------------------

function emitIsvDecl(v: InterStageVariable): string {
  return `${v.glslType} isv_${v.name} = ${defaultForType(v.glslType)};`;
}

function defaultForType(t: string): string {
  if (t === "float") return "0.0";
  if (t === "vec2") return "vec2(0.0)";
  if (t === "vec3") return "vec3(0.0)";
  if (t === "vec4") return "vec4(0.0)";
  return "0.0";
}

// ---------------------------------------------------------------------------
// Compiler signature (for program caching)
// ---------------------------------------------------------------------------

export function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++)
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function compilerSignature(
  stages: ProcessingStageContribution[],
): string {
  return stages.map((s) => `${s.id}:${simpleHash(s.glsl)}`).join("|");
}

// ---------------------------------------------------------------------------
// Compiled result
// ---------------------------------------------------------------------------

export interface CompiledShaderSource {
  vertexSource: string;
  fragmentSource: string;
  signature: string;
  /** Mapping from qualified param key to the actual GLSL uniform name. */
  uniformNameMap: Map<string, string>;
  /** Mapping from GLSL uniform name to the GlslType. */
  uniformTypes: Map<string, GlslType>;
  /** Mapping from qualified param key to default value. */
  defaults: Map<string, number | number[] | boolean>;
  /** Ordered list of stages compiled into this shader. */
  stageIds: string[];
}

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

export function compileShaderSource(
  stages: ProcessingStageContribution[],
): CompiledShaderSource {
  const sorted = [...stages].sort(stageOrder);

  const uniformNameMap = new Map<string, string>();
  const uniformTypes = new Map<string, GlslType>();
  const defaults = new Map<string, number | number[] | boolean>();

  // Collect all inter-stage variables (producers first, then consumers validated)
  const isvProducers = new Map<string, InterStageVariable>();
  for (const s of sorted) {
    for (const v of s.produces ?? []) {
      isvProducers.set(v.name, v);
    }
  }

  // Build uniform declarations
  const uniformDecls: string[] = [];
  for (const s of sorted) {
    const uPfx = uniformPrefix(s.id);
    for (const u of s.uniforms) {
      const qk = `${s.id}.${u.key}`;
      const glslName = uPfx + u.key;
      uniformNameMap.set(qk, glslName);
      uniformTypes.set(glslName, u.glslType);
      defaults.set(qk, u.default);
      uniformDecls.push(emitUniformDecl(u, uPfx));
    }
  }

  // Build helper functions (namespaced)
  const helperBlocks: string[] = [];
  const stageHelperNames = new Map<string, string[]>();
  for (const s of sorted) {
    if (!s.helpers) {
      stageHelperNames.set(s.id, []);
      continue;
    }
    const names = extractHelperNames(s.helpers);
    stageHelperNames.set(s.id, names);
    const hPfx = helperPrefix(s.id);
    let rewritten = s.helpers;
    for (const n of names) {
      rewritten = rewritten.replaceAll(n, hPfx + n);
    }
    // Also rewrite uniform references inside helpers
    const uPfx = uniformPrefix(s.id);
    for (const u of s.uniforms) {
      rewritten = rewritten.replaceAll(u.key, uPfx + u.key);
    }
    helperBlocks.push(`// helpers: ${s.id}\n${rewritten}`);
  }

  // Build inter-stage variable declarations
  const isvDecls: string[] = [];
  for (const v of isvProducers.values()) {
    isvDecls.push(emitIsvDecl(v));
  }

  // Build stage blocks for main()
  const stageBlocks: string[] = [];
  for (const s of sorted) {
    const uPfx = uniformPrefix(s.id);
    const hPfx = helperPrefix(s.id);
    const hNames = stageHelperNames.get(s.id) ?? [];

    let body = rewriteGlsl(s.glsl, s.uniforms, uPfx, hPfx, hNames);

    // Rewrite inter-stage variable references (both produced and consumed)
    for (const vName of s.consumes ?? []) {
      body = body.replaceAll(vName, `isv_${vName}`);
    }
    for (const v of s.produces ?? []) {
      body = body.replaceAll(v.name, `isv_${v.name}`);
    }

    let block = `// -- ${s.id} (${s.phase}, priority ${s.priority ?? 100}) --\n{\n${body}\n}`;

    // Append inter-stage variable producer expressions
    for (const v of s.produces ?? []) {
      if (v.producer) {
        let expr = v.producer;
        for (const u of s.uniforms) {
          expr = expr.replaceAll(u.key, uPfx + u.key);
        }
        block += `\nisv_${v.name} = ${expr};`;
      }
    }

    stageBlocks.push(block);
  }

  // For now, emit a minimal composable shader skeleton. The actual monolithic
  // shader is still used via the legacy path — this compiler will be activated
  // stage-by-stage as blocks are extracted from the monolith.
  //
  // The fragment source is a placeholder that will grow as stages are migrated.
  // Until all stages are extracted, the renderer continues to use
  // legacyBuildFragmentShader() for the full pipeline.

  const fragmentSource = buildComposedFragment(
    uniformDecls,
    helperBlocks,
    isvDecls,
    stageBlocks,
  );

  return {
    vertexSource: VERTEX_SHADER,
    fragmentSource,
    signature: compilerSignature(sorted),
    uniformNameMap,
    uniformTypes,
    defaults,
    stageIds: sorted.map((s) => s.id),
  };
}

// ---------------------------------------------------------------------------
// Fragment shader assembly
// ---------------------------------------------------------------------------

function buildComposedFragment(
  uniformDecls: string[],
  helperBlocks: string[],
  isvDecls: string[],
  stageBlocks: string[],
): string {
  // This is a minimal composed shader for stages that have been extracted.
  // The full monolithic shader is still used until all stages are migrated.
  // This function assembles only the extracted stages into a valid GLSL program.
  return `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uImage;
uniform vec4 uCrop;
uniform mat3 uInvTransform;
uniform bool uLinear;
uniform int uOutSpace;
uniform mat3 uOutMatrix;
uniform bool uRawHistogram;
uniform int uShowClipping;

${uniformDecls.join("\n")}

// Shared utilities
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

${helperBlocks.join("\n\n")}

void main() {
  vec2 srcUv = vUv;
  vec3 color = texture(uImage, srcUv).rgb;
  if (!uLinear) color = srgbToLinear(color);

  // Inter-stage variables
  ${isvDecls.join("\n  ")}

  // Processing stages
  ${stageBlocks.join("\n  ")}

  if (uRawHistogram) {
    fragColor = vec4(color, 1.0);
  } else if (uShowClipping > 0) {
    vec3 display = clamp(color, 0.0, 1.0);
    bool shadow = (uShowClipping & 1) != 0 && color.r <= 0.0 && color.g <= 0.0 && color.b <= 0.0;
    bool highlight = (uShowClipping & 2) != 0 && (color.r >= 1.0 || color.g >= 1.0 || color.b >= 1.0);
    fragColor = shadow ? vec4(0.2, 0.3, 1.0, 1.0)
               : highlight ? vec4(1.0, 0.2, 0.2, 1.0)
               : vec4(display, 1.0);
  } else {
    fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  }
}
`;
}

// ---------------------------------------------------------------------------
// Legacy bridge: get sorted active stages from registry
// ---------------------------------------------------------------------------

export function getActiveStages(): ProcessingStageContribution[] {
  const stages = useRegistry.getState().processingStages;
  return Object.values(stages).sort(stageOrder);
}

// ---------------------------------------------------------------------------
// Re-export legacy builder for the monolithic shader (used until migration)
// ---------------------------------------------------------------------------

export { legacyBuildFragmentShader, VERTEX_SHADER };
