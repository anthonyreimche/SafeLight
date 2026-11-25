// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The develop store as one extension sees it: the app's own store, whose
// commits make their steps in the extension's name (#281), so every step an
// extension makes belongs to its local history without it doing anything.
// Reads and writes go to the app's store; only the committing actions differ.

import { commitsAs, useDevelopStore, type DevelopState } from "@/state/develop-store";

type Committing = Pick<DevelopState, "commitEdit" | "resetParams" | "restoreEdit" | "applyPreset">;

export function developStoreFor(extensionId: string): typeof useDevelopStore {
  const raw = useDevelopStore;
  const as = <A extends unknown[], R>(act: (state: DevelopState) => (...args: A) => R) =>
    (...args: A): R => commitsAs(extensionId, () => act(raw.getState())(...args));
  const committing: Committing = {
    commitEdit: as((s) => s.commitEdit),
    resetParams: as((s) => s.resetParams),
    restoreEdit: as((s) => s.restoreEdit),
    applyPreset: as((s) => s.applyPreset),
  };

  // One view per app state, so a selector that returns the state is stable.
  const views = new WeakMap<DevelopState, DevelopState>();
  const view = (state: DevelopState): DevelopState => {
    let seen = views.get(state);
    if (!seen) {
      seen = { ...state, ...committing };
      views.set(state, seen);
    }
    return seen;
  };

  function useScoped(): DevelopState;
  function useScoped<U>(selector: (state: DevelopState) => U): U;
  function useScoped<U>(selector?: (state: DevelopState) => U): U | DevelopState {
    return raw((state) => (selector ? selector(view(state)) : view(state)));
  }

  return Object.assign(useScoped, {
    getState: () => view(raw.getState()),
    getInitialState: () => view(raw.getInitialState()),
    setState: raw.setState,
    subscribe: (listener: (state: DevelopState, prev: DevelopState) => void) =>
      raw.subscribe((state, prev) => listener(view(state), view(prev))),
  }) as typeof useDevelopStore;
}
