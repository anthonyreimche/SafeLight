// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The official extensions list (electron/official-extensions.json) is the one
// place that says which ids under "safelight" exist and which repository each
// must come from. The main process reads the same file; its test holds the
// parity table for the id rule.

import { describe, expect, it } from "vitest";
import {
  ACCESSIBILITY_EXTENSION_ID,
  DEVTOOLS_EXTENSION_ID,
  OFFICIAL_EXTENSIONS,
  isOfficialOnlyId,
  manifestIdRefusal,
} from "./official-extensions";

describe("the official extensions list", () => {
  it("has a row for each of the 23 official extensions", () => {
    expect(OFFICIAL_EXTENSIONS).toHaveLength(23);
  });

  it("gives every row its own id under safelight and its own repository", () => {
    const ids = OFFICIAL_EXTENSIONS.map((e) => e.id);
    const repos = OFFICIAL_EXTENSIONS.map((e) => e.repo.toLowerCase());
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(repos).size).toBe(repos.length);
    for (const e of OFFICIAL_EXTENSIONS) {
      expect(e.id).toMatch(/^safelight\.[a-z0-9-]+$/);
      expect(e.repo).toMatch(/^anthonyreimche\/[a-z0-9-]+$/);
    }
  });

  it("replaces built-in ids, each once, and Library and Develop replace none", () => {
    for (const e of OFFICIAL_EXTENSIONS)
      if (e.replaces !== null) expect(e.replaces, e.id).toMatch(/^core\.[a-z-]+$/);
    const replaced = OFFICIAL_EXTENSIONS.map((e) => e.replaces).filter((r) => r !== null);
    expect(new Set(replaced).size).toBe(replaced.length);
    const row = (id: string) => OFFICIAL_EXTENSIONS.find((e) => e.id === id);
    expect(row("safelight.library")?.replaces).toBeNull();
    expect(row("safelight.develop")?.replaces).toBeNull();
  });

  it("names the Accessibility and Developer Tools rows", () => {
    const ids = OFFICIAL_EXTENSIONS.map((e) => e.id);
    expect(ids).toContain(ACCESSIBILITY_EXTENSION_ID);
    expect(ids).toContain(DEVTOOLS_EXTENSION_ID);
  });

  it("makes every row essential but Developer Tools", () => {
    expect(OFFICIAL_EXTENSIONS.filter((e) => !e.essential).map((e) => e.id)).toEqual([
      "safelight.devtools",
    ]);
  });

  it("keeps Accessibility and Developer Tools across layouts, and nothing else", () => {
    expect(
      OFFICIAL_EXTENSIONS.filter((e) => e.keepAcrossLayouts)
        .map((e) => e.id)
        .sort(),
    ).toEqual(["safelight.accessibility", "safelight.devtools"]);
  });
});

describe("isOfficialOnlyId", () => {
  it.each(["safelight", "safelight.basic", "SAFELIGHT", "Safelight.Tools"])(
    "holds %s for the official extensions",
    (id) => {
      expect(isOfficialOnlyId(id)).toBe(true);
    },
  );

  it.each(["safelightx", "safelight-x", "acme.safelight", "my.safelight.basic"])(
    "leaves %s to anyone",
    (id) => {
      expect(isOfficialOnlyId(id)).toBe(false);
    },
  );
});

describe("manifestIdRefusal", () => {
  const officialReason = (id: string) =>
    `${id}: extension ids under 'safelight' are reserved for Safelight's official extensions`;

  it("refuses an id under core, whatever the repository", () => {
    expect(manifestIdRefusal({ id: "core.hsl", repository: "anthonyreimche/hsl" })).toBe(
      "core.hsl: extension ids under 'core' are reserved for Safelight",
    );
  });

  it.each([
    ["safelight.basic", undefined],
    ["safelight.basic", "acme/basic-adjustments"],
    ["safelight.basic", "anthonyreimche/hsl"],
    ["safelight.unlisted", "anthonyreimche/unlisted"],
    ["Safelight.Basic", "anthonyreimche/basic-adjustments"],
  ])("refuses %s from %j", (id, repository) => {
    expect(manifestIdRefusal({ id, repository })).toBe(officialReason(id));
  });

  it("accepts a listed id from its own repository, in any case", () => {
    expect(
      manifestIdRefusal({ id: "safelight.basic", repository: "AnthonyReimche/Basic-Adjustments" }),
    ).toBeNull();
  });

  it("accepts any other id", () => {
    expect(manifestIdRefusal({ id: "acme.widget" })).toBeNull();
  });
});
