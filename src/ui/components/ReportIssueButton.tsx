// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CSSProperties } from "react";
import { openReportIssue } from "./report-issue-store";

function MessageWarningIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
      <path d="M12 15h.01" />
      <path d="M12 7v4" />
    </svg>
  );
}

export function ReportIssueButton({ className, style }: { className: string; style?: CSSProperties }) {
  return (
    <button
      type="button"
      onClick={() => void openReportIssue()}
      title="Report an issue"
      aria-label="Report an issue"
      className={className}
      style={style}
    >
      <MessageWarningIcon />
    </button>
  );
}
