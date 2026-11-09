// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Where auto-update looks for an installed extension's next release.

import { afterEach, describe, expect, it } from "vitest";
import { readSources, rememberSource, repoFor, updateRepoFor } from "./sources";
import type { ExtensionManifest } from "./types";

const manifest = (id: string, repository?: string): ExtensionManifest => ({
  id,
  name: id,
  version: "1.0.0",
  main: "dist/index.js",
  ...(repository ? { repository } : {}),
});

afterEach(() => localStorage.clear());

describe("stored sources that are not a string map", () => {
  it("reads a stored null as empty and still falls back to the declared repository", () => {
    localStorage.setItem("sl_ext_sources", "null");
    expect(readSources()).toEqual({});
    expect(repoFor(manifest("acme.widget", "acme/widget"))).toBe("acme/widget");
    expect(repoFor(manifest("acme.widget"))).toBeNull();
  });

  it("reads an array or a number as empty", () => {
    localStorage.setItem("sl_ext_sources", "[1,2]");
    expect(readSources()).toEqual({});
    localStorage.setItem("sl_ext_sources", "7");
    expect(readSources()).toEqual({});
  });

  it("keeps only the entries whose value is a string", () => {
    localStorage.setItem("sl_ext_sources", JSON.stringify({ "x.y": 5, "a.b": "Owner/Repo" }));
    expect(readSources()).toEqual({ "a.b": "Owner/Repo" });
  });
});

describe("updateRepoFor", () => {
  it("updates an official extension from the repository core lists for it", () => {
    expect(updateRepoFor(manifest("safelight.crop", "anthonyreimche/crop-and-straighten"))).toBe(
      "anthonyreimche/crop",
    );
  });

  it("keeps updating it from there when it was installed from that repository", () => {
    rememberSource("safelight.basic", "anthonyreimche/Basic");
    expect(updateRepoFor(manifest("safelight.basic", "anthonyreimche/basic-adjustments"))).toBe(
      "anthonyreimche/basic",
    );
  });

  it("updates any other extension from the repository it declares", () => {
    expect(updateRepoFor(manifest("acme.widget", "acme/widget"))).toBe("acme/widget");
  });

  it("never updates one whose remembered source differs from the repository it declares", () => {
    rememberSource("acme.widget", "evil/widget");
    expect(updateRepoFor(manifest("acme.widget", "acme/widget"))).toBeNull();
  });
});
