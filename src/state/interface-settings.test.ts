// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Interface scale steps and the interface font list, shared by Preferences
// and the welcome setup. Scale moves on a 10% grid between 80% and 200%; an
// in-between value left by the old 5% slider moves to the next stop.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canStepUiScale,
  DEFAULT_UI_FONT_STACK,
  stepUiScale,
  UI_FONT_PRESETS,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
} from "./settings-store";

describe("stepUiScale", () => {
  it.each([
    [1, 1, 1.1],
    [1, -1, 0.9],
    [1.1, 1, 1.2],
    [1.1, -1, 1],
    [1.05, 1, 1.1],
    [1.05, -1, 1],
    [1.95, 1, 2],
    [0.85, -1, 0.8],
  ] as const)("steps %d by %d to %d", (value, direction, expected) => {
    expect(stepUiScale(value, direction)).toBe(expected);
  });

  it("stays between 80% and 200%", () => {
    expect(stepUiScale(UI_SCALE_MAX, 1)).toBe(2);
    expect(stepUiScale(UI_SCALE_MIN, -1)).toBe(0.8);
    expect(stepUiScale(2.5, -1)).toBe(2);
    expect(stepUiScale(0.5, 1)).toBe(0.8);
  });

  it("walks the whole range in ten-percent stops", () => {
    const seen = [UI_SCALE_MIN];
    let value = UI_SCALE_MIN;
    while (canStepUiScale(value, 1)) {
      value = stepUiScale(value, 1);
      seen.push(value);
    }
    expect(seen).toEqual([
      0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2,
    ]);
  });
});

describe("canStepUiScale", () => {
  it("allows a step until the matching end of the range", () => {
    expect(canStepUiScale(1, 1)).toBe(true);
    expect(canStepUiScale(1, -1)).toBe(true);
    expect(canStepUiScale(2, 1)).toBe(false);
    expect(canStepUiScale(0.8, -1)).toBe(false);
    expect(canStepUiScale(2, -1)).toBe(true);
    expect(canStepUiScale(0.8, 1)).toBe(true);
  });
});

describe("interface font", () => {
  it("offers the built-in font first, as the empty value", () => {
    expect(UI_FONT_PRESETS[0]).toEqual({ value: "", label: "Afacad (default)" });
    expect(UI_FONT_PRESETS.map((f) => f.label)).toEqual([
      "Afacad (default)",
      "JetBrains Mono",
      "System Sans",
      "Inter",
      "Serif",
    ]);
  });

  it("keeps the default stack in step with index.css", () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "index.css"),
      "utf8",
    );
    const declared = css.match(/--font-mono:\s*([^;]+);/)?.[1];
    expect(declared?.replace(/\s+/g, " ").trim()).toBe(DEFAULT_UI_FONT_STACK);
  });
});
