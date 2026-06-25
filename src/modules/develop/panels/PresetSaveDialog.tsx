// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useMemo, useRef, useState, useEffect } from "react";
import type { DevelopParams } from "@/catalog/types";
import { presetFields, buildPartialParams } from "../preset-summary";

interface Props {
  /** Live params the preset is captured from. */
  params: DevelopParams;
  /** Existing group names, offered as autocomplete. */
  groups: string[];
  initialName?: string;
  initialGroup?: string;
  /** Label for the confirm button (defaults to "Save preset"). */
  saveLabel?: string;
  onSave: (result: {
    name: string;
    group: string;
    params: Partial<DevelopParams>;
  }) => void;
  onCancel: () => void;
}

/** Save Preset dialog: name + group + a checklist of which adjustments to keep,
 *  so a preset can carry as little as a single slider. Changed adjustments are
 *  pre-checked. Modeled on the app's modal pattern (see LensPickerDialog). */
export function PresetSaveDialog({
  params,
  groups,
  initialName,
  initialGroup,
  saveLabel = "Save preset",
  onSave,
  onCancel,
}: Props) {
  const fields = useMemo(() => presetFields(params), [params]);
  const [name, setName] = useState(initialName ?? "");
  const [group, setGroup] = useState(initialGroup ?? "");
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(fields.filter((f) => f.changed).map((f) => f.id)),
  );
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);

  const visible = showAll ? fields : fields.filter((f) => f.changed);
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const canSave = name.trim().length > 0 && selected.size > 0;
  const submit = () => {
    if (!canSave) return;
    onSave({
      name: name.trim(),
      group: group.trim(),
      params: buildPartialParams(params, fields, selected),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="flex max-h-[80vh] w-[360px] flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-xl">
        <div className="space-y-2 border-b border-[var(--color-border)] p-3">
          <input
            ref={nameRef}
            type="text"
            value={name}
            placeholder="Preset name"
            aria-label="Preset name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            className="w-full rounded bg-[var(--color-surface-2)] px-2 py-1 text-[12px] text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none"
          />
          <input
            type="text"
            value={group}
            placeholder="Group (optional)"
            aria-label="Preset group (optional)"
            list="preset-groups"
            onChange={(e) => setGroup(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            className="w-full rounded bg-[var(--color-surface-2)] px-2 py-1 text-[12px] text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none"
          />
          <datalist id="preset-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </div>

        <div className="flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
          <span>Include</span>
          <label className="flex cursor-pointer items-center gap-1 normal-case">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />
            Show all
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {visible.length === 0 ? (
            <div className="px-1 py-2 text-[11px] text-[var(--color-text-tertiary)]">
              No adjustments on this photo. Enable “Show all” to save defaults.
            </div>
          ) : (
            visible.map((f) => (
              <label
                key={f.id}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
              >
                <input
                  type="checkbox"
                  checked={selected.has(f.id)}
                  onChange={() => toggle(f.id)}
                />
                <span className="min-w-0 flex-1 truncate">{f.label}</span>
                {f.value && (
                  <span className="shrink-0 tabular-nums text-[var(--color-text-tertiary)]">
                    {f.value}
                  </span>
                )}
              </label>
            ))
          )}
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
            {saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
