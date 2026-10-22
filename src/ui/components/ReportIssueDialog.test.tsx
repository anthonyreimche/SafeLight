// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Report an issue in the browser build (no Electron bridge, so no screenshot):
// the user types a title and description, checks the diagnostics, and GitHub
// opens with exactly what the dialog showed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DIAG_START, SECURITY_URL } from "@/diagnostics/report-markdown";
import { clearErrorLog, recordError, flushErrorLog } from "@/diagnostics/error-log";
import { shortcutsSuspended } from "@/state/keybindings-store";
import { ReportIssueDialog } from "./ReportIssueDialog";
import {
  clearReportDraft,
  closeReportIssue,
  openReportIssue,
  setReportDraft,
  useReportIssue,
} from "./report-issue-store";

let opened: string[] = [];

beforeEach(() => {
  localStorage.clear();
  clearErrorLog();
  closeReportIssue();
  clearReportDraft();
  opened = [];
  vi.spyOn(window, "open").mockImplementation((url) => {
    opened.push(String(url));
    return null;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openDialog(prefill?: Parameters<typeof openReportIssue>[0]) {
  render(<ReportIssueDialog />);
  await act(() => openReportIssue(prefill));
  await screen.findByRole("checkbox", { name: "Include Environment" });
}

async function fillIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Title"), "Sliders freeze");
  await user.type(screen.getByLabelText("What happened?"), "They stop moving.");
}

const openedBody = (): string => new URL(opened[opened.length - 1]).searchParams.get("body") ?? "";
const openButton = () => screen.getByRole("button", { name: "Open on GitHub" }) as HTMLButtonElement;

describe("ReportIssueDialog", () => {
  it("starts in the title field", async () => {
    await openDialog();
    expect(document.activeElement).toBe(screen.getByLabelText("Title"));
  });

  it("waits for a title and a description before opening GitHub", async () => {
    const user = userEvent.setup();
    await openDialog();
    expect(openButton().disabled).toBe(true);
    await user.type(screen.getByLabelText("Title"), "Sliders freeze");
    expect(openButton().disabled).toBe(true);
    await user.type(screen.getByLabelText("What happened?"), "They stop.");
    expect(openButton().disabled).toBe(false);
  });

  it("lists every section, included, with its text one click away", async () => {
    const user = userEvent.setup();
    await openDialog();
    for (const label of ["Environment", "Graphics", "Extensions", "Photo and app", "Recent errors"]) {
      expect((screen.getByRole("checkbox", { name: `Include ${label}` }) as HTMLInputElement).checked).toBe(true);
    }
    await user.click(screen.getByRole("button", { name: "Show Environment" }));
    const text = screen.getByLabelText("Environment text") as HTMLTextAreaElement;
    expect(text.value).toContain("(browser build)");
  });

  it("opens GitHub with the report, then closes and forgets the draft", async () => {
    const user = userEvent.setup();
    await openDialog();
    await fillIn(user);
    await user.click(openButton());
    expect(opened).toHaveLength(1);
    expect(new URL(opened[0]).searchParams.get("title")).toBe("Sliders freeze");
    expect(openedBody()).toContain("They stop moving.");
    expect(openedBody()).toContain(DIAG_START);
    expect(openedBody()).toContain("**Environment**");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useReportIssue.getState().draft).toEqual({ title: "", description: "" });
  });

  it("leaves out a section the user unticks", async () => {
    const user = userEvent.setup();
    await openDialog();
    await fillIn(user);
    await user.click(screen.getByRole("checkbox", { name: "Include Graphics" }));
    await user.click(openButton());
    expect(openedBody()).not.toContain("**Graphics**");
    expect(openedBody()).toContain("**Environment**");
  });

  it("sends a section as the user edited it", async () => {
    const user = userEvent.setup();
    await openDialog();
    await fillIn(user);
    await user.click(screen.getByRole("button", { name: "Show Environment" }));
    const text = screen.getByLabelText("Environment text");
    await user.clear(text);
    await user.type(text, "my own words");
    expect(screen.getByText("edited")).toBeTruthy();
    await user.click(openButton());
    expect(openedBody()).toContain("my own words");
    expect(openedBody()).not.toContain("browser build");
  });

  it("drops a cleared section", async () => {
    const user = userEvent.setup();
    await openDialog();
    await fillIn(user);
    await user.click(screen.getByRole("button", { name: "Show Extensions" }));
    await user.click(screen.getByRole("button", { name: "Clear Extensions" }));
    await user.click(openButton());
    expect(openedBody()).not.toContain("**Extensions**");
  });

  it("copies the full report", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await openDialog();
    await fillIn(user);
    await user.click(screen.getByRole("button", { name: "Copy report" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0] as unknown as [string];
    expect(copied[0].startsWith("# Sliders freeze\n\nThey stop moving.")).toBe(true);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("keeps the draft when closed with Esc", async () => {
    const user = userEvent.setup();
    await openDialog();
    await fillIn(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(() => openReportIssue());
    expect((await screen.findByLabelText("Title") as HTMLInputElement).value).toBe("Sliders freeze");
  });

  it("pauses app shortcuts while open, so typing never edits the photo behind it", async () => {
    expect(shortcutsSuspended()).toBe(false);
    await openDialog();
    expect(shortcutsSuspended()).toBe(true);
    act(() => closeReportIssue());
    expect(shortcutsSuspended()).toBe(false);
  });

  it("has no screenshot option without the Electron bridge", async () => {
    await openDialog();
    expect(screen.queryByRole("checkbox", { name: /screenshot/i })).toBeNull();
  });

  it("says when the link leaves out old errors, and keeps it within GitHub's limit", async () => {
    const user = userEvent.setup();
    for (let i = 0; i < 120; i++) recordError("error", `failure number ${i} ${"x".repeat(80)}`);
    flushErrorLog();
    await openDialog();
    await fillIn(user);
    expect(screen.getByText(/The link leaves out the \d+ oldest errors/)).toBeTruthy();
    await user.click(openButton());
    expect(opened[0].length).toBeLessThanOrEqual(7500);
    expect(openedBody()).toContain("failure number 119 ");
  });

  it("points security problems at the private channel", async () => {
    const user = userEvent.setup();
    await openDialog();
    await user.click(screen.getByRole("button", { name: /Security problem/ }));
    expect(opened).toEqual([SECURITY_URL]);
  });

  it("still lets the user report when the diagnostics can't be collected", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("safelightNative", {});
    render(<ReportIssueDialog />);
    await act(() => openReportIssue());
    expect((await screen.findByRole("status")).textContent).toContain("Couldn't collect the diagnostics");
    await fillIn(user);
    expect(openButton().disabled).toBe(false);
  });

  it("offers the email address for people without a GitHub account", async () => {
    await openDialog();
    expect(screen.getByText("anthonyreimche@gmail.com")).toBeTruthy();
  });

  it("starts from a crash when one is passed in", async () => {
    setReportDraft({ description: "kept" });
    await openDialog({ title: 'Panel "x" crashed: boom', crash: { what: 'Panel "x"', message: "boom" } });
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe('Panel "x" crashed: boom');
    const boxes = screen.getAllByRole("checkbox", { name: /^Include / });
    expect(boxes[0].getAttribute("aria-label")).toBe("Include Crash");
  });

  it("scrubs paths and photo names from a prefilled crash title", async () => {
    await openDialog({
      title: 'Panel "x" crashed: no C:\\Users\\ann\\Pictures\\DSC_0042.NEF',
      crash: { what: 'Panel "x"', message: "no C:\\Users\\ann\\Pictures\\DSC_0042.NEF" },
    });
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      'Panel "x" crashed: no ~/…/<photo>.NEF',
    );
  });
});
