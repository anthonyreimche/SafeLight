// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

/** The × that closes a banner or notice. */
export function DismissButton({
  onClick,
  label = "Dismiss",
  title = label,
}: {
  onClick: () => void;
  label?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={title}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[13px] leading-none text-text-muted hover:bg-surface-3 hover:text-text-primary"
    >
      ×
    </button>
  );
}
