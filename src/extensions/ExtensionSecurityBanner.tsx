// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Slim bar shown when the trust registry's kill-switch refuses to load an
// installed extension this session (it was banned after the user installed it).
// The extension's files stay on disk but it isn't activated; this tells the user
// why it stopped working and offers to open the Extensions window to remove it.
// Sits just above the update banner (which is fixed to the very bottom).

import { useTrust, dismissFlag } from "./trust";
import { openExtensions } from "@/ui/components/ExtensionsDialog";

export function ExtensionSecurityBanner() {
  const flagged = useTrust((s) => s.flagged);
  if (flagged.length === 0) return null;

  const first = flagged[0];
  const more = flagged.length - 1;

  return (
    <div
      role="alert"
      aria-live="polite"
      className="fixed bottom-10 left-0 right-0 z-[201] flex items-center justify-center gap-3 border-t border-border px-4 py-2 text-[11px] shadow-lg"
      style={{ background: "color-mix(in srgb, var(--color-label-red) 12%, var(--color-surface-2))" }}
    >
      <span className="font-medium text-label-red">⚠ Extension blocked</span>
      <span className="text-text-secondary">
        “{first.name}” was disabled — {first.reason}.
        {more > 0 && ` (+${more} more)`}
      </span>
      <button
        onClick={() => openExtensions()}
        className="rounded border border-border px-2.5 py-1 text-[11px] text-text-primary hover:bg-surface-3"
      >
        Manage extensions
      </button>
      <button
        onClick={() => dismissFlag(first.id)}
        title="Dismiss"
        aria-label="Dismiss"
        className="rounded px-1.5 py-1 text-text-muted hover:text-text-primary"
      >
        ×
      </button>
    </div>
  );
}
