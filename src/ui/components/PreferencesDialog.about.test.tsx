// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ About reaches Report an issue from every window, including the
// welcome screen, which has no top bar.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openPreferences, PreferencesDialog } from "./PreferencesDialog";
import { closeReportIssue, useReportIssue } from "./report-issue-store";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

beforeEach(() => {
  localStorage.clear();
  closeReportIssue();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
});

afterEach(() => {
  act(() => closeReportIssue());
  vi.unstubAllGlobals();
});

describe("Preferences ▸ About", () => {
  it("closes Preferences and opens Report an issue", async () => {
    const user = userEvent.setup();
    render(<PreferencesDialog />);
    act(() => openPreferences("About"));
    await user.click(screen.getByRole("button", { name: "Report an issue…" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useReportIssue.getState().open).toBe(true);
  });
});
