// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The working lamp: one cell that breathes between ember and lamp red while
// something is happening. The glyph never changes where colour can do the
// breathing, so nothing jitters.

import type { Look } from "../look";

const CYCLE_MS = 1600;
const FRAME_MS = 240;

/** The lamp at `elapsedMs` into its wait. Still and lit under reduced motion. */
export function lamp(elapsedMs: number, look: Look): string {
  const { glyphs, theme, caps } = look;
  const frames = glyphs.lamp;
  if (caps.motion !== "full") return theme.paint("lamp", frames[Math.floor(frames.length / 2)]);
  const breathes = frames.length === 1 && (theme.tier === "truecolour" || theme.tier === "256");
  if (breathes) return theme.blend("ember", "lamp", (1 - Math.cos((elapsedMs / CYCLE_MS) * 2 * Math.PI)) / 2, frames[0]);
  return theme.paint("lamp", frames[Math.floor(elapsedMs / (FRAME_MS * caps.clockScale)) % frames.length]);
}

export function elapsedText(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.floor((ms - minutes * 60_000) / 1000)} s`;
}

/** "● Starting the engine…  2.1 s": the time shows once a second has gone by. */
export function lampLine(label: string, elapsedMs: number, look: Look): string {
  const { glyphs, theme } = look;
  const text = glyphs.fold(label).replace(/(\.\.\.|…)$/, "") + glyphs.ellipsis;
  const time = elapsedMs >= 1000 ? `  ${theme.paint("muted", elapsedText(elapsedMs))}` : "";
  return `${lamp(elapsedMs, look)} ${text}${time}`;
}
