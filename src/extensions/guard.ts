// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Containment for extension code the core waits on. Starting extensions and
// running catalogue hooks happen one after another, so one bundle that throws or
// never finishes would otherwise stall every extension or import behind it. The
// callbacks the core calls while it renders (a grid filter, a sort) are
// contained too: one that throws would otherwise take the window down.

import { create } from "zustand";
import type { ExtensionModule, SafelightAPI } from "./types";

/** How long an extension gets to start before the core counts it as failed and
 *  moves on. */
export const EXTENSION_TIMEOUT_MS = 15_000;

/** How long a catalogue hook gets to finish. Longer than a start: a hook may wait
 *  on the network, e.g. to look up where a photo was taken. */
export const CATALOG_HOOK_TIMEOUT_MS = 60_000;

/** What guardExtension rejects with when the work ran out of time. */
export class ExtensionTimeoutError extends Error {}

/** Run `run` for extension `id`, resolving with what it returns. A throw, a
 *  rejection or not finishing within `ms` (an ExtensionTimeoutError) rejects
 *  instead. `run` is called at once, and its signal aborts when the time runs
 *  out, so work that finishes late can tell it no longer counts. */
export function guardExtension<T>(
  id: string,
  run: (signal: AbortSignal) => T | PromiseLike<T>,
  ms = EXTENSION_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new ExtensionTimeoutError(`${id} did not finish within ${ms / 1000} s`));
    }, ms);
    new Promise<T>((started) => started(run(controller.signal)))
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

/** What a load leaves behind when it fails or stops counting. */
export interface LoadCleanup<T> {
  /** Sweep what the load registered. */
  sweep(): void;
  /** Stop a start that finished after its load stopped counting. It is its own
   *  module, never the one a newer load started, so stopping it is safe. */
  stop(started: T): void;
}

/** Above zero while a start that no longer counts is being stopped; see
 *  fenceAPI. */
let stopping = 0;

interface Load<T> {
  source: string;
  /** Aborts once the load stops counting: it ran out of time, or a load of the
   *  same id from another bundle took over. */
  controller: AbortController;
  timedOut: boolean;
  done: Promise<T>;
}

/** Keeps overlapping loads of one extension id apart. Each load runs under
 *  guardExtension, and only an id's latest load may sweep its contributions. A
 *  load from another bundle takes the id over; the start it overtook is stopped
 *  once it finishes. One from the same bundle joins the load under way, and is
 *  refused while a start of it that timed out is still running, since the
 *  browser hands both the same module. */
export function createLoadTracker<T>() {
  const loads = new Map<string, Load<T>>();
  return function load(
    id: string,
    source: string,
    run: (signal: AbortSignal) => Promise<T>,
    cleanup: LoadCleanup<T>,
  ): Promise<T> {
    const running = loads.get(id);
    if (running?.source === source) {
      return running.timedOut
        ? Promise.reject(new Error(`${id} is still finishing a start that timed out`))
        : running.done;
    }
    running?.controller.abort();
    const controller = new AbortController();
    const { signal } = controller;
    // Read only once `run` has yielded, by which time `entry` is set.
    const latest = (): boolean => loads.get(id) === entry;
    const entry: Load<T> = {
      source,
      controller,
      timedOut: false,
      done: guardExtension(id, async (timeout) => {
        timeout.addEventListener("abort", () => {
          entry.timedOut = true;
          controller.abort();
        });
        try {
          const started = await run(signal);
          if (signal.aborted) {
            stopping++;
            try {
              cleanup.stop(started);
            } finally {
              stopping--;
            }
            throw new Error(`${id}: this start no longer counts`);
          }
          return started;
        } catch (e) {
          if (!signal.aborted && latest()) cleanup.sweep();
          throw e;
        } finally {
          if (latest()) loads.delete(id);
        }
      }).catch((e: unknown) => {
        if (entry.timedOut && latest()) cleanup.sweep();
        throw e;
      }),
    };
    loads.set(id, entry);
    return entry.done;
  };
}

