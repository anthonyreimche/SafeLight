// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useMemo, useState } from "react";
import type { DevelopParams } from "@/catalog/types";
import { presetFields, buildPartialParams } from "@/modules/develop/preset-summary";
import type { DevelopClipboard } from "@/state/develop-clipboard";

/** Synthetic field id for the extension-stage param bag (not a DevelopParams key,
 *  so it's handled separately from buildPartialParams). */
const BAG_FIELD = "__paramBag";

interface Props {
  /** The source photo's saved develop params. */
  params: DevelopParams;
  /** The source photo's extension-stage params. */
  paramBag: Record<string, unknown>;
  /** Source photo filename, shown in the header. */
  sourceName: string;
  onCopy: (clip: DevelopClipboard) => void;
  onCancel: () => void;
}

/** Copy Settings dialog: the same adjustment checklist as Save Preset, so a copy
 *  can carry as little as a single slider. Changed adjustments are pre-checked.
 *  Mirrors PresetSaveDialog's layout, minus the name/group inputs. */
export function CopySettingsDialog({
  params,
  paramBag,
  sourceName,
  onCopy,
  onCancel,
}: Props) {
  const fields = useMemo(() => presetFields(params), [params]);
  const hasBag = Object.keys(paramBag).length > 0;
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set([
        ...fields.filter((f) => f.changed).map((f) => f.id),
        ...(hasBag ? [BAG_FIELD] : []),
      ]),
  );

  const visible = showAll ? fields : fields.filter((f) => f.changed);
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const includeBag = selected.has(BAG_FIELD);
  const canCopy = selected.size > 0;
  const submit = () => {
    if (!canCopy) return;
    const partial = buildPartialParams(params, fields, selected);
    const scalarCount = selected.size - (includeBag ? 1 : 0);
    onCopy({
      params: partial,
      paramBag: includeBag ? structuredClone(paramBag) : {},
      sourceName,
      fieldCount: scalarCount + (includeBag ? 1 : 0),
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
        <div className="border-b border-[var(--color-border)] p-3">
          <div className="text-[12px] font-medium text-[var(--color-text)]">
            Copy settings
          </div>
          <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-tertiary)]">
            from {sourceName}
          </div>
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
          {visible.length === 0 && !hasBag ? (
            <div className="px-1 py-2 text-[11px] text-[var(--color-text-tertiary)]">
              No adjustments on this photo. Enable “Show all” to copy defaults.
            </div>
          ) : (
            <>
              {visible.map((f) => (
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
              ))}
              {hasBag && (
                <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]">
                  <input
                    type="checkbox"
                    checked={includeBag}
                    onChange={() => toggle(BAG_FIELD)}
                  />
                  <span className="min-w-0 flex-1 truncate">Extension stages</span>
                </label>
              )}
            </>
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
            disabled={!canCopy}
            className="rounded bg-[var(--color-accent)] px-3 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={submit}
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}
