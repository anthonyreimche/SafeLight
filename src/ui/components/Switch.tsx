// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The app's one toggle switch: a `role="switch"` button whose track and knob
// carry the `sl-switch*` styling hooks that input-styling extensions target.
// `children` render before the track as the visible label; give the button a
// full-width layout via `className` and the whole row becomes the hit target.

import type { ReactNode } from "react";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  /** Layout classes for the button (it is already an inline-flex row). */
  className?: string;
  /** Visible label, rendered before the track. */
  children?: ReactNode;
}

export function Switch({
  checked,
  onChange,
  ariaLabel,
  title,
  disabled,
  className = "",
  children,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`sl-switch inline-flex items-center ${className}`}
    >
      {children}
      <span
        aria-hidden="true"
        className={`sl-switch-track relative h-4 w-7 shrink-0 rounded-full transition-colors ${
          checked ? "bg-slider-fill" : "bg-surface-3"
        }`}
      >
        <span
          className={`sl-switch-knob absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
            checked ? "left-3.5" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}
