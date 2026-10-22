// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportInput } from "@/diagnostics/report-markdown";
import {
  clearReportDraft,
  closeReportIssue,
  openIssue,
  openReportIssue,
  setReportDraft,
  toggleReportIssue,
  useReportIssue,
} from "./report-issue-store";

let pageImpl: () => Promise<Uint8Array<ArrayBuffer> | null> = () => Promise.resolve(null);
const page = vi.fn(() => pageImpl());
const openIssueBridge = vi.fn((_url: string) => Promise.resolve());

beforeAll(() => {
  vi.stubGlobal("safelightNative", {
    claimPrivileged: () => ({ fs: {}, updates: {}, capture: { page } }),
    report: { openIssue: openIssueBridge },
  });
});

beforeEach(() => {
  closeReportIssue();
  clearReportDraft();
  page.mockClear();
  openIssueBridge.mockClear();
  pageImpl = () => Promise.resolve(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openReportIssue", () => {
  it("captures the window before the dialog opens", async () => {
    pageImpl = () => {
      expect(useReportIssue.getState().open).toBe(false);
      return Promise.resolve(new Uint8Array([137, 80, 78, 71]));
    };
    await openReportIssue();
    const s = useReportIssue.getState();
    expect(s.open).toBe(true);
    expect(s.screenshot?.type).toBe("image/png");
    expect(s.screenshot?.size).toBe(4);
  });

  it("still opens when the capture fails or comes back empty", async () => {
    pageImpl = () => Promise.reject(new Error("gone"));
    await openReportIssue();
    expect(useReportIssue.getState()).toMatchObject({ open: true, screenshot: null });
    closeReportIssue();
    pageImpl = () => Promise.resolve(null);
    await openReportIssue();
    expect(useReportIssue.getState()).toMatchObject({ open: true, screenshot: null });
  });

  it("opens without a screenshot when the capture never answers", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      pageImpl = () => new Promise(() => {});
      const opened = openReportIssue();
      await vi.advanceTimersByTimeAsync(5000);
      await opened;
      expect(useReportIssue.getState()).toMatchObject({ open: true, screenshot: null });
    } finally {
      vi.useRealTimers();
      vi.stubGlobal("requestAnimationFrame", window.requestAnimationFrame);
    }
  });

  it("captures once when asked twice in quick succession", async () => {
    await Promise.all([openReportIssue(), openReportIssue()]);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it("replaces the draft title with a prefilled one and keeps the description", async () => {
    setReportDraft({ title: "old", description: "what I saw" });
    await openReportIssue({ title: 'Panel "x" crashed: boom', crash: { what: 'Panel "x"', message: "boom" } });
    const s = useReportIssue.getState();
    expect(s.draft).toEqual({ title: 'Panel "x" crashed: boom', description: "what I saw" });
    expect(s.prefill?.crash?.message).toBe("boom");
  });
});

describe("closing", () => {
  it("keeps the draft and drops the screenshot and prefill", async () => {
    pageImpl = () => Promise.resolve(new Uint8Array([1]));
    await openReportIssue({ title: "t" });
    setReportDraft({ description: "d" });
    closeReportIssue();
    expect(useReportIssue.getState()).toMatchObject({
      open: false,
      screenshot: null,
      prefill: null,
      draft: { title: "t", description: "d" },
    });
  });

  it("toggles an open dialog shut", async () => {
    await openReportIssue();
    toggleReportIssue();
    expect(useReportIssue.getState().open).toBe(false);
  });
});

describe("openIssue", () => {
  const input = (body: string): ReportInput => ({
    title: "t",
    description: body,
    sections: [],
    appVersion: "3.0.1",
    screenshot: false,
    pasteKey: "Ctrl+V",
  });

  it("hands the whole link to the main process", async () => {
    await expect(openIssue(input("x ".repeat(2000)))).resolves.toBe(true);
    const url = openIssueBridge.mock.calls[0][0];
    expect(url.length).toBeGreaterThan(2000);
    expect(new URL(url).searchParams.get("body")).toBe("x ".repeat(2000).trim());
  });

  it("falls back to a link short enough for the OS when the main process can't open it", async () => {
    openIssueBridge.mockRejectedValueOnce(new Error("EACCES"));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    // The fallback can't tell whether a browser opened.
    await expect(openIssue(input("x ".repeat(2000)))).resolves.toBe(false);
    const url = String(open.mock.calls[0][0]);
    expect(url.length).toBeLessThanOrEqual(2000);
  });
});
