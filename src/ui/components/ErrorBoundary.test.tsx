// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A crashed panel or module records the crash, with React's component stack,
// in the error log, and offers to report it with the crash filled in.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearErrorLog, readErrorLog } from "@/diagnostics/error-log";
import { ErrorBoundary } from "./ErrorBoundary";
import { clearReportDraft, closeReportIssue, useReportIssue } from "./report-issue-store";

function Boom(): never {
  throw new TypeError("boom");
}

const renderCrash = () =>
  render(
    <ErrorBoundary what='Panel "acme.film"' className="notice">
      <Boom />
    </ErrorBoundary>,
  );

beforeEach(() => {
  localStorage.clear();
  clearErrorLog();
  closeReportIssue();
  clearReportDraft();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  act(() => closeReportIssue());
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("still says what crashed", () => {
    renderCrash();
    expect(screen.getByText('Panel "acme.film" crashed: boom')).toBeTruthy();
  });

  it("records the crash with its component stack", () => {
    renderCrash();
    const entry = readErrorLog().find((e) => e.level === "exception");
    expect(entry?.message).toBe('Panel "acme.film" crashed: boom');
    expect(entry?.stack).toContain("Component stack:");
    expect(entry?.stack).toContain("Boom");
  });

  it("opens Report an issue with the crash filled in", async () => {
    const user = userEvent.setup();
    renderCrash();
    await user.click(screen.getByRole("button", { name: "Report this" }));
    const s = useReportIssue.getState();
    expect(s.open).toBe(true);
    expect(s.draft.title).toBe('Panel "acme.film" crashed: boom');
    expect(s.prefill?.crash).toMatchObject({ what: 'Panel "acme.film"', message: "boom" });
    expect(s.prefill?.crash?.componentStack).toContain("Boom");
  });
});
