// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The one resolver an extension registers to turn non-RAW photos into linear
// Rec.709 (api.develop.registerInputProfiles). Core parses neither containers
// nor profiles: it asks the resolver for a transform and applies it (load-image.ts).
// The revision counts every change that can make a converted source stale (a
// resolver come or gone, or one that says its answers changed), and goes into
// the source key of every non-RAW photo, so the GPU source caches never serve
// a source converted under other rules.

import type { InputProfileResolver, InputTransform } from "@/extensions/api/develop";
import { isRawFile } from "@/raw/raw-preview";
import type { CatalogPhoto } from "./types";

/** How long a resolve may take before the photo takes the browser's decode. */
export const RESOLVE_TIMEOUT_MS = 3000;

const MAX_TRC_SAMPLES = 65536;

let held: { owner: string; resolver: InputProfileResolver; warned: boolean } | null = null;
let revision = 0;
const listeners = new Set<() => void>();

function moved(): void {
  revision++;
  for (const listener of [...listeners]) listener();
}

/** Hold `resolver` for `extensionId`. Another extension's is refused with a
 *  warning naming the one that holds it; the owner may replace its own. */
export function registerInputProfiles(extensionId: string, resolver: InputProfileResolver): void {
  if (typeof resolver !== "object" || resolver === null || typeof resolver.resolve !== "function") {
    console.warn(`[extensions] ${extensionId}: registerInputProfiles needs an object with a resolve function; ignored`);
    return;
  }
  if (held && held.owner !== extensionId) {
    console.warn(
      `[extensions] ${extensionId}: input profiles are registered by ${held.owner}; registerInputProfiles ignored`,
    );
    return;
  }
  held = { owner: extensionId, resolver, warned: false };
  try {
    localStorage.setItem(EXPECTED_OWNER_KEY, extensionId);
  } catch {}
  moved();
}

const EXPECTED_OWNER_KEY = "safelight.inputProfileOwner";

/** The extension that held the resolver last, this launch or an earlier one:
 *  the one a non-RAW photo opened while the extensions load waits for. Null
 *  when none ever has, so without one no photo waits. */
export function expectedInputProfileOwner(): string | null {
  try {
    return localStorage.getItem(EXPECTED_OWNER_KEY);
  } catch {
    return null;
  }
}

/** Let go of `extensionId`'s resolver, as when it stops. */
export function dropInputProfiles(extensionId: string): void {
  if (held?.owner !== extensionId) return;
  held = null;
  moved();
}

/** The owner's transforms changed with no token changing (a setting, a profile
 *  added or removed): every converted source is stale. */
export function invalidateInputProfiles(extensionId: string): void {
  if (held?.owner !== extensionId) {
    console.warn(`[extensions] ${extensionId}: holds no input profile resolver; invalidateInputProfiles ignored`);
    return;
  }
  moved();
}

/** The extension holding the resolver, or null. */
export function inputProfileOwner(): string | null {
  return held?.owner ?? null;
}

export function inputProfileRevision(): number {
  return revision;
}

/** Calls `listener` after each move of the revision; returns the stop. */
export function onInputProfilesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What a non-RAW photo's source key adds for its conversion: the revision and
 *  the photo's token while a resolver is held. Nothing while none is: the
 *  browser's decode depends on neither, so a source decoded before a resolver
 *  came still serves once it has gone. */
export function inputProfileKey(photo: Pick<CatalogPhoto, "inputProfile">): string {
  return held ? `:in${revision}:${photo.inputProfile ?? ""}` : "";
}

/** The targetEdge for a background load of `photo` that renders no larger than
 *  `edge` (an edited thumbnail, a headless render): a non-RAW photo's converted
 *  frame is averaged down to it in the worker, instead of crossing to the
 *  renderer at full size. A RAW's decode and its cache entry stay as they were. */
export function convertedTargetEdge(photo: Pick<CatalogPhoto, "filename">, edge: number): { targetEdge?: number } {
  return isRawFile({ name: photo.filename } as File) ? {} : { targetEdge: edge };
}

const finite = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);

/** Why `value` can't be applied as an InputTransform, or null. */
export function inputTransformProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "is not an object";
  const { trc, toRec709 } = value as Partial<Record<keyof InputTransform, unknown>>;
  if (!Array.isArray(trc) || trc.length !== 3) return "needs trc as three tables";
  if (!trc.every((t) => t instanceof Float32Array)) return "needs each trc table in a Float32Array";
  const tables = trc as Float32Array[];
  const n = tables[0].length;
  if (n < 2 || n > MAX_TRC_SAMPLES) return `needs 2 to ${MAX_TRC_SAMPLES} trc samples, not ${n}`;
  if (tables.some((t) => t.length !== n)) return "needs its three trc tables the same length";
  if (tables.some((t) => !t.every(Number.isFinite))) return "has a trc sample that isn't finite";
  if (!Array.isArray(toRec709) || toRec709.length !== 9) return "needs toRec709 as 9 numbers";
  if (!toRec709.every(finite)) return "has a toRec709 entry that isn't a finite number";
  return null;
}

/** The registered resolver's transform for `photo`, whose original is `file`,
 *  or null for the browser's decode: with no resolver, and when the resolver
 *  throws, rejects, takes longer than RESOLVE_TIMEOUT_MS, answers null or
 *  answers something that isn't a valid transform. Never rejects. */
export async function resolveInputTransform(photo: CatalogPhoto, file: Blob): Promise<InputTransform | null> {
  const asked = held;
  if (!asked) return null;
  const subject = {
    id: photo.id,
    filename: photo.filename,
    ...(photo.inputProfile !== undefined ? { inputProfile: photo.inputProfile } : {}),
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), RESOLVE_TIMEOUT_MS);
  });
  let answer: unknown;
  try {
    answer = await Promise.race([asked.resolver.resolve(subject, file), late]);
  } catch (e) {
    console.warn(`[ext:${asked.owner}] input profile resolve failed for ${photo.filename}:`, e);
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (answer === "late") {
    console.warn(`[ext:${asked.owner}] input profile resolve took over ${RESOLVE_TIMEOUT_MS} ms for ${photo.filename}`);
    return null;
  }
  if (answer === null) return null;
  const problem = inputTransformProblem(answer);
  if (problem) {
    // Once a registration: a resolver that is wrong is wrong for every photo.
    if (!asked.warned) {
      asked.warned = true;
      console.warn(`[ext:${asked.owner}] input transform ${problem}; the photo is decoded as sRGB`);
    }
    return null;
  }
  // Only what the frame worker needs: anything else on the resolver's object
  // could fail the structured clone that posts it there.
  const { trc, toRec709 } = answer as InputTransform;
  return { trc: [trc[0], trc[1], trc[2]], toRec709: [...toRec709] };
}
