// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import {
  DIAG_END,
  DIAG_START,
  NEW_ISSUE_URL,
  fenceFor,
  fitReportToUrl,
  issueUrl,
  renderCopyText,
  renderReport,
  splitEntries,
  type ReportInput,
  type ReportSection,
  type SectionId,
} from "./report-markdown";

const section = (id: SectionId, text: string, include = true): ReportSection => ({
  id,
  label: id[0].toUpperCase() + id.slice(1),
  summary: "",
  text,
  include,
});

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  title: "Sliders stop moving",
  description: "After a few minutes the sliders freeze.",
  sections: [section("environment", "Safelight 3.0.1\nWindows 10.0.26300 · x64")],
  appVersion: "3.0.1",
  screenshot: false,
  pasteKey: "Ctrl+V",
  ...over,
});

const outsideBlock = (body: string): string => {
  const start = body.indexOf(DIAG_START);
  if (start === -1) return body;
  const end = body.indexOf(DIAG_END);
  return body.slice(0, start) + body.slice(end + DIAG_END.length);
};

// The keyword list triage.yml matches on, as whole words.
const TRIAGE_WORDS = [
  "crash", "broken", "error", "fail", "bug", "regression", "slow", "build", "release", "sign",
  "docs", "comment", "feature", "request", "new", "raw", "ui", "panel", "layout", "button",
  "theme", "electron", "window", "native", "menu", "shortcut", "ipc", "critical", "security",
];
const triageHits = (text: string): string[] =>
  TRIAGE_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(text));

describe("renderReport", () => {
  it("puts the description first and the sections in a marked details block", () => {
    const body = renderReport(input());
    expect(body.startsWith("After a few minutes the sliders freeze.\n\n")).toBe(true);
    const block = body.slice(body.indexOf(DIAG_START), body.indexOf(DIAG_END) + DIAG_END.length);
    expect(block).toContain("<details>\n<summary>Diagnostics from Safelight 3.0.1</summary>");
    expect(block).toContain("**Environment**\n\n```text\nSafelight 3.0.1\nWindows 10.0.26300 · x64\n```");
    expect(body.trimEnd().endsWith(DIAG_END)).toBe(true);
  });

  it("leaves out excluded and empty sections", () => {
    const body = renderReport(
      input({ sections: [section("environment", "env"), section("graphics", "gpu", false), section("errors", "  ")] }),
    );
    expect(body).toContain("**Environment**");
    expect(body).not.toContain("**Graphics**");
    expect(body).not.toContain("**Errors**");
  });

  it("has no diagnostics block when nothing is included", () => {
    const body = renderReport(input({ sections: [section("environment", "env", false)] }));
    expect(body).not.toContain(DIAG_START);
    expect(body).toBe("After a few minutes the sliders freeze.");
  });

  it("asks for the screenshot paste only when one was copied", () => {
    expect(renderReport(input())).not.toContain("screenshot");
    const body = renderReport(input({ screenshot: true, pasteKey: "⌘V" }));
    expect(outsideBlock(body)).toContain("press ⌘V in this box to attach the screenshot");
  });

  it("keeps triage keywords out of everything outside the block", () => {
    const body = renderReport(
      input({
        description: "",
        screenshot: true,
        sections: [section("errors", "error: electron window crashed in the ui panel")],
      }),
    );
    expect(triageHits(outsideBlock(body))).toEqual([]);
  });
});

describe("fenceFor", () => {
  it("is longer than any backtick run in the text", () => {
    expect(fenceFor("plain")).toBe("```");
    expect(fenceFor("a ``` b ````` c")).toBe("``````");
  });
});

describe("issueUrl", () => {
  it("round-trips the title and body", () => {
    const url = issueUrl("A & B", "line 1\nline 2 #3");
    expect(url.startsWith(`${NEW_ISSUE_URL}?`)).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("title")).toBe("A & B");
    expect(params.get("body")).toBe("line 1\nline 2 #3");
  });
});

describe("splitEntries", () => {
  it("splits on blank lines and drops empty blocks", () => {
    expect(splitEntries("a\nb\n\n\nc\n\n")).toEqual(["a\nb", "c"]);
  });
});

describe("renderCopyText", () => {
  it("adds the title as a heading and never the screenshot line", () => {
    const text = renderCopyText(input({ screenshot: true }));
    expect(text.startsWith("# Sliders stop moving\n\n")).toBe(true);
    expect(text).not.toContain("screenshot");
  });
});

describe("fitReportToUrl", () => {
  const errorEntries = (n: number): string =>
    Array.from({ length: n }, (_, i) => `2026-10-21 14:${String(i).padStart(2, "0")} · main · error\nentry ${i} ${"x".repeat(120)}`).join("\n\n");

  it("returns the whole report when it fits", () => {
    const fitted = fitReportToUrl(input());
    expect(fitted).toMatchObject({ fits: true, omittedEntries: 0, cutSections: [], cutDescription: false });
    expect(fitted.body).toBe(renderReport(input()));
  });

  it("drops the oldest errors first and says how many", () => {
    const fitted = fitReportToUrl(input({ sections: [section("environment", "env"), section("errors", errorEntries(80))] }));
    expect(fitted.fits).toBe(true);
    expect(fitted.url.length).toBeLessThanOrEqual(7500);
    expect(fitted.omittedEntries).toBeGreaterThan(0);
    expect(fitted.body).toContain("entry 79 ");
    expect(fitted.body).not.toContain("entry 0 ");
    expect(fitted.body).toContain(`${fitted.omittedEntries} older entries left out`);
    expect(fitted.cutSections).toEqual([]);
  });

  it("then shortens sections in order, keeping the title and description", () => {
    const longList = Array.from({ length: 400 }, (_, i) => `- ext.number-${i} 1.0.0 · on · verified`).join("\n");
    const fitted = fitReportToUrl(
      input({ sections: [section("environment", "env"), section("extensions", longList)] }),
    );
    expect(fitted.fits).toBe(true);
    expect(fitted.cutSections).toEqual(["extensions"]);
    expect(fitted.body).toContain("- ext.number-0 ");
    expect(fitted.body).toContain("cut to fit the link");
    expect(fitted.body.startsWith("After a few minutes the sliders freeze.")).toBe(true);
    expect(new URL(fitted.url).searchParams.get("title")).toBe("Sliders stop moving");
  });

  it("cuts the description last", () => {
    const fitted = fitReportToUrl(input({ description: "word ".repeat(3000) }));
    expect(fitted.fits).toBe(true);
    expect(fitted.cutDescription).toBe(true);
    expect(fitted.url.length).toBeLessThanOrEqual(7500);
    expect(triageHits(outsideBlock(fitted.body).replace(/word/g, ""))).toEqual([]);
  });

  it("works to a smaller budget", () => {
    const fitted = fitReportToUrl(
      input({ sections: [section("environment", "env"), section("errors", errorEntries(40))] }),
      2000,
    );
    expect(fitted.fits).toBe(true);
    expect(fitted.url.length).toBeLessThanOrEqual(2000);
  });

  it("reports when nothing fits", () => {
    expect(fitReportToUrl(input(), 60).fits).toBe(false);
  });

  it("caps the title at 256 characters", () => {
    const fitted = fitReportToUrl(input({ title: "t".repeat(400) }));
    expect(new URL(fitted.url).searchParams.get("title")).toHaveLength(256);
  });
});
