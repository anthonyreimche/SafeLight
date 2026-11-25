// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which extension's local history (#281) the History and Edit panels show: the
// one behind the photo's latest step, or one picked in the History panel until
// another extension makes a new step or another photo opens. Per window, and
// never stored.

import { useMemo } from "react";
import { create } from "zustand";
import { getExtensionName } from "@/extensions/param-registry";
import { useDevelopStore } from "./develop-store";
import { chosenSource, historySources, localHistory, stepSource, type HistoryPin } from "./local-history";
import type { HistorySource, LocalHistoryView } from "./local-history-types";

export const useHistoryPin = create<{ pin: HistoryPin | null }>(() => ({ pin: null }));

/** Show `source`'s local history in place of the latest edited extension's,
 *  on the photo open now; null goes back to following the latest. */
export function chooseHistorySource(source: string | null): void {
  const photoId = useDevelopStore.getState().photoId;
  useHistoryPin.setState({ pin: source && photoId ? { photoId, source } : null });
}

useDevelopStore.subscribe((state, prev) => {
  const { pin } = useHistoryPin.getState();
  if (!pin) return;
  if (state.photoId !== pin.photoId) {
    useHistoryPin.setState({ pin: null });
    return;
  }
  if (state.history === prev.history) return;
  const top = state.history[state.historyIndex];
  if (!top || prev.history.includes(top)) return;
  const source = stepSource(top);
  if (source && source !== pin.source) useHistoryPin.setState({ pin: null });
});

export function useChosenHistorySource(): string | null {
  const history = useDevelopStore((s) => s.history);
  const historyIndex = useDevelopStore((s) => s.historyIndex);
  const photoId = useDevelopStore((s) => s.photoId);
  const pin = useHistoryPin((s) => s.pin);
  return chosenSource(history, historyIndex, photoId, pin);
}

/** Every extension with a step the photo shows, the latest edited first. */
export function useHistorySources(): HistorySource[] {
  const history = useDevelopStore((s) => s.history);
  const historyIndex = useDevelopStore((s) => s.historyIndex);
  return useMemo(
    () => historySources(history, historyIndex).map((id) => ({ id, name: getExtensionName(id) })),
    [history, historyIndex],
  );
}

/** `source`'s steps on the open photo and the one it stands on; null for no source. */
export function useLocalHistory(source: string | null): LocalHistoryView | null {
  const history = useDevelopStore((s) => s.history);
  const historyIndex = useDevelopStore((s) => s.historyIndex);
  return useMemo(
    () => (source ? { ...localHistory(history, historyIndex, source), name: getExtensionName(source) } : null),
    [history, historyIndex, source],
  );
}
