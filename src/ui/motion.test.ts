// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The shared enter and wait animations live in index.css. Each must exist, none may
// animate `transform` (a dialog moved by an inline transform would snap back to the
// centre while it plays), and Reduce motion must still stop them all.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DISCRETE_WINDOW_MS, QUICK_REPEAT_MS, noteDiscreteChange, recentDiscreteChange } from "./motion";

const css = readFileSync(path.resolve(__dirname, "../index.css"), "utf-8");

function keyframes(name: string): string | null {
  const start = css.indexOf(`@keyframes ${name} `);
  if (start < 0) return null;
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  return null;
}

describe("motion keyframes", () => {
  const names = ["sl-enter-fade", "sl-enter-pop", "sl-enter-rise", "sl-breathe", "sl-indeterminate", "sl-dot"];

  it.each(names)("%s is defined", (name) => {
    expect(keyframes(name)).not.toBeNull();
  });

  it.each(names)("%s never animates transform", (name) => {
    expect(keyframes(name)).not.toMatch(/\btransform\s*:/);
  });

  it.each(["sl-enter-fade", "sl-enter-pop", "sl-enter-rise", "sl-breathe", "sl-dots"])(
    "the .%s class is defined",
    (cls) => {
      expect(css).toMatch(new RegExp(`\\.${cls}\\s*[{,>]`));
    },
  );

  // A dialogue backdrop fades its dim colour: an opacity effect on it would make it
  // the backdrop root of the dialogue, and a glass theme's frost would turn opaque.
  it("sl-enter-dim fades the background colour only, never opacity", () => {
    const frames = keyframes("sl-enter-dim");
    expect(frames).toMatch(/background-color:\s*transparent/);
    expect(frames).not.toMatch(/\bopacity\s*:/);
    expect(css).toMatch(/\.sl-enter-dim\s*\{/);
  });

  // Filled forwards, a finished opacity animation still counts as an opacity effect,
  // so everything inside the element keeps it as their backdrop root. The end state
  // is the element's own value anyway, so nothing needs to fill past the end.
  it.each(["sl-enter-fade", "sl-enter-pop", "sl-enter-rise", "sl-enter-expand", "sl-enter-dim"])(
    "the .%s animation leaves nothing behind once it ends",
    (cls) => {
      const rule = css.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(rule).toMatch(/animation:[^;]*\bbackwards\b/);
      expect(rule).not.toMatch(/animation:[^;]*\b(both|forwards)\b/);
    },
  );

  it("Reduce motion still stops every animation and transition", () => {
    expect(css).toMatch(/\.sl-reduce-motion \*,[\s\S]*?animation: none !important;[\s\S]*?transition: none !important;/);
  });

  it("a breathing skeleton rests at a visible opacity under Reduce motion", () => {
    expect(css).toMatch(/\.sl-reduce-motion \.sl-breathe\s*\{[^}]*opacity:\s*0?\.6/);
  });
});

// A held Ctrl+Z steps the history every few tens of ms: the canvas cuts after the first
// step, so a slider gliding 120 ms on each would trail it.
describe("recentDiscreteChange", () => {
  it("holds just after a discrete change, and not once the window has passed", () => {
    noteDiscreteChange(10_000);
    expect(recentDiscreteChange(10_000 + DISCRETE_WINDOW_MS)).toBe(true);
    expect(recentDiscreteChange(10_000 + DISCRETE_WINDOW_MS + 1)).toBe(false);
  });

  it("doesn't hold for a change noted within QUICK_REPEAT_MS of the one before", () => {
    noteDiscreteChange(20_000);
    noteDiscreteChange(20_000 + QUICK_REPEAT_MS - 1);
    expect(recentDiscreteChange(20_000 + QUICK_REPEAT_MS)).toBe(false);
    noteDiscreteChange(20_000 + 2 * QUICK_REPEAT_MS - 2);
    expect(recentDiscreteChange(20_000 + 2 * QUICK_REPEAT_MS - 1)).toBe(false);
  });

  it("holds again for a change after a rest", () => {
    noteDiscreteChange(30_000);
    noteDiscreteChange(30_000 + 50);
    noteDiscreteChange(30_000 + 50 + QUICK_REPEAT_MS);
    expect(recentDiscreteChange(30_000 + 50 + QUICK_REPEAT_MS + 1)).toBe(true);
  });
});
