// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Slim bar shown when the trust registry's kill-switch refuses to load an
// installed extension this session (it was banned after the user installed it).
// The extension's files stay on disk but it isn't activated; this tells the user
// why it stopped working and offers to open the Extensions window to remove it.
// One line per extension, each its own alert and dismissed on its own, so a
// dismissal doesn't announce the others again.

import { useTrust, dismissFlag } from "./trust";
import { openExtensions } from "@/ui/components/extensions-dialog-store";

export function ExtensionSecurityBanner() {
  const allFlagged = useTrust((s) => s.flagged);
  const dismissed = useTrust((s) => s.dismissedFlags);
  const flagged = allFlagged.filter((f) => !dismissed.includes(f.id));
  if (flagged.length === 0) return null;

  return (
    <div
      data-extension-security
      className="flex items-start justify-center gap-3 border-t border-danger/40 px-4 py-2 text-[11px] shadow-lg"
      style={{ background: "color-mix(in srgb, var(--color-danger) 12%, var(--color-surface-2))" }}
    >
      <span className="font-medium text-danger">⚠ Extension blocked</span>
      <div className="flex min-w-0 flex-col gap-1">
        {flagged.map((f) => (
          <div key={f.id} role="alert" className="flex items-center gap-2 text-text-secondary">
            <span className="min-w-0 break-words">
              “{f.name}” was turned off because the extension registry flagged it: {f.reason}.
            </span>
            <button
              onClick={() => dismissFlag(f.id)}
              title="Dismiss"
              aria-label="Dismiss"
              className="shrink-0 rounded px-1.5 py-0.5 text-text-muted hover:text-text-primary"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={() => openExtensions()}
        className="shrink-0 rounded border border-border px-2.5 py-1 text-[11px] text-text-primary hover:bg-surface-3"
      >
        Manage extensions
      </button>
    </div>
  );
}
