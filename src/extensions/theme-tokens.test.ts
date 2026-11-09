// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension chrome takes its accent text, error and status colours from theme
// tokens, so a theme or overlay recolours them in one place.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

const ACCENT_FILES = [
  "ui-kit.tsx",
  "ExtensionDetail.tsx",
  "ExtensionManagerPanel.tsx",
  "KitPage.tsx",
  "StoreCards.tsx",
  "StoreRail.tsx",
];

const ERROR_FILES = [
  "dock/DockHost.tsx",
  "Slot.tsx",
  "devtools/DevExtensionsTab.tsx",
  "devtools/DevFolderControls.tsx",
  "devtools/DevToolsWindowHost.tsx",
];

describe("extension theme tokens", () => {
  it.each(ACCENT_FILES)("%s puts text-on-accent on accent fills", (file) => {
    const src = read(file);
    expect(src).not.toMatch(/bg-slider-fill[^"'`]*text-white/);
    expect(src).toMatch(/text-on-accent/);
  });

  it.each([...ACCENT_FILES, ...ERROR_FILES])("%s has no raw red or emerald palette colours", (file) => {
    expect(read(file)).not.toMatch(/\b(?:red|emerald)-\d{3}\b/);
  });

  it.each(ERROR_FILES)("%s uses text-danger", (file) => {
    expect(read(file)).toMatch(/text-danger/);
  });

  it("the dev Loaded badge uses the green label token", () => {
    expect(read("devtools/DevExtensionsTab.tsx")).toMatch(/bg-label-green\/20 text-label-green/);
  });

  it("the dev error line wraps long paths", () => {
    expect(read("devtools/DevExtensionsTab.tsx")).toMatch(/break-words[^"]*">\{item\.error\}/);
  });
});