// Calls in a namespace (api.settings.onChange, api.develop.setParam) that add
// a listener or change state, by name, and the writers whose names don't say
// so. Others there are components, hooks and readers, left as they are. The
// dialogues are fenced too: a stale start's question would stand in front of the
// live copy and hold back the app's shortcuts until answered.
const FENCED_CALL = /^(on|register|set|subscribe)([A-Z]|$)/;
const SUBSCRIBE_CALL = /^(on|subscribe)([A-Z]|$)/;
const FENCED_WRITERS = new Set([
  "putEditState",
  "putPhotoData",
  "addPhotos",
  "renamePhoto",
  "apply",
  "togglePanel",
  "confirmDialog",
  "alertDialog",
]);

/** What a call refused while a stale copy stops hands back: a dialogue still
 *  answers with a promise, so a deactivate that chains on it runs on (a
 *  confirmation reads as declined). */
function refusedAnswer(key: string): unknown {
  if (key === "confirmDialog") return Promise.resolve(false);
  if (key === "alertDialog") return Promise.resolve();
  return undefined;
}

/** `api` with the calls a stale start could change the live copy with refused
 *  once `signal` aborts: every top-level call (all register, unregister and
 *  setStageTexture) and, one namespace down, FENCED_CALL names and
 *  FENCED_WRITERS, and a store hook's setState and subscribe. A refused call throws, ending the stale activate, except
 *  while the stale copy is being stopped: then it does nothing, so the rest of
 *  its deactivate (timers, listeners, workers) still runs. Each wrapper is
 *  made once, so a call reads the same function every time. Given
 *  `subscriptions`, the unsubscribe each onX or subscribeX call hands back is added
 *  to it, so the start's listeners can be dropped without waiting for its id to
 *  unload. */
export function fenceAPI(
  api: SafelightAPI,
  signal: AbortSignal,
  subscriptions?: Set<() => void>,
): SafelightAPI {
  const refused = (): boolean => {
    if (!signal.aborted) return false;
    if (stopping > 0) return true;
    throw new Error(`${api.extensionId}: this start no longer counts`);
  };
  const fence = <O extends object>(target: O, fenced: (key: string) => boolean, nested: boolean): O => {
    const wrapped = new Map<PropertyKey, unknown>();
    return new Proxy(target, {
      get(t, key, receiver) {
        if (wrapped.has(key)) return wrapped.get(key);
        const value: unknown = Reflect.get(t, key, receiver);
        const fixed = Reflect.getOwnPropertyDescriptor(t, key);
        // A proxy must hand back a frozen property as it is.
        const frozen = fixed && !fixed.configurable && !fixed.writable;
        let wrapper: unknown;
        if (typeof key === "string" && !frozen) {
          if (typeof value === "function" && fenced(key)) {
            const subscribes = subscriptions !== undefined && SUBSCRIBE_CALL.test(key);
            wrapper = (...args: unknown[]) => {
              if (refused()) return refusedAnswer(key);
              const result: unknown = Reflect.apply(value, t, args);
              if (subscribes && typeof result === "function") subscriptions.add(result as () => void);
              return result;
            };
          } else if (nested && typeof value === "object" && value !== null) {
            wrapper = fence(value, (k) => FENCED_CALL.test(k) || FENCED_WRITERS.has(k), false);
          } else if (!nested && typeof value === "function" && isStoreHook(value)) {
            // A proxy over the hook calls it as it is; only its setState and
            // subscribe are fenced.
            wrapper = fence(value, (k) => FENCED_CALL.test(k), false);
          }
        }
        if (wrapper === undefined) return value;
        wrapped.set(key, wrapper);
        return wrapper;
      },
    });
  };
  return fence(api, () => true, true);
}

/** A zustand store hook, such as api.stores.useDevelopStore. */
const isStoreHook = (value: object): boolean =>
  "setState" in value && typeof value.setState === "function" && "subscribe" in value;

/** Activate `mod` with `api` fenced by `signal`. A failure once the start no
 *  longer counts, such as a refused call, isn't rethrown: the tracker then
 *  stops the module instead of reporting it. */
export async function activateFenced(
  mod: ExtensionModule,
  api: SafelightAPI,
  signal: AbortSignal,
  subscriptions?: Set<() => void>,
): Promise<void> {
  try {
    await mod.activate(fenceAPI(api, signal, subscriptions));
  } catch (e) {
    if (!signal.aborted) throw e;
  }
}

/** How many throws a callback gets before the core stops calling it. */
export const CALLBACK_FAILURE_LIMIT = 3;

