// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The issue body Report an issue sends, and the prefilled new-issue link.
// Diagnostics sit between marker comments so the triage workflow can strip
// them before keyword labelling; nothing outside the markers may use its
// keywords. GitHub refuses links much past 8 KB, so fitReportToUrl trims the
// body to a budget, oldest errors first; Copy report always has everything.

import { REPO } from "@/update/update-checker";

export type SectionId = "crash" | "environment" | "graphics" | "extensions" | "context" | "errors";

export interface ReportSection {
  id: SectionId;
  label: string;
  /** One line for the dialog row; not part of the report. */
  summary: string;
  /** Exactly what goes in the report. */
  text: string;
  include: boolean;
  /** Shown under the section, e.g. how many entries were left out. */
  note?: string;
}

export interface ReportInput {
  title: string;
  description: string;
  sections: readonly ReportSection[];
  appVersion: string;
  /** A screenshot was put on the clipboard for the user to paste. */
  screenshot: boolean;
  /** "Ctrl+V" or "⌘V". */
  pasteKey: string;
}

export interface FittedReport {
  url: string;
  body: string;
  fits: boolean;
  omittedEntries: number;
  cutSections: SectionId[];
  cutDescription: boolean;
}

export const DIAG_START = "<!-- safelight:diagnostics -->";
export const DIAG_END = "<!-- /safelight:diagnostics -->";
export const NEW_ISSUE_URL = `https://github.com/${REPO}/issues/new`;
export const SECURITY_URL = `https://github.com/${REPO}/security/policy`;
export const ISSUE_URL_BUDGET = 7500;
export const MAX_TITLE = 256;
export const CUT_ORDER: readonly SectionId[] = ["extensions", "context", "graphics", "crash", "environment"];

const CUT_NOTE = "cut to fit the link — Copy report in Safelight has the full text.";

export function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

export function splitEntries(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
}

const shown = (s: ReportSection): boolean => s.include && (s.text.trim() !== "" || Boolean(s.note));

function renderSection(s: ReportSection): string {
  const parts = [`**${s.label}**`];
  const text = s.text.trimEnd();
  if (text.trim()) {
    const fence = fenceFor(text);
    parts.push(`${fence}text\n${text}\n${fence}`);
  }
  if (s.note) parts.push(`_(${s.note})_`);
  return parts.join("\n\n");
}

export function renderReport(input: ReportInput): string {
  const parts: string[] = [];
  const description = input.description.trim();
  if (description) parts.push(description);
  if (input.screenshot) {
    parts.push(
      `**Screenshot:** press ${input.pasteKey} in this box to attach the screenshot Safelight copied to your clipboard.`,
    );
  }
  const sections = input.sections.filter(shown);
  if (sections.length > 0) {
    parts.push(
      [
        DIAG_START,
        "<details>",
        `<summary>Diagnostics from Safelight ${input.appVersion}</summary>`,
        "",
        sections.map(renderSection).join("\n\n"),
        "",
        "</details>",
        DIAG_END,
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

export function renderCopyText(input: ReportInput): string {
  return `# ${input.title.trim()}\n\n${renderReport({ ...input, screenshot: false })}`;
}

export function issueUrl(title: string, body: string): string {
  return `${NEW_ISSUE_URL}?${new URLSearchParams({ title, body }).toString()}`;
}

/** The largest k in [lo, hi] for which `fits(k)` holds, or null. Assumes that
 *  keeping less never makes the link longer. */
function largestFitting(lo: number, hi: number, fits: (k: number) => boolean): number | null {
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export function fitReportToUrl(input: ReportInput, budget = ISSUE_URL_BUDGET): FittedReport {
  const title = input.title.slice(0, MAX_TITLE);
  let current: ReportInput = { ...input, title };
  let omittedEntries = 0;
  const cutSections: SectionId[] = [];
  let cutDescription = false;

  const urlFor = (inp: ReportInput): string => issueUrl(title, renderReport(inp));
  const fits = (inp: ReportInput): boolean => urlFor(inp).length <= budget;
  const done = (ok: boolean): FittedReport => {
    const body = renderReport(current);
    return { url: issueUrl(title, body), body, fits: ok, omittedEntries, cutSections, cutDescription };
  };
  const withSection = (index: number, patch: Partial<ReportSection>): ReportInput => ({
    ...current,
    sections: current.sections.map((s, i) => (i === index ? { ...s, ...patch } : s)),
  });

  if (fits(current)) return done(true);

  const errorsAt = current.sections.findIndex((s) => s.id === "errors" && s.include && s.text.trim());
  if (errorsAt !== -1) {
    const blocks = splitEntries(current.sections[errorsAt].text);
    const keepNewest = (k: number): ReportInput =>
      withSection(errorsAt, {
        text: blocks.slice(blocks.length - k).join("\n\n"),
        note: `${blocks.length - k} older entries left out — Copy report in Safelight has the full text.`,
      });
    const k = largestFitting(0, blocks.length - 1, (n) => fits(keepNewest(n))) ?? 0;
    current = keepNewest(k);
    omittedEntries = blocks.length - k;
    if (fits(current)) return done(true);
  }

  for (const id of CUT_ORDER) {
    const at = current.sections.findIndex((s) => s.id === id && s.include && s.text.trim());
    if (at === -1) continue;
    const lines = current.sections[at].text.split("\n");
    const keepLines = (m: number): ReportInput =>
      withSection(at, { text: lines.slice(0, m).join("\n"), note: CUT_NOTE });
    const m = largestFitting(0, lines.length - 1, (n) => fits(keepLines(n))) ?? 0;
    current = keepLines(m);
    cutSections.push(id);
    if (fits(current)) return done(true);
  }

  const description = current.description.trim();
  if (description) {
    const keepChars = (c: number): ReportInput => ({
      ...current,
      description: `${description.slice(0, c).trimEnd()}…\n\n_(${CUT_NOTE})_`,
    });
    const c = largestFitting(0, description.length - 1, (n) => fits(keepChars(n)));
    current = keepChars(c ?? 0);
    cutDescription = true;
    if (c !== null) return done(true);
  }

  return done(false);
}
