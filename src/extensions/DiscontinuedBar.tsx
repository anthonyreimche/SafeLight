// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The bar on an extension the registry lists as discontinued: the author's
// message, its replacement to install, and Uninstall when it is installed.

import type { Discontinued } from "./discontinued";

export function DiscontinuedBar({
  discontinued,
  busy,
  onInstallReplacement,
  onUninstall,
}: {
  discontinued: Discontinued;
  busy: boolean;
  onInstallReplacement?: (repo: string) => void;
  /** Absent when the extension isn't installed. */
  onUninstall?: () => void;
}) {
  const { message, replacement } = discontinued;
  return (
    <div
      role="note"
      aria-label="Discontinued"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded px-2 py-1.5 text-[11px]"
      style={{ background: "color-mix(in srgb, var(--color-rating) 14%, transparent)" }}
    >
      <span className="shrink-0 font-medium text-text-primary">Discontinued</span>
      <span className="min-w-0 flex-1 text-text-secondary">
        {message ?? "No longer maintained."}
        {replacement && (
          <span>{` Replaced by ${replacement.name}${replacement.installed ? ", which is installed" : ""}.`}</span>
        )}
      </span>
      {replacement && !replacement.installed && onInstallReplacement && (
        <button
          disabled={busy}
          onClick={() => onInstallReplacement(replacement.repo)}
          title={`Install ${replacement.name}`}
          className="shrink-0 rounded bg-slider-fill px-2.5 py-0.5 font-medium text-on-accent hover:opacity-90 disabled:opacity-40"
        >
          Install replacement
        </button>
      )}
      {onUninstall && (
        <button
          disabled={busy}
          onClick={onUninstall}
          title="Uninstall the extension and delete its files"
          className="shrink-0 rounded px-1.5 py-0.5 text-text-muted hover:bg-surface-4 hover:text-text-primary disabled:opacity-40"
        >
          Uninstall
        </button>
      )}
    </div>
  );
}
