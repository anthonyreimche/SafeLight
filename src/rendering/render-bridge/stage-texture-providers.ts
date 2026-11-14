// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Stage texture variants made on demand (api.setStageTextureProvider). An
// extension whose variants are too many to hold at once (one per calibration
// master and blur, say) hands core a provider for the texture's key, and core
// asks it for each variant a frame's bag names when that frame first needs it.
// A frame that produces a file or a measurement waits for them (needStageVariants);
// the live view never waits: it draws now and again once they land
// (noteLiveStageBag). What is made is held among the extension's stage textures,
// within its budget, and the least recently bound is let go to make room, never
// one the open photo's bag names or a frame in flight draws with: it can be
// asked for again. A variant goes to the render worker only when a frame there
// needs it; an export's renderer in the window reads it where it is held.

import type { StageTextureData } from "@/extensions/types";
import { onStagesReleased, useRegistry } from "@/extensions/registry";
import { variantTextureKey } from "../webgl/stage-texture-variant";
import {
  getStageTextures,
  holdStageTexture,
  onTextureRoomNeeded,
  postStageTexture,
  redrawStages,
  releaseStageTexture,
} from "./wiring";

/** Makes `variant`. `signal` aborts once nothing needs it any more (a variant
 *  the live view passed by in a drag, with no frame waiting for it): work not
 *  started yet can be skipped, and whatever it resolves with then is let go. */
export type StageTextureProvide = (variant: string, signal: AbortSignal) => Promise<StageTextureData | null>;

/** A frame's hold on the variants it draws with: they stay until it lets go. */
export interface StageVariantLease {
  /** Why a variant the frame needs couldn't be had, in words for the person;
   *  null when the frame has everything. */
  failure: string | null;
  release(): void;
}

export interface StageVariantNeeds {
  /** The frame is drawn in the render worker, which must be handed what it needs. */
  worker?: boolean;
  /** The frame's renderer keeps the stages it was built with (an export's), so
   *  one whose extension was turned off since still draws, and can't without
   *  its texture. */
  fixedStages?: boolean;
}

/** How long a provider is given to make a variant. */
export const STAGE_VARIANT_TIMEOUT_MS = 30_000;

interface Provider {
  extensionId: string;
  provide: StageTextureProvide;
  /** Its stage's name, for the reasons given once the stage is gone. */
  name: string;
}

/** A variant held, as core holds it: the extension's data under a version of
 *  core's own, so a variant made again uploads again everywhere. */
interface Held {
  plainKey: string;
  tex: StageTextureData;
  used: number;
}

type Outcome = { ok: true } | { ok: false; reason: string } | { stale: true };

interface Request {
  outcome: Promise<Outcome>;
  settle(outcome: Outcome): void;
  abort: AbortController;
}

const providers = new Map<string, Provider>();
/** Keys whose provider went, with their stage's name, until one comes again. */
const retired = new Map<string, string>();
const held = new Map<string, Held>();
/** Held variants handed to the render worker. */
const posted = new Set<string>();
/** Variants their provider said there are none of. */
const absent = new Set<string>();
const inflight = new Map<string, Request>();
/** When the live view last saw a variant fail, so it doesn't ask on every change. */
const failedAt = new Map<string, number>();
const LIVE_RETRY_MS = 5_000;
/** How many frames in flight draw with each variant. */
const pins = new Map<string, number>();
let liveBag: Readonly<Record<string, unknown>> = {};
let liveOwnBag: Readonly<Record<string, unknown>> | undefined;
let liveKeys: readonly string[] = [];
let clock = 0;
let version = 0;

const stageName = (plainKey: string): string => {
  const stages = useRegistry.getState().processingStages;
  for (let end = plainKey.lastIndexOf("."); end > 0; end = plainKey.lastIndexOf(".", end - 1)) {
    const stage = stages[plainKey.slice(0, end)];
    if (stage) return stage.name || stage.id;
  }
  return retired.get(plainKey) ?? plainKey;
};

