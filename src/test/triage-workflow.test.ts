// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The triage workflow labels issues by keywords; Report an issue fills the
// body with diagnostics full of them (error, electron, window…). The workflow
// strips the marked diagnostics block first. This checks that the line in the
// YAML actually removes what renderReport produces.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIAG_END, renderReport } from "@/diagnostics/report-markdown";

const yaml = readFileSync(new URL("../../.github/workflows/triage.yml", import.meta.url), "utf8");

function loadStrip(): (s: string) => string {
  const line = yaml.split(/\r?\n/).find((l) => l.trim().startsWith("const stripDiagnostics ="));
  if (!line) throw new Error("triage.yml has no stripDiagnostics line");
  return new Function(`${line.trim()}\nreturn stripDiagnostics;`)() as (s: string) => string;
}

const body = renderReport({
  title: "t",
  description: "Sliders stop moving.",
  sections: [
    { id: "environment", label: "Environment", summary: "", text: "Electron 42 · window main", include: true },
    { id: "errors", label: "Recent errors", summary: "", text: "error: raw decode crash in the ui panel", include: true },
  ],
  appVersion: "3.0.1",
  screenshot: false,
  pasteKey: "Ctrl+V",
});

describe("triage.yml", () => {
  it("strips the diagnostics block before matching keywords", () => {
    const stripped = loadStrip()(body);
    expect(stripped).toContain("Sliders stop moving.");
    expect(stripped).not.toMatch(/electron|window|error|raw|crash|panel/i);
  });

  it("strips to the end when the closing marker was deleted", () => {
    const stripped = loadStrip()(body.replace(DIAG_END, ""));
    expect(stripped).not.toMatch(/electron|error/i);
  });

  it("matches keywords on the stripped body", () => {
    expect(yaml).toMatch(/const text = `\$\{issue\.title\}\\n\$\{stripDiagnostics\(issue\.body \|\| ''\)\}`/);
  });
});
