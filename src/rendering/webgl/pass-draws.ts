// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { PrepassPass } from "./stage-injection";

type PassCount = Pick<PrepassPass, "iterations" | "drawCount">;

/** How many times a pass draws this frame: its fixed count, or its bag value
 *  (the uniform's default while the bag holds no finite number) rounded and
 *  clamped to [0, max]. */
export function passDraws(pass: PassCount, params: Readonly<Record<string, unknown>>): number {
  const count = pass.drawCount;
  if (!count) return pass.iterations;
  const raw = params[count.qualifiedKey];
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : count.fallback;
  return Math.min(count.max, Math.max(0, Math.round(value)));
}

/** Every draw a stage's passes take this frame. 0 means the stage has nothing
 *  to run, and the renderer handles it as an idle stage. */
export function stageDraws(
  stage: { readonly passes: readonly PassCount[] },
  params: Readonly<Record<string, unknown>>,
): number {
  let draws = 0;
  for (const pass of stage.passes) draws += passDraws(pass, params);
  return draws;
}
