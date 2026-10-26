// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A display transform's derived uniforms (PipelineContribution.derive) come
// from extension code, which only the main thread can run. They are computed
// here from the transform's params in a photo's bag and handed to a renderer
// inside the bag it draws with, under "{id}#{key}" keys no param can have, so
// they never reach the develop store, the catalog or a preset.

import { derivedKey, type ResolvedPipeline } from "./pipelines";
import { isUniformValue } from "./pipeline-validation";
import { useRegistry, type RegisteredPipeline } from "./registry";
import type { UniformDeclaration, UniformValue } from "./types";

const NONE: Readonly<Record<string, UniformValue>> = Object.freeze({});

// One entry per transform, keyed by its values: a slider drag replaces it on
// every value, and the steady state (frames with unchanged values) is a hit.
// Cleared whenever the registry's transforms change, so a re-registered derive
// always runs.
const memo = new Map<string, { key: string; entries: Readonly<Record<string, UniformValue>> }>();
let memoFrom: unknown = null;
// One warning per registration, whatever values it fails on: every
// registerPipeline call stores a registration of its own.
const warned = new WeakSet<RegisteredPipeline>();

function warnOnce(registration: RegisteredPipeline, message: string): void {
  if (warned.has(registration)) return;
  warned.add(registration);
  console.warn(`[extensions] transform "${registration.id}": ${message}; its derived uniforms use their defaults`);
}

// derive.fn is extension code, so what it returns is only trusted once checked.
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The results in `result` that fit their uniform, by key. Arrays are copied:
 *  the memo hands its entries out again, and a fn that returns one array it
 *  mutates would change them. Throws what reading `result` throws. */
function fittingResults(
  registration: RegisteredPipeline,
  uniforms: readonly UniformDeclaration[],
  result: Record<string, unknown>,
): Map<string, UniformValue> {
  const fitting = new Map<string, UniformValue>();
  for (const u of uniforms) {
    const v = result[u.key];
    const value = Array.isArray(v) ? v.slice() : v;
    if (isUniformValue(value, u.glslType)) fitting.set(u.key, value);
    else warnOnce(registration, `derive.fn returned no ${u.glslType} for "${u.key}"`);
  }
  return fitting;
}

/** The transform's params as derive.fn takes them, by key: each the bag's
 *  value when it fits the param's type, else the param's default. The bag
 *  comes from storage and extensions, so its values are unknown. */
export function transformValues(
  pipeline: ResolvedPipeline,
  bag: Readonly<Record<string, unknown>>,
): Record<string, UniformValue> {
  const params = useRegistry.getState().pipelines[pipeline.id]?.params ?? [];
  const values: Record<string, UniformValue> = {};
  for (const u of params) {
    const v = bag[`${pipeline.id}.${u.key}`];
    values[u.key] = isUniformValue(v, u.glslType) ? v : u.default;
  }
  return values;
}

/** The derived uniforms `pipeline` draws with for `bag`, keyed "{id}#{key}";
 *  empty for a transform without derive. */
export function derivedEntries(
  pipeline: ResolvedPipeline,
  bag: Readonly<Record<string, unknown>>,
): Readonly<Record<string, UniformValue>> {
  const registered = useRegistry.getState().pipelines;
  if (memoFrom !== registered) {
    memo.clear();
    memoFrom = registered;
  }
  const registration = registered[pipeline.id];
  if (!registration?.derive) return NONE;
  const derive = registration.derive;
  const values = transformValues(pipeline, bag);
  const key = JSON.stringify(values);
  const hit = memo.get(pipeline.id);
  if (hit?.key === key) return hit.entries;
  let fitting = new Map<string, UniformValue>();
  try {
    const result: unknown = derive.fn(values);
    if (isObject(result)) fitting = fittingResults(registration, derive.uniforms, result);
    else warnOnce(registration, `derive.fn returned ${result === null ? "null" : typeof result}, not an object`);
  } catch (err) {
    warnOnce(registration, `derive.fn threw (${err instanceof Error ? err.message : String(err)})`);
  }
  const entries: Record<string, UniformValue> = {};
  for (const u of derive.uniforms) entries[derivedKey(pipeline.id, u.key)] = fitting.get(u.key) ?? u.default;
  memo.set(pipeline.id, { key, entries });
  return entries;
}

/** The bag a renderer draws `pipeline` with: `bag` and the transform's
 *  derived uniforms. The very `bag` when nothing is derived. */
export function bagForRender(
  pipeline: ResolvedPipeline,
  bag: Record<string, unknown>,
): Record<string, unknown> {
  const entries = derivedEntries(pipeline, bag);
  return entries === NONE ? bag : { ...bag, ...entries };
}
