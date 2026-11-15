// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The app's motion timings, for animation driven from script. CSS uses the same
// values through the sl-enter-* and sl-breathe classes in index.css.

/** A small change answering a click: a panel opening, a value settling. */
export const MOTION_FAST_MS = 120;
/** Something appearing or a picture changing. */
export const MOTION_MS = 150;
export const EASE_OUT = "cubic-bezier(0.2, 0, 0, 1)";
/** How long a wait lasts before it earns an indicator. */
export const WAIT_INDICATOR_DELAY_MS = 300;
/** How soon after a discrete change a control still counts it as the cause of a
 *  value it is handed. */
export const DISCRETE_WINDOW_MS = 100;
/** A discrete change this soon after the one before is a quick repeat (a held
 *  Ctrl+Z): the canvas cuts to it, and controls follow it at once rather than trail. */
export const QUICK_REPEAT_MS = 150;

let lastDiscreteAt = Number.NEGATIVE_INFINITY;
let previousDiscreteAt = Number.NEGATIVE_INFINITY;

/** Marks a jump to a known end state (undo, redo, reset, a preset), as opposed to a
 *  live write (a drag, the histogram drag, a colour-wheel puck), so controls showing
 *  the values can ease to them instead of following live input. */
export function noteDiscreteChange(now: number = performance.now()): void {
  previousDiscreteAt = lastDiscreteAt;
  lastDiscreteAt = now;
}

/** Whether a discrete change was noted within the last DISCRETE_WINDOW_MS, and wasn't
 *  a quick repeat of the one before. */
export function recentDiscreteChange(now: number = performance.now()): boolean {
  return now - lastDiscreteAt <= DISCRETE_WINDOW_MS && lastDiscreteAt - previousDiscreteAt >= QUICK_REPEAT_MS;
}
