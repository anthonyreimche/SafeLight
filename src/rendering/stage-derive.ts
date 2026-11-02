// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams } from "@/catalog/types";
import type {
  ProcessingStageContribution,
  StageAtlasItem,
  StageDeriveContext,
  StageTextureData,
  StageValue,
} from "@/extensions/types";
import { writesRawNames } from "./webgl/builtin-stage";

// The values Safelight's and the official extensions' stages derive from a
// photo's params (ProcessingStageContribution.derive). They are worked out in
// the window, where the stages' code runs, and go to the renderer with the
// params they came from, so a draw of other params than the live photo's (a
// probe, a thumbnail) never reads the live photo's values. What only the window
// holds comes in from the caller (window-derive.ts).

/** A derived value: a uniform's, or a photo texture's data. */
type Derivable = StageValue | StageTextureData | StageAtlasItem[];

type Stage = ProcessingStageContribution & { extensionId?: string };

type Derive = NonNullable<ProcessingStageContribution["derive"]>;

/** What a derive reads besides the params. */
export interface DeriveContext {
  /** An extension's stored settings, by its id: the same object until they
   *  change, as a stage's values are kept only while they are. */
  settingsFor(ownerId: string): Readonly<Record<string, unknown>>;
}

interface Derived {
  /** The stage as registered: one registered again may declare other uniforms. */
  stage: Stage;
  params: DevelopParams;
  /** The params fields the derive read, with the values it read; null when it
   *  went through them all (a spread), so only the same params object will do. */
  reads: Map<string, unknown> | null;
  settings: unknown;
  entries: Record<string, Derivable>;
}

// The last few params each derive ran for, most recent first: a capture or a
// thumbnail derives other params between the live photo's frames, and must not
// push the live photo's values out. Held by the derive itself, so a stage that
// is unregistered takes its entries with it.
const DERIVED_PER_STAGE = 4;
const derivedBy = new WeakMap<Derive, Derived[]>();
const reportedFailures = new Set<string>();

/** `params` as a derive sees it, recording into `reads` each field read; a
 *  look at every key (a spread) clears it, as every field was read. */
function recording(params: DevelopParams, read: { reads: Map<string, unknown> | null }): DevelopParams {
  return new Proxy(params, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof key === "string") read.reads?.set(key, value);
      return value;
    },
    ownKeys(target) {
      read.reads = null;
      return Reflect.ownKeys(target);
    },
  });
}

/** Whether the fields a derive read are the same values in `params`. */
const sameReads = (last: Derived, params: DevelopParams): boolean =>
  last.params === params ||
  (last.reads !== null && [...last.reads].every(([key, value]) => Object.is(Reflect.get(params, key), value)));

/** A stage's derived values under its qualified keys, from a recent call when
 *  neither the params it read nor the extension's settings changed. Those are
 *  the same objects, so the values reach the render worker only when they
 *  change. A derive is a pure function of the params and settings. */
function stageEntries(stage: Stage, params: DevelopParams, context: DeriveContext): Record<string, Derivable> {
  const derive = stage.derive;
  if (!derive || !writesRawNames(stage)) return {};
  const owner = stage.extensionId ?? "";
  const settings = context.settingsFor(owner);
  const held = derivedBy.get(derive) ?? [];
  // Another stage registered with the same derive keeps its own.
  const others = held.filter((d) => d.stage.id !== stage.id);
  const recent = held.filter((d) => d.stage === stage && d.settings === settings);
  const hit = recent.findIndex((d) => sameReads(d, params));
  if (hit >= 0) {
    const [last] = recent.splice(hit, 1);
    derivedBy.set(derive, [last, ...recent, ...others]);
    return last.entries;
  }
  const ctx: StageDeriveContext = {
    settings: <T>(key: string, fallback: T): T => (settings[key] === undefined ? fallback : (settings[key] as T)),
  };
  const read: { reads: Map<string, unknown> | null } = { reads: new Map() };
  let values: Record<string, Derivable>;
  try {
    values = derive(recording(params, read), ctx);
  } catch (err) {
    if (!reportedFailures.has(stage.id)) {
      reportedFailures.add(stage.id);
      const why = err instanceof Error ? err.message : String(err);
      console.error(`[render] stage "${stage.id}": derive failed (${why}); its values are left out`);
    }
    values = {};
  }
  const keys = new Set([
    ...stage.uniforms.map((u) => u.key),
    ...(stage.textures ?? []).filter((t) => t.kind === "photo" || t.kind === "atlas").map((t) => t.key),
  ]);
  const entries: Record<string, Derivable> = {};
  for (const [key, value] of Object.entries(values)) {
    if (keys.has(key)) entries[`${stage.id}.${key}`] = value;
  }
  derivedBy.set(derive, [
    { stage, params, reads: read.reads, settings, entries },
    ...recent.slice(0, DERIVED_PER_STAGE - 1),
    ...others,
  ]);
  return entries;
}

/** Every value `stages` derive from `params`, under the stages' qualified keys. */
export function deriveStageValues(
  params: DevelopParams,
  stages: readonly Stage[],
  ctx: DeriveContext,
): Record<string, Derivable> {
  const out: Record<string, Derivable> = {};
  for (const stage of stages) Object.assign(out, stageEntries(stage, params, ctx));
  return out;
}
