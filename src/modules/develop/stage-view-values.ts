// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { create } from "zustand";

// Stage values the live view draws over the photo's own (api.develop
// .setViewValues): view-only feedback an extension gives on its own stages,
// such as a hovered layer's highlight. Never saved, undone or exported, and
// not in thumbnails; a panel held off drops them with the rest of its stages'
// values. Each extension sets its own, dropped when it stops.

const EMPTY: Readonly<Record<string, unknown>> = Object.freeze({});

interface StageViewValues {
  byOwner: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Every extension's values in one bag, the same empty object while none. */
  merged: Readonly<Record<string, unknown>>;
}

export const useStageViewValues = create<StageViewValues>(() => ({ byOwner: {}, merged: EMPTY }));

/** The entries of `values` under a stage `owner` registered ("{stageId}.…"). */
export function ownStageValues(
  owner: string,
  values: Record<string, unknown>,
  stages: readonly { id: string; extensionId: string }[],
): Record<string, unknown> {
  const prefixes = stages.filter((s) => s.extensionId === owner).map((s) => `${s.id}.`);
  return Object.fromEntries(Object.entries(values).filter(([k]) => prefixes.some((p) => k.startsWith(p))));
}

/** Set `owner`'s view values, replacing its last; null or none clears them. */
export function setStageViewValues(owner: string, values: Record<string, unknown> | null): void {
  const { byOwner } = useStageViewValues.getState();
  const next = { ...byOwner };
  if (values && Object.keys(values).length > 0) next[owner] = { ...values };
  else if (owner in next) delete next[owner];
  else return;
  const owners = Object.values(next);
  useStageViewValues.setState({
    byOwner: next,
    merged: owners.length > 0 ? Object.assign({}, ...owners) : EMPTY,
  });
}
