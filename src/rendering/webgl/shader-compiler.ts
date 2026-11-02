// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { UniformDeclaration } from "@/extensions/types";

// ---------------------------------------------------------------------------
// Deterministic prefix for GLSL names contributed by each stage
// ---------------------------------------------------------------------------

function hashStageId(stageId: string): string {
  let h = 0;
  for (let i = 0; i < stageId.length; i++)
    h = ((h << 5) - h + stageId.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).slice(0, 4);
}

// A mask copy's id ("{stageId}@{n}", mask-stage-instances.ts) is namespaced
// under its stage's hash with the copy number after it: the hash keeps the id's
// high digits, which a number at its end leaves alone, so the copies' own
// hashes collide. A key, a GLSL identifier, can't start with the digit that
// follows, so no name of the stage's can match a copy's.
function namespaceOf(stageId: string): string {
  const copy = /^(.*)@(\d+)$/.exec(stageId);
  return copy ? `${hashStageId(copy[1])}_${copy[2]}m` : hashStageId(stageId);
}

export function uniformPrefix(stageId: string): string {
  return `u_${namespaceOf(stageId)}_`;
}

export function helperPrefix(stageId: string): string {
  return `_${namespaceOf(stageId)}_`;
}

// ---------------------------------------------------------------------------
// GLSL rewriting: prefix uniform and helper references in stage code
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Prefix each `name` with `prefix` at identifier boundaries only. A raw substring
// replace corrupts GLSL when one key is a substring of another identifier (e.g. a
// key "amount" rewriting inside "amountScale", or one key being a prefix of a
// second key). Anchoring with \b confines edits to whole identifiers, and
// processing longest-first stops a short key from partially matching inside a
// longer one before it is rewritten.
export function replaceIdentifiers(
  src: string,
  names: readonly string[],
  prefix: string,
): string {
  let out = src;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, "g"), prefix + name);
  }
  return out;
}

/** Whether `src` names any of `names` as a whole identifier. */
export function mentionsIdentifier(src: string, names: readonly string[]): boolean {
  return names.some((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(src));
}

export function rewriteGlsl(
  glsl: string,
  uniforms: UniformDeclaration[],
  uPrefix: string,
  hPrefix: string,
  helperNames: string[],
): string {
  let out = glsl;
  out = replaceIdentifiers(out, uniforms.map((u) => u.key), uPrefix);
  out = replaceIdentifiers(out, helperNames, hPrefix);
  return out;
}

export function extractHelperNames(helpers: string): string[] {
  const names: string[] = [];
  const re =
    /\b(?:float|vec[234]|mat[234]|int|uint|void|bool|[iub]vec[234])\s+([a-zA-Z_]\w*)\s*\(/g;
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
  const size = u.size ?? u.length;
  return `uniform ${u.glslType} ${name}${size === undefined ? "" : `[${size}]`};`;
}
