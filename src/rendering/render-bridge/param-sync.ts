// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams, Mask } from "@/catalog/types";
import type { ResolvedPipeline } from "@/extensions/pipelines";
import { resolvePipelineFor } from "@/extensions/pipelines";
import { useRegistry } from "@/extensions/registry";
import { bagForRender, derivedEntries } from "@/extensions/transform-derive";
import { useExtSettings } from "@/extensions/ext-settings";
import type { MaskPatch } from "../render-protocol";
import { windowDerived } from "../window-derive";
import type { WorkerLink } from "./transport";

/** The values the registered stages derive from `params`, for the worker to
 *  draw them with (stage-derive.ts). A stopped essential's params are at their
 *  defaults for them, so a stage reading another tool's params drops that tool
 *  with it (essential-params.ts). */
export function derivedFor(params: DevelopParams): Record<string, unknown> {
  return windowDerived(params, Object.values(useRegistry.getState().processingStages));
}

/** The top-level fields of `next` that `last` lacks or holds another value in, each the
 *  very value `next` holds. */
function changedFields<T extends object>(last: T, next: T): Partial<T> {
  const set: Partial<T> = {};
  for (const key in next) {
    if (!Object.hasOwn(last, key) || !Object.is(last[key], next[key])) set[key] = next[key];
  }
  return set;
}

/** `next` masks as patches on the `last` ones of their ids, or null while an id names
 *  more than one mask in either and a mask can't be told by its id. */
function maskPatches(last: readonly Mask[], next: readonly Mask[]): MaskPatch[] | null {
  const held = new Map(last.map((m) => [m.id, m]));
  if (held.size !== last.length || new Set(next.map((m) => m.id)).size !== next.length) return null;
  return next.map((mask) => {
    const prev = held.get(mask.id);
    if (!prev) return { mask };
    return {
      id: mask.id,
      set: changedFields(prev, mask),
      remove: Object.keys(prev).filter((key) => !Object.hasOwn(mask, key)),
    };
  });
}

/** The entries of `next` that `last` lacks or holds another value for, by
 *  identity: a stage's values are the same objects until it derives again. */
function changedEntries(last: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => !Object.is(last[key], value)));
}

/** Whether two sets of derived values hold the same entries, by identity: a
 *  stage's values are the same objects until it derives again. */
function sameEntries(a: Record<string, unknown>, b: Record<string, unknown> | null): boolean {
  if (!b) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.is(a[k], b[k]));
}

/** The live photo's params, derived values, param bag and pipeline as the worker
 *  last had them, so each change posts only its difference. */
export class ParamSync {
  private readonly link: WorkerLink;
  // The live photo's display-transform pick, mirrored from the params the
  // develop view sends, so the live pipeline follows the photo and can be
  // re-resolved when the registry or the Preferences default changes.
  private liveDisplayTransform: string | null = null;
  private livePipelineSent = false;
  // The params last handed to the worker, whole or by patches. A fresh renderer has seen
  // none.
  private lastPostedParams: DevelopParams | null = null;
  /** The derived stage values posted with them (stage-derive.ts). */
  private lastPostedDerived: Record<string, unknown> | null = null;
  // The param bag last handed to the worker, whole or by patches. A fresh renderer has
  // seen none.
  private lastPostedBag: Record<string, unknown> | null = null;
  // The live bag as the Develop view offered it, before the live transform's
  // derived uniforms were added, so a transform switch can re-derive them.
  private liveBag: Record<string, unknown> | null = null;
  private readonly unsubscribeSettings: () => void;

  constructor(link: WorkerLink) {
    this.link = link;
    // A stage may derive from its extension's settings, which change apart from
    // the params.
    this.unsubscribeSettings = useExtSettings.subscribe(() => this.refreshDerived());
  }

  dispose() {
    this.unsubscribeSettings();
  }

  /** A fresh renderer: the next params and bag go whole. */
  reset() {
    this.lastPostedParams = null;
    this.lastPostedDerived = null;
    this.lastPostedBag = null;
  }

