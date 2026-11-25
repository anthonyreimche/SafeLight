import { describe, expect, test } from "vitest";
import { releaseNotes, stampRelease } from "./changelog.mjs";

const BEFORE = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "- **Lens Blur** — a new extension.",
  "",
  "### Fixed",
  "- A crash.",
  "",
  "### Planned",
  "- Mobile-responsive viewing",
  "",
  "## [3.2.6] - 2026-11-19",
  "",
  "### Fixed",
  "- Old fix.",
  "",
].join("\n");

describe("stampRelease", () => {
  test("the unreleased changes become the release, and a fresh Unreleased keeps the plans", () => {
    expect(stampRelease(BEFORE, "3.2.7", "2026-11-24")).toBe(
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "### Planned",
        "- Mobile-responsive viewing",
        "",
        "## [3.2.7] - 2026-11-24",
        "",
        "### Added",
        "- **Lens Blur** — a new extension.",
        "",
        "### Fixed",
        "- A crash.",
        "",
        "## [3.2.6] - 2026-11-19",
        "",
        "### Fixed",
        "- Old fix.",
        "",
      ].join("\n"),
    );
  });

  test("a version that already has its section is left alone, so a re-run changes nothing", () => {
    const once = stampRelease(BEFORE, "3.2.7", "2026-11-24");
    expect(stampRelease(once, "3.2.7", "2026-11-25")).toBe(once);
  });

  test("CRLF files stay CRLF", () => {
    const crlf = BEFORE.replace(/\n/g, "\r\n");
    const out = stampRelease(crlf, "3.2.7", "2026-11-24");
    expect(out.includes("\r\n## [3.2.7] - 2026-11-24\r\n")).toBe(true);
    expect(out.replace(/\r\n/g, "")).not.toMatch(/\n/);
  });

  test("with nothing unreleased there is nothing to stamp", () => {
    const empty = "# Changelog\n\n## [Unreleased]\n\n### Planned\n- Later\n\n## [3.2.6] - 2026-11-19\n";
    expect(() => stampRelease(empty, "3.2.7", "2026-11-24")).toThrow("[Unreleased] has no changes to release as 3.2.7.");
  });
});

describe("releaseNotes", () => {
  test("the body of one release's section, for the GitHub Release", () => {
    const stamped = stampRelease(BEFORE, "3.2.7", "2026-11-24");
    expect(releaseNotes(stamped, "3.2.7")).toBe("### Added\n- **Lens Blur** — a new extension.\n\n### Fixed\n- A crash.");
    expect(releaseNotes(stamped, "v3.2.6")).toBe("### Fixed\n- Old fix.");
  });

  test("a version with no section has no notes", () => {
    expect(releaseNotes(BEFORE, "9.9.9")).toBeNull();
  });
});
