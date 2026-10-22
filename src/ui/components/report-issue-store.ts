// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { create } from "zustand";
import { privilegedCapture } from "@/native/privileged";
import { openUrl } from "@/update/update-checker";
import { fitReportToUrl, type ReportInput } from "@/diagnostics/report-markdown";
import type { ReportPrefill } from "@/diagnostics/report-sections";

export interface ReportDraft {
  title: string;
  description: string;
}

export interface ReportIssueState {
  open: boolean;
  prefill: ReportPrefill | null;
  /** The window as it was when Report an issue was clicked. */
  screenshot: Blob | null;
  /** Kept in memory while the dialog is closed, until a report is sent. */
  draft: ReportDraft;
}

// The fallback when the main process can't serve its local redirect: Electron
// caps shell.openExternal at 2081 characters on Windows.
const OS_LINK_BUDGET = 2000;
// A capture that never answers must not keep the dialog from opening.
const CAPTURE_TIMEOUT_MS = 3000;

export const useReportIssue = create<ReportIssueState>(() => ({
  open: false,
  prefill: null,
  screenshot: null,
  draft: { title: "", description: "" },
}));

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function captureWindow(): Promise<Blob | null> {
  const capture = privilegedCapture();
  if (!capture) return null;
  // Lets a window that just closed (Preferences) leave the picture first.
  await nextFrame();
  await nextFrame();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS);
  });
  try {
    const png = await Promise.race([capture.page(), timedOut]);
    return png ? new Blob([png], { type: "image/png" }) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let opening: Promise<void> | null = null;

export function openReportIssue(prefill?: ReportPrefill): Promise<void> {
  if (useReportIssue.getState().open) return Promise.resolve();
  opening ??= (async () => {
    try {
      const screenshot = await captureWindow();
      useReportIssue.setState((s) => ({
        open: true,
        prefill: prefill ?? null,
        screenshot,
        draft: prefill?.title ? { ...s.draft, title: prefill.title } : s.draft,
      }));
    } finally {
      opening = null;
    }
  })();
  return opening;
}

export function closeReportIssue(): void {
  useReportIssue.setState({ open: false, prefill: null, screenshot: null });
}

export function toggleReportIssue(): void {
  if (useReportIssue.getState().open) closeReportIssue();
  else void openReportIssue();
}

export function setReportDraft(patch: Partial<ReportDraft>): void {
  useReportIssue.setState((s) => ({ draft: { ...s.draft, ...patch } }));
}

export function clearReportDraft(): void {
  useReportIssue.setState({ draft: { title: "", description: "" } });
}

/** Opens the prefilled new-issue page in the system browser. False when it
 *  fell back to a hand-off that can't report whether a browser opened. */
export async function openIssue(input: ReportInput): Promise<boolean> {
  const { url } = fitReportToUrl(input);
  const bridge = window.safelightNative?.report;
  if (!bridge) {
    openUrl(url);
    return true;
  }
  try {
    await bridge.openIssue(url);
    return true;
  } catch {
    openUrl(fitReportToUrl(input, OS_LINK_BUDGET).url);
    return false;
  }
}
