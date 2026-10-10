// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The interface-scale control: − and + around the current value, in 10% steps
// between 80% and 200%. Buttons rather than a slider because the setting
// rescales the whole window (CSS zoom on <body>), so a dragged thumb slides
// out from under the pointer. An end button that can't step further stays
// focusable and says so (aria-disabled): `disabled` would drop keyboard focus
// mid-press.

import { canStepUiScale, stepUiScale } from "@/state/settings-store";

const stepBtn =
  "flex h-7 w-8 items-center justify-center bg-surface-3 text-[13px] text-text-primary hover:bg-surface-4 aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-surface-3";

export function ScaleStepper({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  /** Accessible name of the control, e.g. "Interface scale". */
  label: string;
}) {
  const name = label.toLowerCase();
  const step = (direction: -1 | 1) => {
    if (canStepUiScale(value, direction))
      onChange(stepUiScale(value, direction));
  };
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex items-center rounded border border-border"
    >
      <button
        type="button"
        className={`${stepBtn} rounded-l`}
        aria-label={`Decrease ${name}`}
        aria-disabled={!canStepUiScale(value, -1) || undefined}
        onClick={() => step(-1)}
      >
        −
      </button>
      <output
        aria-live="polite"
        className="min-w-[3.5rem] px-2 text-center text-[12px] text-text-primary"
      >
        {`${Math.round(value * 100)}%`}
      </output>
      <button
        type="button"
        className={`${stepBtn} rounded-r`}
        aria-label={`Increase ${name}`}
        aria-disabled={!canStepUiScale(value, 1) || undefined}
        onClick={() => step(1)}
      >
        +
      </button>
    </div>
  );
}
