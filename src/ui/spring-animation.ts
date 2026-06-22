// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Critically-damped spring for smooth pan momentum and zoom transitions.
// Given an initial velocity, returns the position offset at time t that
// decelerates to rest. Critically-damped = fastest settle without overshoot.

export interface Spring {
  /** Position offset at time `t` (seconds since release). */
  position(t: number): number;
  /** Velocity at time `t`. */
  velocity(t: number): number;
  /** True when |velocity| < threshold and |position - target| < threshold. */
  settled(t: number, threshold?: number): boolean;
}

/**
 * Create a critically-damped spring.
 * @param v0 Initial velocity (px/s or scale/s).
 * @param damping Damping coefficient — higher = faster settle. 8-12 for pan, 15-20 for zoom.
 */
export function createSpring(v0: number, damping: number = 10): Spring {
  // Critically-damped: x(t) = (v0 * t) * e^(-d*t)
  // v(t) = v0 * (1 - d*t) * e^(-d*t)
  const d = damping;
  return {
    position(t: number): number {
      return v0 * t * Math.exp(-d * t);
    },
    velocity(t: number): number {
      return v0 * (1 - d * t) * Math.exp(-d * t);
    },
    settled(t: number, threshold = 0.5): boolean {
      const decay = Math.exp(-d * t);
      return Math.abs(v0 * t * decay) < threshold && Math.abs(v0 * (1 - d * t) * decay) < threshold;
    },
  };
}

/**
 * Estimate velocity from the last few pointer positions (px/s).
 * Uses a simple weighted average of the last 3 deltas.
 */
export function estimateVelocity(
  positions: Array<{ x: number; y: number; t: number }>,
): { vx: number; vy: number } {
  if (positions.length < 2) return { vx: 0, vy: 0 };
  const last = positions.length - 1;
  let vx = 0;
  let vy = 0;
  let weight = 0;
  const count = Math.min(3, last);
  for (let i = 0; i < count; i++) {
    const a = positions[last - i - 1];
    const b = positions[last - i];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) continue;
    const w = count - i;
    vx += ((b.x - a.x) / dt) * w;
    vy += ((b.y - a.y) / dt) * w;
    weight += w;
  }
  if (weight === 0) return { vx: 0, vy: 0 };
  return { vx: vx / weight, vy: vy / weight };
}
