import type { PresetDiff } from "../preset-summary";

interface Props {
  name: string;
  diffs: PresetDiff[];
}

/** Hover popover listing a preset's non-default adjustments. Positioned to the
 *  left of its row (panels live on the right rail) so it doesn't clip off the
 *  narrow sidebar. Rendered inside a `relative` row. */
export function PresetTooltip({ name, diffs }: Props) {
  return (
    <div className="pointer-events-none absolute right-full top-0 z-50 mr-2 w-48 rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2 text-[11px] shadow-xl">
      <div className="mb-1 truncate font-semibold text-[var(--color-text)]">
        {name}
      </div>
      <div className="mb-1 border-t border-[var(--color-border)]" />
      {diffs.length === 0 ? (
        <div className="text-[var(--color-text-tertiary)]">No adjustments</div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {diffs.map((d) => (
            <div key={d.label} className="flex justify-between gap-2">
              <span className="truncate text-[var(--color-text-secondary)]">
                {d.label}
              </span>
              <span className="shrink-0 tabular-nums text-[var(--color-text)]">
                {d.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
