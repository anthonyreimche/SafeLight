// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useMemo } from "react";
import type { ComponentType } from "react";
import { panelTitle, useRegistry, type RegisteredPanel } from "@/extensions/registry";
import { isMaskBagKey } from "@/state/develop-slices/mask-slice";

// The panels that can be added to a mask (PanelContribution.mask): each mask
// draws its own instance of one inside core's mask scope (mask-scope.tsx),
// which binds it to that mask. Masking's panel lists them.

export interface MaskPanelEntry {
  /** The panel's id: what a mask's `panels` list holds. */
  id: string;
  title: string;
  /** The values the sub-panel owns on a mask (MaskPanelContribution.owns). */
  owns: readonly string[];
  component: ComponentType;
  /** Whether it owns an extension's params, which run in the mask only at
   *  the current processing. */
  extensionParams: boolean;
}

/** The registered mask sub-panels, in their `order` (100 without one), then
 *  by title. */
export function maskPanelEntries(panels: Record<string, RegisteredPanel>): MaskPanelEntry[] {
  return Object.values(panels)
    .flatMap((p) => (p.mask ? [{ panel: p, mask: p.mask }] : []))
    .map(({ panel, mask }) => ({
      id: panel.id,
      title: panelTitle(panels, panel.id),
      owns: mask.owns,
      component: mask.component,
      extensionParams: mask.owns.some(isMaskBagKey),
      order: mask.order ?? 100,
    }))
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
    .map(({ order: _, ...entry }) => entry);
}

/** React hook: maskPanelEntries of the registry, kept up to date. */
export function useMaskPanels(): MaskPanelEntry[] {
  const panels = useRegistry((s) => s.panels);
  return useMemo(() => maskPanelEntries(panels), [panels]);
}
