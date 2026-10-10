// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The store's version rules: what the picker lists, which notes "What's new"
// spans, what a chosen release is blocked by, and when a choice is kept.

import { describe, expect, it } from "vitest";
import type { ExtensionRelease } from "./types";
import {
  keepAfterInstall,
  keepsVersion,
  latestFull,
  releaseBlock,
  releasesBetween,
  versionChoices,
} from "./release-picks";

const r = (version: string, prerelease = false): ExtensionRelease => ({
  version,
  tag: `v${version}`,
  prerelease,
  publishedAt: "",
  notes: `Notes for ${version}`,
  htmlUrl: "",
});
const list = [
  r("1.4.0-beta.2", true),
  r("1.4.0-beta.1", true),
  r("1.3.0"),
  r("1.3.0-beta.1", true),
  r("1.2.0"),
  r("1.1.0"),
];
const versions = (rs: ExtensionRelease[]) => rs.map((x) => x.version);

describe("latestFull", () => {
  it("is the highest full release", () => {
    expect(latestFull(list)?.version).toBe("1.3.0");
    expect(latestFull([r("2.0.0-rc.1", true)])).toBeNull();
  });
});

describe("versionChoices", () => {
  it("lists newer pre-releases, then Latest, then older versions", () => {
    expect(versionChoices(list, "1.2.0")).toEqual([
      { value: "1.4.0-beta.2", label: "1.4.0-beta.2 (pre-release)" },
      { value: "1.4.0-beta.1", label: "1.4.0-beta.1 (pre-release)" },
      { value: "latest", label: "Latest (1.3.0)" },
      { value: "1.3.0-beta.1", label: "1.3.0-beta.1 (pre-release)" },
      { value: "1.2.0", label: "1.2.0 · installed" },
      { value: "1.1.0", label: "1.1.0" },
    ]);
  });

  it("marks Latest when it is installed", () => {
    expect(versionChoices([r("1.3.0"), r("1.2.0")], "1.3.0")[0]).toEqual({
      value: "latest",
      label: "Latest (1.3.0) · installed",
    });
  });
});

describe("releasesBetween", () => {
  it("spans the installed version to the target, newest first", () => {
    expect(versions(releasesBetween(list, "1.1.0", "1.3.0"))).toEqual(["1.3.0", "1.2.0"]);
  });

  it("includes pre-releases only on the way to a pre-release", () => {
    expect(versions(releasesBetween(list, "1.3.0", "1.4.0-beta.2"))).toEqual([
      "1.4.0-beta.2",
      "1.4.0-beta.1",
    ]);
  });

  it("caps the list at five", () => {
    const many = ["1.6.0", "1.5.0", "1.4.0", "1.3.0", "1.2.0", "1.1.0", "1.0.0"].map((v) => r(v));
    expect(versions(releasesBetween(many, "1.0.0", "1.6.0"))).toEqual([
      "1.6.0",
      "1.5.0",
      "1.4.0",
      "1.3.0",
      "1.2.0",
    ]);
  });

  it("shows just the target when nothing is installed", () => {
    expect(versions(releasesBetween(list, null, "1.3.0"))).toEqual(["1.3.0"]);
  });
});

describe("releaseBlock", () => {
  it("explains a release this build can't run", () => {
    expect(releaseBlock("2.0.0", { version: "2.0.0", minAppVersion: "99.0.0" }, "3.0.0")).toBe(
      "Needs Safelight 99.0.0 or newer",
    );
  });

  it("explains a release whose manifest disagrees with its tag", () => {
    expect(releaseBlock("2.0.0", { version: "1.9.0" }, "3.0.0")).toBe(
      "This release's safelight.json says 1.9.0",
    );
  });

  it("lets a good or unknown release through", () => {
    expect(releaseBlock("2.0.0", { version: "2.0.0", minAppVersion: "2.0.0" }, "3.0.0")).toBeNull();
    expect(releaseBlock("2.0.0", null, "3.0.0")).toBeNull();
  });
});

describe("keeping a version", () => {
  it("keeps only versions older than the latest full release", () => {
    expect(keepsVersion("1.2.0", "1.3.0")).toBe(true);
    expect(keepsVersion("1.3.0-beta.1", "1.3.0")).toBe(true);
    expect(keepsVersion("1.3.0", "1.3.0")).toBe(false);
    expect(keepsVersion("1.4.0-beta.1", "1.3.0")).toBe(false);
    expect(keepsVersion("1.2.0", null)).toBe(false);
  });

  it("decides what an install keeps", () => {
    expect(keepAfterInstall("1.2.0", list)).toBe("1.2.0");
    expect(keepAfterInstall("1.4.0-beta.1", list)).toBeNull();
    expect(keepAfterInstall(undefined, list)).toBeNull();
    expect(keepAfterInstall("1.2.0", null)).toBeNull();
  });
});