export interface CallbackFailure {
  /** What the callback is, e.g. "grid filter". */
  kind: string;
  error: string;
}

/** The extensions with a callback the core stopped calling, by extension id. */
export const useCallbackFailures = create<Record<string, CallbackFailure>>(() => ({}));

// Counted per extension and function: one registered in its place starts
// afresh, and so does every one of an extension loaded again, whose bundle hands
// back the same functions.
const callbackThrows = new Map<string, WeakMap<object, number>>();
const loggedCallbacks = new Set<string>();

/** `fn`, for the core to call on `extensionId`'s behalf where nothing else
 *  would catch it (a grid filter, a sort). A throw answers `fallback` and is
 *  logged once per extension and kind; after CALLBACK_FAILURE_LIMIT throws `fn`
 *  isn't called again and the extension goes into useCallbackFailures. Given
 *  `self`, `fn` is called on it, as a method of the contribution it came from. */
export function guardCallback<A extends unknown[], R>(
  extensionId: string,
  kind: string,
  fn: (...args: A) => R,
  fallback: R,
  self?: object,
): (...args: A) => R {
  return (...args) => {
    const counts = callbackThrows.get(extensionId);
    const throws = counts?.get(fn) ?? 0;
    if (throws >= CALLBACK_FAILURE_LIMIT) return fallback;
    try {
      return Reflect.apply(fn, self, args);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const logKey = `${extensionId}\0${kind}`;
      if (!loggedCallbacks.has(logKey)) {
        loggedCallbacks.add(logKey);
        console.error(`[extensions] ${extensionId}: ${kind} threw:`, e);
      }
      if (counts) counts.set(fn, throws + 1);
      else callbackThrows.set(extensionId, new WeakMap([[fn, 1]]));
      if (throws + 1 === CALLBACK_FAILURE_LIMIT) {
        console.error(`[extensions] ${extensionId}: ${kind} threw ${CALLBACK_FAILURE_LIMIT} times and is off until the extension reloads or registers a new one`);
        useCallbackFailures.setState({ [extensionId]: { kind, error } });
      }
      return fallback;
    }
  };
}

/** Forget `extensionId`'s callback failures as it unloads, so a copy loaded
 *  again is called, logged and listed afresh. */
export function forgetCallbackFailures(extensionId: string): void {
  callbackThrows.delete(extensionId);
  for (const key of loggedCallbacks) if (key.startsWith(`${extensionId}\0`)) loggedCallbacks.delete(key);
  if (!(extensionId in useCallbackFailures.getState())) return;
  const { [extensionId]: _gone, ...rest } = useCallbackFailures.getState();
  useCallbackFailures.setState(rest, true);
}

// The unsubscribes of what each extension subscribed to through its API, run
// when it unloads: one whose deactivate forgets a listener would otherwise keep
// it across an update.
const subscriptions = new Map<string, Set<() => void>>();

/** `subscribe` for `extensionId` (taking the same arguments), with its listener
 *  dropped by dropSubscriptions if the extension hasn't unsubscribed by then. */
export function trackSubscription<A extends unknown[]>(
  extensionId: string,
  subscribe: (...args: A) => () => void,
): (...args: A) => () => void {
  return (...args) => {
    const unsubscribe = subscribe(...args);
    let set = subscriptions.get(extensionId);
    if (!set) subscriptions.set(extensionId, (set = new Set()));
    const own = set;
    const tracked = (): void => {
      own.delete(tracked);
      unsubscribe();
    };
    own.add(tracked);
    return tracked;
  };
}

/** Unsubscribe whatever `extensionId` is still subscribed to, as it unloads. */
export function dropSubscriptions(extensionId: string): void {
  const set = subscriptions.get(extensionId);
  subscriptions.delete(extensionId);
  set?.forEach((unsubscribe) => unsubscribe());
}

const componentKeys = new WeakMap<object, number>();
let nextComponentKey = 0;

/** A key for the error boundary around an extension component: a component
 *  registered again under the same id gets a fresh boundary, not the crash
 *  notice of the one it replaced. */
export function boundaryKey(id: string, component: object): string {
  let key = componentKeys.get(component);
  if (key === undefined) componentKeys.set(component, (key = nextComponentKey++));
  return `${id}:${key}`;
}
