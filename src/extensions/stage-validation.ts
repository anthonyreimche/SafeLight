// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { BUILTIN_DENOISE_ID } from "@/rendering/webgl/builtin-denoise";
import { isBuiltInStage } from "@/rendering/webgl/builtin-stage";
import { CORE_EXTENSION_ID } from "./core-extension";
import {
  PROCESSING_PHASE_ORDER,
  type ProcessingStageContribution,
  type StageSpace,
} from "./types";

export interface StageContractCheck {
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

/** Fields the contract names that nothing in the core reads. */
const RESERVED_FIELDS = ["produces", "consumes", "mask"] as const;

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
  const warnings: string[] = [];

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
  const reads: unknown = c.reads;
  if (reads !== undefined && (typeof reads !== "string" || !Object.hasOwn(READS, reads)))
    return fail(`reads must be "source" or "current", got ${formatValue(reads)}`);

  let readsIgnored: string | null = null;
  if (reads === "current") {
    if (c.phase === "geometry")
      readsIgnored = `${stagePrefix}: geometry stages run before the image is sampled, so reads "current" is ignored`;
    else if (!c.passes || c.passes.length === 0)
      readsIgnored = `${stagePrefix}: reads "current" only feeds passes and this stage has none, so it is ignored`;
  }

  for (const field of RESERVED_FIELDS) {
    if (c[field] !== undefined) {
      warnings.push(`${stagePrefix}: ${field} is reserved and not implemented, so it is ignored`);
    }
  }
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