const goneReason = (plainKey: string) => `${stageName(plainKey)} was turned off before what this photo needs was made.`;

/** The longest stage id among `ids` that `key` extends. */
function ownerAmong(key: string, ids: readonly string[]): string {
  let owner = "";
  for (const id of ids) if (key.startsWith(`${id}.`) && id.length > owner.length) owner = id;
  return owner;
}

/** The provided variants `bag` names: [variant key, plain key, variant]. */
function namedIn(bag: Readonly<Record<string, unknown>>): [string, string, string][] {
  if (providers.size === 0) return [];
  const out: [string, string, string][] = [];
  for (const plainKey of providers.keys()) {
    const name = bag[plainKey];
    if (typeof name !== "string") continue;
    const key = variantTextureKey(plainKey, name);
    if (key) out.push([key, plainKey, name]);
  }
  return out;
}

/** Whether `key` is held as it was made, not cleared or replaced since. */
function holds(key: string): boolean {
  const h = held.get(key);
  if (h && getStageTextures()[key] === h.tex) return true;
  if (h) {
    held.delete(key);
    posted.delete(key);
  }
  return false;
}

/** Hand held `keys` to the render worker; whether any went now. */
function post(keys: readonly string[]): boolean {
  let any = false;
  for (const key of keys) {
    if (posted.has(key) || !holds(key)) continue;
    postStageTexture(key);
    posted.add(key);
    any = true;
  }
  return any;
}

function ask(key: string, plainKey: string, variant: string): Promise<Outcome> {
  // One set directly (api.setStageTexture) is drawn as it was set.
  if (holds(key) || absent.has(key) || Object.hasOwn(getStageTextures(), key)) return Promise.resolve({ ok: true });
  const running = inflight.get(key);
  if (running) return running.outcome;
  const provider = providers.get(plainKey);
  if (!provider) return Promise.resolve({ ok: false, reason: goneReason(plainKey) });
  let resolve!: (outcome: Outcome) => void;
  const request: Request = {
    outcome: new Promise<Outcome>((r) => (resolve = r)),
    settle: (outcome) => {
      clearTimeout(timer);
      if (inflight.get(key) === request) inflight.delete(key);
      if ("stale" in outcome) request.abort.abort();
      resolve(outcome);
    },
    abort: new AbortController(),
  };
  const timer = setTimeout(
    () => request.settle({ ok: false, reason: `${stageName(plainKey)} took too long to make what this photo needs.` }),
    STAGE_VARIANT_TIMEOUT_MS,
  );
  inflight.set(key, request);
  provider.provide(variant, request.abort.signal).then(
    (made) => {
      if (inflight.get(key) !== request) return;
      if (!made) {
        absent.add(key);
        return request.settle({ ok: true });
      }
      const tex = { ...made, version: ++version };
      const problem = holdStageTexture(key, tex, false);
      if (problem) return request.settle({ ok: false, reason: `${stageName(plainKey)} can't hold what this photo needs: it ${problem}.` });
      held.set(key, { plainKey, tex, used: ++clock });
      if (liveKeys.includes(key) && post([key])) redrawStages();
      request.settle({ ok: true });
    },
    (e: unknown) => {
      if (inflight.get(key) !== request) return;
      request.settle({ ok: false, reason: `${stageName(plainKey)} couldn't make what this photo needs: ${e instanceof Error ? e.message : String(e)}` });
    },
  );
  return request.outcome;
}

function pin(keys: readonly string[], by: number): void {
  for (const key of keys) {
    const n = (pins.get(key) ?? 0) + by;
    if (n > 0) pins.set(key, n);
    else pins.delete(key);
  }
  if (by < 0) dropUnneeded();
}

