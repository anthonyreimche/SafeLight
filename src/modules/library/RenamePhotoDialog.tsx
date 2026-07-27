// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useMemo, useRef, useState } from "react";

// Characters no Windows/macOS/Linux filesystem accepts in a path segment, plus
// control chars — the same name reaches the on-disk rename verbatim.
const ILLEGAL_CHARS = /[/\\:*?"<>|\x00-\x1f]/;

const NO_NAMES: readonly string[] = [];

interface Props {
<<<<<<< Updated upstream
  /** Current filename (with extension). The extension is preserved and shown as
   *  a static suffix; only the base name is editable. */
  filename: string;
  onRename: (newBaseName: string) => void;
  onCancel: () => void;
}

/** Single-field modal for renaming a photo file. Mirrors PresetRenameDialog's
 *  lightweight pattern; the file extension is locked so the decode path (which
 *  keys off it) can't be broken by a typo. */
export function RenamePhotoDialog({ filename, onRename, onCancel }: Props) {
  const dot = filename.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [filename.slice(0, dot), filename.slice(dot)] : [filename, ""];
  const [name, setName] = useState(base);
=======
  /** Heading, e.g. "Rename photo" or "Rename copy". */
  title: string;
  /** Initial editable value. */
  value: string;
  /** Static, non-editable text shown before the field (e.g. a "base_" prefix
   *  when editing a virtual copy's name). */
  prefix?: string;
  /** Static, non-editable text shown after the field (e.g. the ".NEF" extension,
   *  which is locked so the decode path that keys off it can't be broken). */
  suffix?: string;
  placeholder?: string;
  /** Names already spoken for beside this one — sibling filenames for a master,
   *  sibling copy names for a virtual copy. Compared case-insensitively, since
   *  Windows and macOS collide on case, so the clash surfaces here instead of
   *  after a failed disk rename. */
  takenNames?: readonly string[];
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** Single-field modal for renaming a photo file or a virtual copy. The
 *  surrounding `prefix`/`suffix` are shown but not editable. */
export function RenamePhotoDialog({
  title,
  value: initial,
  prefix,
  suffix,
  placeholder,
  takenNames = NO_NAMES,
  onSubmit,
  onCancel,
}: Props) {
  const [name, setName] = useState(initial);
>>>>>>> Stashed changes
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.select(), []);

  const taken = useMemo(
    () => new Set(takenNames.map((n) => n.trim().toLowerCase())),
    [takenNames],
  );
  const trimmed = name.trim();
  const error = ILLEGAL_CHARS.test(name)
    ? 'Name can\'t contain / \\ : * ? " < > |.'
    : trimmed !== "" && taken.has(trimmed.toLowerCase())
      ? `“${trimmed}” is already taken.`
      : null;
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
      <div className="w-[360px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-xl">
        <div className="space-y-2 p-3">
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
            Rename photo
          </div>
          <div className="flex items-center rounded bg-[var(--color-surface-2)] focus-within:ring-1 focus-within:ring-[var(--color-accent)]">
            <input
              ref={inputRef}
              type="text"
              value={name}
              placeholder="File name"
              aria-label="File name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") onCancel();
              }}
              className="min-w-0 flex-1 rounded-l bg-transparent px-2 py-1 text-[12px] text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none"
            />
            {ext && (
              <span className="shrink-0 pr-2 text-[12px] text-[var(--color-text-tertiary)]">
                {ext}
              </span>
            )}
          </div>
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
