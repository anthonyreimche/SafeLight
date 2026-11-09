// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A panel opened or hovered is the hint that its extension's dormant stages are
// about to wake: the renderer starts building their program then, so the first
// slider move finds it built rather than compiling mid-drag. A panel is matched
// to stages by the extension that registered both.

import { hintStages } from "@/rendering/render-bridge";
import { useRegistry } from "../registry";
import { useDockStore } from "./store";

type Hint = (stageIds: string[]) => void;

function stagesOfPanel(panelId: string): string[] {
  const { panels, processingStages } = useRegistry.getState();
  const owner = panels[panelId]?.extensionId;
  if (!owner) return [];
  return Object.values(processingStages)
    .filter((s) => s.extensionId === owner)
    .map((s) => s.id);
}

function hintPanel(panelId: string, hint: Hint): void {
  const ids = stagesOfPanel(panelId);
  if (ids.length > 0) hint(ids);
}

let lastHovered: string | null = null;

/** Hint `panelId`'s stages on hover; a pointer resting on one header hints once. */
export function prewarmPanel(panelId: string, hint: Hint = hintStages): void {
  if (panelId === lastHovered) return;
  lastHovered = panelId;
  hintPanel(panelId, hint);
}

/** Hint a panel's stages whenever it opens. Returns the unsubscribe. */
export function initStagePrewarm(hint: Hint = hintStages): () => void {
  lastHovered = null;
  let prev = useDockStore.getState().collapsed;
  return useDockStore.subscribe((s) => {
    if (s.collapsed === prev) return;
    const before = prev;
    prev = s.collapsed;
    for (const [id, collapsed] of Object.entries(s.collapsed)) {
      if (!collapsed && before[id]) hintPanel(id, hint);
    }
  });
}