/** Lets go of the requests no frame waits for and the live view no longer names. */
function dropUnneeded(): void {
  for (const [key, request] of [...inflight]) if (!pins.has(key) && !liveKeys.includes(key)) request.settle({ stale: true });
}

function touch(keys: readonly string[]): void {
  for (const key of keys) {
    const h = held.get(key);
    if (h) h.used = ++clock;
  }
}

/** Why a renderer with fixed stages can't draw `bag`: it names a variant of a
 *  key whose provider went with its stage. */
function retiredFailure(bag: Readonly<Record<string, unknown>>): string | null {
  if (retired.size === 0) return null;
  const stages = useRegistry.getState().processingStages;
  for (const plainKey of retired.keys()) {
    const name = bag[plainKey];
    if (typeof name !== "string" || !variantTextureKey(plainKey, name)) continue;
    if (!stages[ownerAmong(plainKey, Object.keys(stages))]) return goneReason(plainKey);
  }
  return null;
}

/** The variants a frame of `bag` draws with that are made on demand, had: null
 *  at once when it names none (nothing to wait for), else a lease once they are
 *  held, or once one couldn't be had (`failure`). Let go of the lease once the
 *  frame is drawn (for a worker frame, once the worker answers); until then
 *  nothing it draws with is let go. */
export function needStageVariants(
  bag: Readonly<Record<string, unknown>>,
  needs: StageVariantNeeds = {},
): Promise<StageVariantLease> | null {
  const named = namedIn(bag);
  const gone = needs.fixedStages ? retiredFailure(bag) : null;
  if (named.length === 0 && !gone) return null;
  const keys = named.map(([key]) => key);
  pin(keys, 1);
  touch(keys);
  let released = false;
  const lease = (failure: string | null): StageVariantLease => ({
    failure,
    release: () => {
      if (released) return;
      released = true;
      pin(keys, -1);
    },
  });
  const one = async ([key, plainKey, variant]: [string, string, string]): Promise<string | null> => {
    for (;;) {
      const outcome = await ask(key, plainKey, variant);
      if ("stale" in outcome) continue;
      return outcome.ok ? null : outcome.reason;
    }
  };
  return Promise.all(named.map(one)).then((failures) => {
    const failure = gone ?? failures.find((f) => f !== null) ?? null;
    if (!failure && needs.worker) post(keys);
    return lease(failure);
  });
}

/** Have variant `variant` of `plainKey` held, as the most recently bound,
 *  before the live view's bag names it, so the view never draws a frame
 *  without it. Rejects with the reason it couldn't be had. */
export async function prepareStageVariant(plainKey: string, variant: string): Promise<void> {
  if (!variantTextureKey(plainKey, variant)) throw new Error(`"${variant}" isn't a variant name: 1 to 64 letters, digits, - or _`);
  if (!providers.has(plainKey)) throw new Error(`"${plainKey}" has no provider`);
  const lease = await needStageVariants({ [plainKey]: variant }, { worker: true });
  lease?.release();
  if (lease?.failure) throw new Error(lease.failure);
}

/** The bag the live Develop view draws with ({} once it closes), and the
 *  photo's own when an extension's view values are drawn over it: what either
 *  names is asked for without the view waiting (it draws again once a variant
 *  lands), and isn't let go while it is named. */
export function noteLiveStageBag(bag: Readonly<Record<string, unknown>>, own?: Readonly<Record<string, unknown>>): void {
  liveBag = bag;
  liveOwnBag = own;
  if (providers.size === 0) {
    liveKeys = [];
    return;
  }
  const named = namedIn(bag);
  if (own) for (const entry of namedIn(own)) if (!named.some(([key]) => key === entry[0])) named.push(entry);
  liveKeys = named.map(([key]) => key);
  touch(liveKeys);
  dropUnneeded();
  if (post(liveKeys)) redrawStages();
  const now = Date.now();
  for (const [key, plainKey, variant] of named) {
    if (holds(key) || absent.has(key) || inflight.has(key)) continue;
    if (now - (failedAt.get(key) ?? -Infinity) < LIVE_RETRY_MS) continue;
    void ask(key, plainKey, variant).then((outcome) => {
      if ("ok" in outcome && !outcome.ok) {
        failedAt.set(key, Date.now());
        console.warn(`[extensions] ${outcome.reason}`);
      }
    });
  }
}

