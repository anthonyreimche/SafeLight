// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Chips over photos sit on a fixed dark scrim, so their text comes from the
// on-media tokens, not the theme's text colours (dark in the Light theme). The
// stale-review badge uses the label palette's yellow. The Light theme carries
// its own curve and histogram colours, and both editors read them again when
// high contrast changes.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

const CHART_KEYS = [
  "--curve-rgb",
  "--curve-grid",
  "--curve-identity",
  "--curve-ring",
  "--curve-ring-focused",
  "--curve-point",
  "--histogram-curve",
  "--histogram-grid",
  "--histogram-zone",
  "--histogram-label",
  "--histogram-clip-shadow",
  "--histogram-clip-highlight",
  "--histogram-clip-shadow-active",
  "--histogram-clip-highlight-active",
  "--histogram-clip-shadow-bg",
  "--histogram-clip-highlight-bg",
];

describe("text on photo chips", () => {
  it.each(["Thumbnail.tsx", "StackBadge.tsx", "../../modules/welcome/WelcomeView.tsx"])(
    "%s takes chip text from the on-media tokens",
    (file) => {
      const src = read(file);
      expect(src).not.toMatch(/bg-black\/\d+[^"'`]*text-text-(?:primary|secondary)/);
      expect(src).not.toMatch(/hover:text-white/);
      expect(src).toMatch(/text-on-media/);
    },
  );

  it("index.css defines the tokens", () => {
    const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
    expect(css).toMatch(/--color-on-media:\s*#/);
    expect(css).toMatch(/--color-on-media-muted:\s*#/);
  });
});

describe("the stale-review badge", () => {
  it("uses the label yellow and no hard-coded fallbacks", () => {
    const src = read("../../extensions/TrustBadges.tsx");
    expect(src).not.toMatch(/label-amber|#c77f00|#27ae60/);
    expect(src).toMatch(/var\(--color-label-yellow\)/);
  });
});

describe("curve and histogram colours", () => {
  it("the Light theme sets every one", () => {
    const src = read("../../extensions/builtin.tsx");
    const light = src.slice(src.indexOf('id: "core.light"'));
    const block = light.slice(0, light.indexOf("});"));
    for (const key of CHART_KEYS) expect(block).toContain(`"${key}":`);
  });

  it.each(["CurveEditor.tsx", "Histogram.tsx"])("%s reads them again when high contrast changes", (file) => {
    expect(read(file)).toMatch(/useMemo\(\(\) => readPalette\(\), \[themeId, highContrast\]\)/);
  });
});
