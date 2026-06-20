import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PresetDiff } from "../preset-summary";

interface Props {
  name: string;
  diffs: PresetDiff[];
  /** The hovered row the tooltip is anchored to. */
  anchor: HTMLElement;
}

const GAP = 8;
const MARGIN = 8;

/** Hover popover listing a preset's non-default adjustments. Rendered in a
 *  portal at the document level so it's never clipped by the panel's scroll
 *  region, and flips to whichever side of the panel has room in the viewport. */
export function PresetTooltip({ name, diffs, anchor }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const place = () => {
      const a = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;

      // Prefer the right side; flip left if it would overflow the viewport.
      const fitsRight = a.right + GAP + w + MARGIN <= window.innerWidth;
      const left = fitsRight ? a.right + GAP : a.left - GAP - w;

      // Align to the row's top, clamped within the viewport.
      const top = Math.max(
        MARGIN,
        Math.min(a.top, window.innerHeight - h - MARGIN),
      );
      setPos({ top, left });
    };

    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, name, diffs]);

  return createPortal(
    <div
      ref={ref}
      className="pointer-events-none fixed z-[1000] w-48 rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2 text-[11px] shadow-xl"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
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
    </div>,
    document.body,
  );
}
