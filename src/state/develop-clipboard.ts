// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The "copy develop settings" clipboard, populated from the Library's right-click
// Copy dialog (the same preset checkboxes used when saving a preset) and consumed
// by Paste. A tiny zustand store rather than a plain module so the Paste menu item
// reactively enables once something has been copied. Session-only, like an OS
// clipboard — not persisted.

import { create } from "zustand";
import type { DevelopParams } from "@/catalog/types";

export interface DevelopClipboard {
  /** Only the adjustments chosen at copy time; merged over each target on paste
   *  (Lightroom-style partial copy). */
  params: Partial<DevelopParams>;
  /** Extension-contributed stage params (e.g. denoise), copied whole when the
   *  "Extension stages" box is checked; merged over the target's bag on paste. */
  paramBag: Record<string, unknown>;
  /** Source photo filename, shown in the menu/tooltip so the user knows what's
   *  on the clipboard. */
  sourceName: string;
  /** Number of adjustments copied, for the menu label. */
  fieldCount: number;
}

interface DevelopClipboardState {
  clipboard: DevelopClipboard | null;
  copy: (clip: DevelopClipboard) => void;
  clear: () => void;
}

export const useDevelopClipboard = create<DevelopClipboardState>((set) => ({
  clipboard: null,
  copy: (clipboard) => set({ clipboard }),
  clear: () => set({ clipboard: null }),
}));
