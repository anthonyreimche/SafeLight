// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Motion fills waiting; it never causes it. There is one clock for everything
// that moves, it never keeps the process alive, and it stops when nothing is
// animating. The last frame of anything is exactly its static render.

import type { Capabilities } from "./capabilities";

export const LAMP_TICK_MS = 80;
export const TWEEN_TICK_MS = 30;
/** How often live things redraw under reduced motion. */
export const REDUCED_TICK_MS = 1000;
export const TWEEN_MS = 180;
export const WARM_UP_MS = 320;
export const WARM_UP_FRAMES = 8;
/** A wait shorter than this shows nothing at all. */
export const LAMP_AFTER_MS = 150;

export const easeOutCubic = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

export function tickFor(base: number, caps: Pick<Capabilities, "motion" | "clockScale">): number {
  return caps.motion === "full" ? base * caps.clockScale : REDUCED_TICK_MS;
}

export interface Timers {
  now(): number;
  /** `hold` keeps the process alive until it fires, for motion something is waiting on. */
  set(run: () => void, ms: number, hold: boolean): unknown;
  clear(handle: unknown): void;
}

const REAL: Timers = {
  now: () => Date.now(),
  set(run, ms, hold) {
    const handle = setTimeout(run, ms);
    if (!hold) handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Clock {
  /** Calls `tick` every `ms` until the returned function is called. `hold` keeps the process alive meanwhile. */
  every(ms: number, tick: (now: number) => void, hold?: boolean): () => void;
  now(): number;
  readonly running: boolean;
}

export function createClock(timers: Timers = REAL): Clock {
  interface Beat { ms: number; due: number; tick: (now: number) => void; hold: boolean }
  const beats = new Set<Beat>();
  let handle: unknown;

  const schedule = (): void => {
    if (handle !== undefined) timers.clear(handle);
    handle = undefined;
    if (beats.size === 0) return;
    const next = Math.min(...[...beats].map((beat) => beat.due));
    handle = timers.set(fire, Math.max(0, next - timers.now()), [...beats].some((beat) => beat.hold));
  };
  const fire = (): void => {
    handle = undefined;
    const now = timers.now();
    for (const beat of [...beats]) {
      if (beat.due > now || !beats.has(beat)) continue;
      beat.due = now + beat.ms;
      beat.tick(now);
    }
    schedule();
  };

  return {
    every(ms, tick, hold = false) {
      const beat: Beat = { ms, due: timers.now() + ms, tick, hold };
      beats.add(beat);
      schedule();
      return () => {
        if (beats.delete(beat)) schedule();
      };
    },
    now: () => timers.now(),
    get running() {
      return beats.size > 0;
    },
  };
}

/** The one clock. */
export const clock: Clock = createClock();
