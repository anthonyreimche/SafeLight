// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { normalizeParams, type DevelopParams } from "./types";
import { normalizeParamBag } from "@/extensions/param-registry";

/** A short hash of an edit's look, the same for the live edit a commit renders
 *  from and for that edit saved and loaded again. Loading normalises (a painted
 *  dab gains its default opacity, an out-of-range value is clamped), so both are
 *  hashed normalised; keys go in sorted order, and a key set to undefined counts
 *  as absent, as it does once saved. */
export function editFingerprint(
  params: DevelopParams,
  paramBag: Record<string, unknown>,
): string {
  const look = { params: normalizeParams(params), paramBag: normalizeParamBag(paramBag) };
  return hash64(canonicalJson(look));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const entries = Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  });
}

// cyrb53's mixing on two 32-bit lanes, all 64 bits kept.
function hash64(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return hex32(h2) + hex32(h1);
}

function hex32(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0");
}