function forgetVariant(key: string): void {
  inflight.get(key)?.settle({ stale: true });
  absent.delete(key);
  failedAt.delete(key);
  if (holds(key)) releaseStageTexture(key, posted.has(key));
  held.delete(key);
  posted.delete(key);
}

function forgetKey(plainKey: string): void {
  for (const key of new Set([...held.keys(), ...absent, ...inflight.keys(), ...failedAt.keys()]))
    if (key.startsWith(`${plainKey}#`)) forgetVariant(key);
}

/** The extension providing stage texture `plainKey`, if any. */
export function stageTextureProviderOwner(plainKey: string): string | undefined {
  return providers.get(plainKey)?.extensionId;
}

/** Make the variants of stage texture `plainKey` on demand with `provide`, or
 *  stop (null). The caller has checked the extension may. */
export function setStageTextureProvider(plainKey: string, extensionId: string, provide: StageTextureProvide | null): void {
  if (provide) {
    providers.set(plainKey, { extensionId, provide, name: stageName(plainKey) });
    retired.delete(plainKey);
  } else {
    const gone = providers.get(plainKey);
    if (gone) retired.set(plainKey, gone.name);
    providers.delete(plainKey);
  }
  forgetKey(plainKey);
  // The open photo may name a variant already, with no change of bag to come.
  if (provide) noteLiveStageBag(liveBag, liveOwnBag);
}

/** Let go of variant `variant` of `plainKey` (every variant when undefined),
 *  so it is asked for again when next needed: the data it was made from
 *  changed. One the live view names is asked for again at once. A name that
 *  isn't a variant name lets go of nothing. */
export function dropStageTextureVariants(plainKey: string, variant?: string): void {
  if (variant === undefined) forgetKey(plainKey);
  else {
    const key = variantTextureKey(plainKey, variant);
    if (!key) return;
    forgetVariant(key);
  }
  if (liveKeys.some((key) => key.startsWith(`${plainKey}#`))) noteLiveStageBag(liveBag, liveOwnBag);
}

// Room in an extension's budget: its unpinned variants, least recently bound first.
onTextureRoomNeeded((owner, bytes, keep) => {
  const live = new Set(liveKeys);
  const candidates = [...held.entries()]
    .filter(([key, h]) => key !== keep && !pins.has(key) && !live.has(key) && providers.get(h.plainKey)?.extensionId === owner && holds(key))
    .sort(([, a], [, b]) => a.used - b.used);
  let freed = 0;
  for (const [key, h] of candidates) {
    if (freed >= bytes) break;
    freed += h.tex.data.byteLength;
    held.delete(key);
    releaseStageTexture(key, posted.delete(key));
  }
});

// A swept extension's providers go with it (wiring drops the textures): each
// key belongs to the longest stage id it extends, as wiring reckons it.
onStagesReleased((stageIds) => {
  const released = new Set(stageIds);
  const ids = [...stageIds, ...Object.keys(useRegistry.getState().processingStages)];
  for (const [plainKey, provider] of [...providers]) {
    if (!released.has(ownerAmong(plainKey, ids))) continue;
    providers.delete(plainKey);
    retired.set(plainKey, provider.name);
    for (const key of new Set([...held.keys(), ...absent, ...inflight.keys(), ...failedAt.keys(), ...posted]))
      if (key.startsWith(`${plainKey}#`)) {
        inflight.get(key)?.settle({ stale: true });
        held.delete(key);
        posted.delete(key);
        absent.delete(key);
        failedAt.delete(key);
      }
  }
});
