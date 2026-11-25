import { describe, expect, test } from "vitest";
import { notesToShow, parseChangelog } from "./changelog";

const SAMPLE = [
  "# Changelog",
  "",
  "All notable changes to Safelight are documented in this file.",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "- **Lens Blur** — a new extension.",
  "",
  "### Planned",
  "- Mobile-responsive viewing",
  "",
  "## [3.2.6] - 2026-11-19",
  "",
  "### Added",
  "- **Sky tool** — paints the sky.",
  "",
  "### Fixed",
  "- **Thumbnails** no longer go black.",
  "- Exports keep their colour.",
  "",
  "## [3.2.5] - 2026-11-14",
  "",
  "### Changed",
  "- Faster imports.",
  "",
  "## [3.2.4] - 2026-11-13",
  "",
  "### Fixed",
  "- A crash on open.",
].join("\r\n");

describe("parseChangelog", () => {
  test("reads each release with its date and groups, newest first, whatever the line endings", () => {
    const releases = parseChangelog(SAMPLE);
    expect(releases.map((r) => [r.version, r.date])).toEqual([
      ["Unreleased", null],
      ["3.2.6", "2026-11-19"],
      ["3.2.5", "2026-11-14"],
      ["3.2.4", "2026-11-13"],
    ]);
    expect(releases[1].groups).toEqual([
      { title: "Added", items: ["**Sky tool** — paints the sky."] },
      { title: "Fixed", items: ["**Thumbnails** no longer go black.", "Exports keep their colour."] },
    ]);
  });

  test("Planned isn't a change, so it's left out", () => {
    expect(parseChangelog(SAMPLE)[0].groups).toEqual([{ title: "Added", items: ["**Lens Blur** — a new extension."] }]);
  });

  test("text that isn't a changelog reads as no releases", () => {
    expect(parseChangelog("")).toEqual([]);
    expect(parseChangelog("# Something else\n\n- a list")).toEqual([]);
  });
});

describe("notesToShow", () => {
  const releases = parseChangelog(SAMPLE);
  const versions = (seen: string | null, current: string) => notesToShow(releases, seen, current).map((r) => r.version);

  test("after an update, every release since the one last seen, newest first", () => {
    expect(versions("3.2.4", "3.2.6")).toEqual(["3.2.6", "3.2.5"]);
  });

  test("with no version on record, only the running version's notes", () => {
    expect(versions(null, "3.2.5")).toEqual(["3.2.5"]);
  });

  test("a build whose own release isn't in the changelog yet shows the unreleased notes as its own", () => {
    const shown = notesToShow(releases, "3.2.6", "3.2.7");
    expect(shown.map((r) => r.version)).toEqual(["3.2.7"]);
    expect(shown[0].groups[0].items).toEqual(["**Lens Blur** — a new extension."]);
  });

  test("nothing new, or a downgrade, shows nothing", () => {
    expect(versions("3.2.6", "3.2.6")).toEqual([]);
    expect(versions("3.2.6", "3.2.5")).toEqual([]);
  });

  test("a release with no notes is skipped", () => {
    const sparse = parseChangelog("## [3.3.0] - 2026-12-01\n\n## [3.2.9] - 2026-11-30\n\n### Fixed\n- One thing.");
    expect(notesToShow(sparse, "3.2.8", "3.3.0").map((r) => r.version)).toEqual(["3.2.9"]);
  });
});
