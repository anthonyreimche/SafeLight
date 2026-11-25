// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension notices (api.ui.notify), shown as bars in the bottom stack.

import { create } from "zustand";
import { getExtensionName } from "@/extensions/param-registry";

export type NoticeTone = "info" | "success" | "warning" | "error";

export interface NoticeOptions {
  message: string;
  /** info and success go by themselves; warning and error stay until dismissed. */
  tone?: NoticeTone;
  /** 0..1 while a run is under way, which keeps the notice up; null for none. */
  progress?: number | null;
}

export interface Notice {
  id: number;
  owner: string;
  /** The extension's name, shown so a notice can't pass for the app's own. */
  source: string;
  message: string;
  tone: NoticeTone;
  progress: number | null;
}

export interface NoticeHandle {
  update(next: Partial<NoticeOptions>): void;
  close(): void;
}

export const AUTO_DISMISS_MS = 6000;

export const useNotifications = create<{ notices: Notice[] }>(() => ({ notices: [] }));

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function clearTimer(id: number): void {
  const timer = timers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  timers.delete(id);
}

export function dismissNotice(id: number): void {
  clearTimer(id);
  useNotifications.setState((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
}

function passes(notice: Notice): boolean {
  return notice.progress === null && (notice.tone === "info" || notice.tone === "success");
}

function schedule(notice: Notice): void {
  clearTimer(notice.id);
  if (passes(notice)) timers.set(notice.id, setTimeout(() => dismissNotice(notice.id), AUTO_DISMISS_MS));
}

function heldProgress(progress: number | null | undefined): number | null {
  return progress === null || progress === undefined ? null : Math.max(0, Math.min(1, progress));
}

export function notify(owner: string, options: NoticeOptions | string): NoticeHandle {
  const opts = typeof options === "string" ? { message: options } : options;
  const notice: Notice = {
    id: nextId++,
    owner,
    source: getExtensionName(owner),
    message: opts.message,
    tone: opts.tone ?? "info",
    progress: heldProgress(opts.progress),
  };
  useNotifications.setState((s) => ({ notices: [...s.notices, notice] }));
  schedule(notice);
  return {
    update(next) {
      const current = useNotifications.getState().notices.find((n) => n.id === notice.id);
      if (!current) return;
      const updated: Notice = {
        ...current,
        ...(next.message !== undefined && { message: next.message }),
        ...(next.tone !== undefined && { tone: next.tone }),
        ...(next.progress !== undefined && { progress: heldProgress(next.progress) }),
      };
      useNotifications.setState((s) => ({ notices: s.notices.map((n) => (n.id === notice.id ? updated : n)) }));
      schedule(updated);
    },
    close: () => dismissNotice(notice.id),
  };
}

export function dropNotifications(owner: string): void {
  for (const n of useNotifications.getState().notices) if (n.owner === owner) clearTimer(n.id);
  useNotifications.setState((s) => ({ notices: s.notices.filter((n) => n.owner !== owner) }));
}
