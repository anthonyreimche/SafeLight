// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useRef, useState } from "react";

interface Props {
  initialName: string;
  /** Return an error string for an invalid name (e.g. collision), else null. */
  validate?: (name: string) => string | null;
  onRename: (name: string) => void;
  onCancel: () => void;
}

/** Single-field modal for renaming a preset. Mirrors the app's modal pattern. */
export function PresetRenameDialog({ initialName, validate, onRename, onCancel }: Props) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.select(), []);

  const trimmed = name.trim();
  const error = validate?.(trimmed) ?? null;
  const canSave = trimmed.length > 0 && !error;
  const submit = () => {
    if (canSave) onRename(trimmed);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-[320px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-xl">
        <div className="space-y-2 p-3">
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
            Rename preset
          </div>
          <input
            ref={inputRef}
            type="text"
            value={name}
            placeholder="Preset name"
            aria-label="Preset name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") onCancel();
            }}
            className="w-full rounded bg-[var(--color-surface-2)] px-2 py-1 text-[12px] text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none"
          />
          {error && <div className="text-[10px] text-[var(--color-label-red)]">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] p-3">
          <button
            className="rounded bg-[var(--color-surface-2)] px-3 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            disabled={!canSave}
            className="rounded bg-[var(--color-accent)] px-3 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={submit}
          >
            Rename
          </button>
        </div>
      </div>
    </div>
  );
}
