// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The screenshot can't travel in a link, so Open on GitHub puts it on the
// clipboard first (the write needs the window focused, before the browser takes
// over) and the issue text says to paste it.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearErrorLog } from "@/diagnostics/error-log";
import { ReportIssueDialog } from "./ReportIssueDialog";
import { clearReportDraft, closeReportIssue, openReportIssue } from "./report-issue-store";

const calls: string[] = [];
const openIssue = vi.fn(async (url: string) => {
  calls.push(`open:${url}`);
});
let writeImpl: () => Promise<void> = () => Promise.resolve();
const write = vi.fn(async (items: unknown[]) => {
  calls.push(`write:${items.length}`);
  return writeImpl();
});

let blobCount = 0;
const revoked = new Set<string>();

class FakeClipboardItem {
  readonly items: Record<string, Blob>;
  constructor(items: Record<string, Blob>) {
    this.items = items;
  }
}

beforeAll(() => {
  vi.stubGlobal("safelightNative", {
    platform: "win32",
    versions: { electron: "42.4.0", chrome: "142" },
    appVersion: () => Promise.resolve("3.0.1"),
    plugins: { list: () => Promise.resolve([]) },
    report: { openIssue },
    claimPrivileged: () => ({
      fs: {},
      updates: {},
      capture: { page: () => Promise.resolve(new Uint8Array([137, 80, 78, 71])) },
    }),
  });
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  URL.createObjectURL = () => `blob:shot-${++blobCount}`;
  URL.revokeObjectURL = (url: string) => {
    revoked.add(url);
  };
});

beforeEach(() => {
  localStorage.clear();
  clearErrorLog();
  closeReportIssue();
  clearReportDraft();
  calls.length = 0;
  openIssue.mockClear();
  write.mockClear();
  writeImpl = () => Promise.resolve();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openDialog() {
  const user = userEvent.setup();
  // After setup(): user-event installs a clipboard of its own.
  Object.defineProperty(navigator, "clipboard", { value: { write }, configurable: true });
  render(
    <StrictMode>
      <ReportIssueDialog />
    </StrictMode>,
  );
  await act(() => openReportIssue());
  await screen.findByRole("checkbox", { name: "Include Environment" });
  await user.type(screen.getByLabelText("Title"), "Sliders freeze");
  await user.type(screen.getByLabelText("What happened?"), "They stop moving.");
  return user;
}

const bodyOf = (call: string): string => new URL(call.slice("open:".length)).searchParams.get("body") ?? "";

describe("ReportIssueDialog screenshot", () => {
  it("leaves the screenshot out until the user ticks it, then shows it", async () => {
    const user = await openDialog();
    const box = screen.getByRole("checkbox", { name: "Attach a screenshot of the window" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.queryByRole("img", { name: "Screenshot of the window" })).toBeNull();
    await user.click(box);
    const src = screen.getByRole("img", { name: "Screenshot of the window" }).getAttribute("src") ?? "";
    expect(src).toMatch(/^blob:shot-/);
    expect(revoked.has(src)).toBe(false);
  });

  it("does not touch the clipboard when the screenshot is not ticked", async () => {
    const user = await openDialog();
    await user.click(screen.getByRole("button", { name: "Open on GitHub" }));
    expect(write).not.toHaveBeenCalled();
    expect(bodyOf(calls[0])).not.toContain("screenshot");
  });

  it("copies the screenshot before opening GitHub and asks for a paste", async () => {
    const user = await openDialog();
    await user.click(screen.getByRole("checkbox", { name: "Attach a screenshot of the window" }));
    await user.click(screen.getByRole("button", { name: "Open on GitHub" }));
    expect(calls.map((c) => c.split(":")[0])).toEqual(["write", "open"]);
    const item = write.mock.calls[0][0][0] as FakeClipboardItem;
    expect(item.items["image/png"].type).toBe("image/png");
    expect(bodyOf(calls[1])).toContain("press Ctrl+V in this box to attach the screenshot");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("still opens GitHub when the copy fails, without the paste line, and says so", async () => {
    writeImpl = () => Promise.reject(new Error("denied"));
    const user = await openDialog();
    await user.click(screen.getByRole("checkbox", { name: "Attach a screenshot of the window" }));
    await user.click(screen.getByRole("button", { name: "Open on GitHub" }));
    expect(openIssue).toHaveBeenCalledTimes(1);
    expect(bodyOf(calls[calls.length - 1])).not.toContain("screenshot");
    expect(screen.getByRole("status").textContent).toContain("Couldn't copy the screenshot");
  });

  it("keeps the report when Safelight can't confirm the browser opened", async () => {
    openIssue.mockRejectedValueOnce(new Error("EACCES"));
    vi.spyOn(window, "open").mockReturnValue(null);
    const user = await openDialog();
    await user.click(screen.getByRole("button", { name: "Open on GitHub" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Copy report");
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Sliders freeze");
  });

  it("copies the image on request", async () => {
    const user = await openDialog();
    await user.click(screen.getByRole("checkbox", { name: "Attach a screenshot of the window" }));
    await user.click(screen.getByRole("button", { name: "Copy image" }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(openIssue).not.toHaveBeenCalled();
  });
});
