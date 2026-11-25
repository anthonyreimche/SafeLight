// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The mask component kinds extensions register (api.develop.registerMaskComponentKind),
// held in the window. A kind makes a mask component whose coverage the extension
// computes (a raster over the whole source); Masking lists the kinds, the render
// side asks each for its coverage and watches its generation.

import { useSyncExternalStore, type ComponentType } from "react";
import type { Mask } from "@/catalog/types";
import { guardCallback } from "@/extensions/guard";

/** Coverage over the whole uncropped source: one byte per pixel, row 0 at
 *  source v 0 (the orientation of a brush dab's y). */
export interface MaskCoverageBitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A click or drag point on the photo, in source UV, with the modifiers held. */
export interface MaskComponentPoint {
  u: number;
  v: number;
  alt: boolean;
  shift: boolean;
}

export interface MaskComponentControlsProps {
  values: Record<string, unknown>;
  setValues(patch: Record<string, unknown>): void;
  commit(label: string): void;
}

export interface MaskCoverageRequest {
  photoId: string;
  componentId: string;
  values: Record<string, unknown>;
  signal: AbortSignal;
}

export interface MaskComponentKindContribution {
  name: string;
  label: string;
  icon?: string;
  commitLabel?: string;
  create(): Record<string, unknown>;
  onPoint?(values: Record<string, unknown>, p: MaskComponentPoint): Record<string, unknown> | null;
  markers?(values: Record<string, unknown>): { u: number; v: number; subtract?: boolean }[];
  Controls?: ComponentType<MaskComponentControlsProps>;
  coverage(req: MaskCoverageRequest): Promise<MaskCoverageBitmap | null>;
}

export interface RegisteredMaskComponentKind extends MaskComponentKindContribution {
  type: string;
  owner: string;
  generation: number;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

const kinds = new Map<string, RegisteredMaskComponentKind>();
const readers = new Set<() => void>();
let listed: readonly RegisteredMaskComponentKind[] = [];
let generations = 0;

function changed(): void {
  listed = [...kinds.values()];
  for (const read of readers) read();
}

function problem(kind: MaskComponentKindContribution | null): string | null {
  if (typeof kind !== "object" || kind === null) return "needs to be an object";
  if (typeof kind.name !== "string" || !NAME.test(kind.name)) return "needs a name of lower-case letters, digits and dashes";
  if (typeof kind.label !== "string" || kind.label.length === 0) return "needs a label";
  if (typeof kind.create !== "function") return "needs a create function";
  if (typeof kind.coverage !== "function") return "needs a coverage function";
  return null;
}

function guarded(owner: string, kind: MaskComponentKindContribution): MaskComponentKindContribution {
  const { onPoint, markers, coverage } = kind;
  const cover = guardCallback(
    owner,
    "mask component coverage",
    (req: MaskCoverageRequest): Promise<MaskCoverageBitmap | null> =>
      Promise.resolve(coverage.call(kind, req)).catch((e: unknown) => {
        if (!req.signal.aborted) console.error(`[extensions] ${owner}: mask component coverage rejected:`, e);
        return null;
      }),
    Promise.resolve(null),
  );
  return {
    ...kind,
    create: guardCallback(owner, "mask component create", () => kind.create(), {} as Record<string, unknown>),
    ...(onPoint
      ? {
          onPoint: guardCallback(
            owner,
            "mask component point",
            (values: Record<string, unknown>, p: MaskComponentPoint) => onPoint.call(kind, values, p),
            null,
          ),
        }
      : {}),
    ...(markers
      ? {
          markers: guardCallback(
            owner,
            "mask component markers",
            (values: Record<string, unknown>) => markers.call(kind, values),
            [] as { u: number; v: number; subtract?: boolean }[],
          ),
        }
      : {}),
    coverage: cover,
  };
}

/** Hold `kind` for `owner` as `{owner}.{name}`. A kind the window can't use is
 *  refused with a warning, as is a type another extension holds; an owner may
 *  replace its own. */
export function registerMaskComponentKind(owner: string, kind: MaskComponentKindContribution): void {
  const bad = problem(kind);
  if (bad) {
    console.warn(`[extensions] ${owner}: mask component kind "${String(kind?.name)}" ${bad}; registerMaskComponentKind ignored`);
    return;
  }
  const type = `${owner}.${kind.name}`;
  const held = kinds.get(type);
  if (held && held.owner !== owner) {
    console.warn(
      `[extensions] ${owner}: mask component kind "${type}" is registered by ${held.owner}; registerMaskComponentKind ignored`,
    );
    return;
  }
  kinds.set(type, { ...guarded(owner, kind), type, owner, generation: ++generations });
  changed();
}

/** Drop `owner`'s kind `name`. */
export function unregisterMaskComponentKind(owner: string, name: string): void {
  if (kinds.delete(`${owner}.${name}`)) changed();
}

/** Drop every kind `owner` registered, as when it stops. */
export function unregisterMaskComponentKindsOf(owner: string): void {
  let dropped = false;
  for (const [type, held] of kinds) {
    if (held.owner !== owner) continue;
    kinds.delete(type);
    dropped = true;
  }
  if (dropped) changed();
}

/** Every registered kind, in the order they came. The same array until the set
 *  or a generation changes. */
export function maskComponentKinds(): readonly RegisteredMaskComponentKind[] {
  return listed;
}

export function maskComponentKind(type: string): RegisteredMaskComponentKind | undefined {
  return kinds.get(type);
}

/** Tell the render side `owner`'s kind `name` has new coverage for the same
 *  values (its model changed): bumps the kind's generation. */
export function refreshMaskCoverage(owner: string, name: string): void {
  const held = kinds.get(`${owner}.${name}`);
  if (!held) return;
  kinds.set(held.type, { ...held, generation: ++generations });
  changed();
}

/** Call `listener` whenever the set or a generation changes; returns the way to stop. */
export function subscribeMaskComponentKinds(listener: () => void): () => void {
  readers.add(listener);
  return () => readers.delete(listener);
}

/** React hook: maskComponentKinds(), re-rendering when it changes. */
export function useMaskComponentKinds(): readonly RegisteredMaskComponentKind[] {
  return useSyncExternalStore(subscribeMaskComponentKinds, maskComponentKinds);
}

const MAX_RASTER_CHANNELS = 4;
const channelsOf = new WeakMap<readonly Mask[], Record<string, number>>();

/** The raster channel (0..3) each extension component of `masks` is packed
 *  into, by its place among them across masks; the fifth and later get -1. */
export function maskRasterChannels(masks: readonly Mask[]): Record<string, number> {
  const known = channelsOf.get(masks);
  if (known) return known;
  const channels: Record<string, number> = {};
  let next = 0;
  for (const mask of masks) {
    for (const c of mask.components) {
      if (c.kind !== "extension" || !c.extension) continue;
      channels[c.id] = next < MAX_RASTER_CHANNELS ? next : -1;
      next++;
    }
  }
  channelsOf.set(masks, channels);
  return channels;
}
