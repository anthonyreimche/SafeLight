// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Text on an accent fill comes from the --color-on-accent token, so a theme
// with a light accent can flip it instead of getting unreadable white.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

describe("text on accent fills", () => {
  it.each(["TopBar.tsx", "ModuleView.tsx", "EssentialsNotice.tsx", "Select.tsx", "ConfirmDialog.tsx"])(
    "%s uses text-on-accent, not text-white",
    (file) => {
      const src = read(file);
      expect(src).not.toMatch(/text-white/);
      expect(src).toMatch(/text-on-accent/);
    },
  );

  it.each([
    "../../modules/library/CopySettingsDialog.tsx",
    "../../modules/library/RenamePhotoDialog.tsx",
    "../../modules/export/ResolutionControl.tsx",
    "../../modules/welcome/WelcomeView.tsx",
    "../../modules/welcome/setup/SetupParts.tsx",
    "../preferences/fields.tsx",
    "../preferences/sections/Shortcuts.tsx",
    "../preferences/sections/LayoutField.tsx",
    "../preferences/sections/Updates.tsx",
    "../../update/UpdateBanner.tsx",
  ])("%s puts text-on-accent on accent fills", (file) => {
    const src = read(file);
    expect(src).not.toMatch(/bg-(?:slider-fill|\[var\(--color-accent\)\])[^"'`]*text-white/);
    expect(src).toMatch(/text-on-accent/);
  });

  it.each(["../../modules/welcome/WelcomeView.tsx", "../../modules/welcome/setup/SetupParts.tsx"])(
    "%s primary keeps its emphasis on hover",
    (file) => {
      expect(read(file)).not.toMatch(/bg-slider-fill[^"'`]*hover:bg-surface-4/);
    },
  );

  it("DevelopCanvas error text uses the danger token", () => {
    expect(read("../../modules/develop/DevelopCanvas.tsx")).not.toMatch(/red-400/);
  });

  it("DisplayProfileField hint uses Canadian spelling", () => {
    expect(read("../preferences/sections/DisplayProfileField.tsx")).not.toContain("colors are converted");
  });

  it("index.css defines the token", () => {
    expect(readFileSync(new URL("../../index.css", import.meta.url), "utf8")).toMatch(
      /--color-on-accent:\s*#ffffff/,
    );
  });
});
