// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useRef, useState } from "react";

interface Props {
  initialGroup?: string;
  /** Existing group names, offered as autocomplete. */
  groups: string[];
  /** Empty string moves the preset to the ungrouped section. */
  onMove: (group: string) => void;
  onCancel: () => void;
}

/** Single-field modal for moving a preset to another group. Typing a new name
 *  creates the group; clearing the field (or "Ungrouped") removes the grouping. */
export function PresetMoveDialog({ initialGroup, groups, onMove, onCancel }: Props) {
  const [group, setGroup] = useState(initialGroup ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.select(), []);

  const submit = () => onMove(group.trim());

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
            Move to group
          </div>
          <input
            ref={inputRef}
            type="text"
            value={group}
            placeholder="Group (leave empty for ungrouped)"
            aria-label="Preset group"
            list="preset-move-groups"
            onChange={(e) => setGroup(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") onCancel();
            }}
            className="w-full rounded bg-[var(--color-surface-2)] px-2 py-1 text-[12px] text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none"
          />
          <datalist id="preset-move-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] p-3">
          <button
            className="rounded bg-[var(--color-surface-2)] px-3 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="rounded bg-[var(--color-accent)] px-3 py-1 text-[11px] font-medium text-white hover:opacity-90"
            onClick={submit}
          >
            Move
          </button>
        </div>
      </div>
    </div>
  );
}
