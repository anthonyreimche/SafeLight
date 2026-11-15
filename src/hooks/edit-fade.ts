// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { QUICK_REPEAT_MS } from "@/ui/motion";

// When the develop canvas eases into a new look of the same photo rather than
// cutting to it. Discrete edits (DevelopState.discreteEdits) and the Presets hover
// arm a fade; any other change of what is drawn is a live write (a drag, a mask
// stroke, the histogram drag), which must follow the hand at once, and disarms it.
//
// The fade is taken by frame seq, not by the next frame to arrive: a render already
// in flight when the edit landed draws the look before, and easing into that frame
// would end on the old picture and then cut to the new one.

/** How long a discrete edit eases in. */
export const DISCRETE_FADE_MS = 140;
/** How long the Presets hover eases a look in and out. */
export const PREVIEW_FADE_MS = 220;
// A discrete edit within QUICK_REPEAT_MS of the one before cuts, so a held Ctrl+Z steps
// through the history instead of smearing it; sliders follow the same rule (motion.ts).
export { QUICK_REPEAT_MS };

export interface EditFade {
  /** A discrete edit landed with `after` the seq of the last render posted. Arms a
   *  fade unless it came within QUICK_REPEAT_MS of the last one, which disarms it.
   *  Returns whether it armed. */
  discrete(after: number, now?: number): boolean;
  /** The Presets hover turned on, off, or to another preset. */
  preview(after: number): void;
  /** Something else changed what is drawn. */
  live(): void;
  /** The fade length for frame `seq`, once: the first frame of a render posted after
   *  the arming takes it. null, none. */
  take(seq: number): number | null;
  /** A photo starts to load: its first picture cuts. */
  clear(): void;
}

export function createEditFade(): EditFade {
  let armed: { after: number; ms: number } | null = null;
  let lastDiscreteAt = Number.NEGATIVE_INFINITY;
  return {
    discrete(after, now = performance.now()) {
      const quick = now - lastDiscreteAt < QUICK_REPEAT_MS;
      lastDiscreteAt = now;
      armed = quick ? null : { after, ms: DISCRETE_FADE_MS };
      return !quick;
    },
    preview(after) {
      armed = { after, ms: PREVIEW_FADE_MS };
    },
    live() {
      armed = null;
    },
    take(seq) {
      if (!armed || seq <= armed.after) return null;
      const { ms } = armed;
      armed = null;
      return ms;
    },
    clear() {
      armed = null;
    },
  };
}
