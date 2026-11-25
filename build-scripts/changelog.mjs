// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Release steps for docs/user/changelog.md, run by the milestone release:
//   node build-scripts/changelog.mjs stamp <version> [date]   [Unreleased] becomes the release
//   node build-scripts/changelog.mjs notes <version>          prints the release's notes
// The app bundles the changelog, so a release's section must exist before its
// tag is cut, or that build has no notes of its own to show.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const UNRELEASED = "## [Unreleased]";
/** Plans for later stay under Unreleased; they aren't part of a release. */
const KEEP_UNRELEASED = ["Planned"];

const bare = (version) => String(version).replace(/^v/i, "");
const isRelease = (line) => /^## \[/.test(line);

/** The lines of one "## [...]" section, heading excluded, or null. */
function section(lines, heading) {
  const start = lines.findIndex((l) => l === heading || l.startsWith(`${heading} -`));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && isRelease(l));
  if (end < 0) end = lines.length;
  return { start, end, body: lines.slice(start + 1, end) };
}

/** Splits a section body into its "### " groups, each with its lines. */
function groups(body) {
  const out = [];
  for (const line of body) {
    if (line.startsWith("### ")) out.push({ title: line.slice(4).trim(), lines: [line] });
    else if (out.length) out[out.length - 1].lines.push(line);
  }
  for (const g of out) while (g.lines.length && g.lines[g.lines.length - 1].trim() === "") g.lines.pop();
  return out;
}

const blockOf = (gs) => gs.flatMap((g) => [...g.lines, ""]);

/** The changelog with [Unreleased]'s changes moved into "## [version] - date"
 *  and a fresh [Unreleased] keeping only the plans. A version that already has
 *  a section is returned unchanged. */
export function stampRelease(source, version, date) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const v = bare(version);
  if (section(lines, `## [${v}]`)) return source;
  const unreleased = section(lines, UNRELEASED);
  if (!unreleased) throw new Error(`The changelog has no ${UNRELEASED} section.`);

  const all = groups(unreleased.body);
  const kept = all.filter((g) => KEEP_UNRELEASED.includes(g.title));
  const released = all.filter((g) => !KEEP_UNRELEASED.includes(g.title) && g.lines.some((l) => l.startsWith("- ")));
  if (!released.length) throw new Error(`${UNRELEASED} has no changes to release as ${v}.`);

  const replacement = [UNRELEASED, "", ...blockOf(kept), `## [${v}] - ${date}`, "", ...blockOf(released)];
  return [...lines.slice(0, unreleased.start), ...replacement, ...lines.slice(unreleased.end)].join(eol);
}

/** The body of one release's section, trimmed, with "\n" line ends, or null. */
export function releaseNotes(source, version) {
  const found = section(source.split(/\r?\n/), `## [${bare(version)}]`);
  if (!found) return null;
  return found.body.join("\n").trim();
}

const run = () => {
  const [command, version, date = new Date().toISOString().slice(0, 10)] = process.argv.slice(2);
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "user", "changelog.md");
  const source = readFileSync(file, "utf8");
  if (command === "stamp" && version) {
    const next = stampRelease(source, version, date);
    if (next !== source) writeFileSync(file, next);
    console.log(next === source ? `The changelog already has ${bare(version)}.` : `Stamped ${bare(version)} (${date}).`);
  } else if (command === "notes" && version) {
    const notes = releaseNotes(source, version);
    if (notes === null) throw new Error(`The changelog has no section for ${bare(version)}.`);
    process.stdout.write(`${notes}\n`);
  } else {
    throw new Error("Usage: changelog.mjs stamp <version> [date] | notes <version>");
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    run();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
