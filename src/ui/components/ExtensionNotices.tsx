// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.ui.notify's bars, in the bottom stack (BottomBanners) with the look of
// core's own (StorageBanner). The message is selectable, so an error can be
// copied into a report; only the × dismisses.

import { ProgressBar } from "@/extensions/ui-kit";
import { dismissNotice, useNotifications, type Notice } from "@/state/notification-store";
import { DismissButton } from "./DismissButton";

const WARNS = new Set<Notice["tone"]>(["warning", "error"]);

function NoticeBar({ notice }: { notice: Notice }) {
  const urgent = notice.tone === "error";
  return (
    <div
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
      className={`sl-enter-rise flex items-center justify-center gap-3 border-t bg-surface-2 px-4 py-2 text-[11px] text-text-secondary shadow-lg ${
        urgent ? "border-danger/40" : "border-border"
      }`}
    >
      {WARNS.has(notice.tone) && (
        <span className={urgent ? "text-danger" : "text-label-yellow"} aria-hidden="true">
          ⚠
        </span>
      )}
      <span className="shrink-0 text-text-muted">{notice.source}</span>
      <span className="select-text text-text-primary">{notice.message}</span>
      {notice.progress !== null && (
        <span className="w-32 shrink-0">
          <ProgressBar value={notice.progress} label={notice.message} />
        </span>
      )}
      <DismissButton onClick={() => dismissNotice(notice.id)} />
    </div>
  );
}

export function ExtensionNotices() {
  const notices = useNotifications((s) => s.notices);
  if (notices.length === 0) return null;
  return (
    <>
      {notices.map((n) => (
        <NoticeBar key={n.id} notice={n} />
      ))}
    </>
  );
}