  /** See RenderBridge.setParams. */
  setParams(params: DevelopParams) {
    if (!this.livePipelineSent || params.displayTransform !== this.liveDisplayTransform) {
      this.liveDisplayTransform = params.displayTransform;
      this.syncPipeline();
    }
    const last = this.lastPostedParams;
    if (params === last) return;
    const derived = derivedFor(params);
    if (!last) {
      this.link.post({ cmd: "setParams", params, derived });
    } else {
      const set = changedFields(last, params);
      const remove = Object.keys(last).filter((key) => !Object.hasOwn(params, key));
      if (remove.length === 0 && Object.keys(set).length === 0) return;
      const masks =
        Array.isArray(set.masks) && Array.isArray(last.masks) ? maskPatches(last.masks, set.masks) : null;
      if (masks) delete set.masks;
      const lastDerived = this.lastPostedDerived ?? {};
      const derivedSet = changedEntries(lastDerived, derived);
      const derivedRemove = Object.keys(lastDerived).filter((key) => !Object.hasOwn(derived, key));
      this.link.post({
        cmd: "patchParams",
        set,
        remove,
        ...(masks ? { masks } : {}),
        ...(Object.keys(derivedSet).length > 0 ? { derived: derivedSet } : {}),
        ...(derivedRemove.length > 0 ? { derivedRemove } : {}),
      });
    }
    this.lastPostedParams = params;
    this.lastPostedDerived = derived;
  }

  /** Sends the live params' derived values again when they changed without the
   *  params: a stage that derives them came or went, or its settings changed. */
  refreshDerived() {
    const params = this.lastPostedParams;
    if (!params || this.link.disposed) return;
    const derived = derivedFor(params);
    if (sameEntries(derived, this.lastPostedDerived)) return;
    this.link.post({ cmd: "setDerived", derived });
    this.lastPostedDerived = derived;
  }

  /** See RenderBridge.setContributedParams. */
  setLiveBag(bag: Record<string, unknown>) {
    this.liveBag = bag;
    this.postBag(bagForRender(resolvePipelineFor(this.liveDisplayTransform), bag));
  }

  private postBag(bag: Record<string, unknown>) {
    const last = this.lastPostedBag;
    if (!last) {
      this.link.post({ cmd: "setContributedParams", bag });
    } else {
      const set = changedFields(last, bag);
      const remove = Object.keys(last).filter((key) => !Object.hasOwn(bag, key));
      if (remove.length === 0 && Object.keys(set).length === 0) return;
      this.link.post({ cmd: "patchContributedParams", set, remove });
    }
    this.lastPostedBag = bag;
  }

  /** Re-send the live pipeline: the live photo's pick resolved against the
   *  current registry and Preferences default. */
  syncPipeline() {
    this.livePipelineSent = true;
    const pipeline = resolvePipelineFor(this.liveDisplayTransform);
    this.link.post({ cmd: "setPipeline", pipeline });
    // Its derived uniforms belong to the transform, so a switch re-derives the
    // live bag. Before the first bag after an init there is nothing to update.
    if (this.liveBag && this.lastPostedBag) {
      this.postBag(bagForRender(pipeline, this.liveBag));
    }
  }

  // A capture's bag patch, with the derived uniforms of the capture's
  // transform for the live bag and the patch together.
  capturePatch(
    pipeline: ResolvedPipeline,
    patch: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    const derived = derivedEntries(pipeline, { ...this.liveBag, ...patch });
    return Object.keys(derived).length === 0 ? patch : { ...patch, ...derived };
  }

  // A thumbnail's bag: its own with its transform's derived uniforms, or, for
  // one drawn with the live bag, the live bag with them when there are any.
  thumbBag(
    pipeline: ResolvedPipeline,
    bag: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (bag) return bagForRender(pipeline, bag);
    const derived = derivedEntries(pipeline, this.liveBag ?? {});
    return Object.keys(derived).length === 0 ? undefined : { ...this.liveBag, ...derived };
  }
}
