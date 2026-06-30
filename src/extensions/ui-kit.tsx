// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared UI primitives handed to extensions via api.ui.
//
// Why this exists: runtime-loaded extensions can't use Tailwind (the build only
// scans core), so each one used to hand-roll its own inline-styled buttons,
// selects, number inputs, toggles, etc. — ~60% of a typical extension's UI code,
// reinvented with subtly different padding / radius / font-size every time. These
// components are authored here (where Tailwind IS scanned) and rendered inside the
// extension's own subtree (same React tree), so they pick up the app theme and
// look identical everywhere. Styling matches the Preferences controls exactly —
// the same `labelCls` / `inputCls` SettingsFieldList already uses.
//
// Keep every Tailwind class LITERAL (no `gap-${n}` interpolation) — Tailwind only
// emits classes it can see in source. Dynamic values go through inline `style`.

import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { inputCls, labelCls } from "./SettingsFieldList";
import { Select as CoreSelect, type SelectGroup, type SelectOption } from "@/ui/components/Select";

// ── Buttons ──────────────────────────────────────────────────────────────────

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BTN_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded font-medium leading-none transition-colors disabled:opacity-45 disabled:cursor-default";
const BTN_SIZE = { sm: "px-2 py-1 text-[10px]", md: "px-3 py-1.5 text-[11px]" };
const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-slider-fill text-white hover:opacity-90",
  secondary: "border border-border bg-surface-2 text-text-primary hover:bg-surface-3",
  ghost: "bg-transparent text-text-secondary hover:bg-surface-2",
  danger: "border border-border bg-transparent text-[color:var(--color-label-red)] hover:bg-surface-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  /** Render as the selected/active state (accent fill), overriding the variant. */
  active?: boolean;
  /** Stretch to the container width. */
  full?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  active = false,
  full = false,
  className = "",
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const look = active ? "bg-slider-fill text-white" : BTN_VARIANT[variant];
  return (
    <button
      type={type}
      className={`${BTN_BASE} ${BTN_SIZE[size]} ${look} ${full ? "w-full" : ""} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// ── Form controls ─────────────────────────────────────────────────────────────

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  /** Flat options, or `groups` for headed sections. */
  options?: SelectOption[];
  groups?: SelectGroup[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  title?: string;
}

/** The app dropdown, full-width by default to match the old inline select. */
export function Select({ className = "", ...props }: SelectProps) {
  return <CoreSelect {...props} className={`w-full ${className}`} />;
}

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
}

export function TextInput({ value, onChange, className = "", ...rest }: TextInputProps) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      className={`${inputCls} ${className}`}
      {...rest}
    />
  );
}

export interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> {
  value: number;
  onChange: (value: number) => void;
  /** CSS width (e.g. "54px"); defaults to a compact fixed width. */
  width?: string;
}

export function NumberInput({
  value,
  onChange,
  width = "56px",
  className = "",
  style,
  ...rest
}: NumberInputProps) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
      style={{ width, ...style }}
      className={`rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary outline-none focus:bg-surface-3 ${className}`}
      {...rest}
    />
  );
}

export interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  /** Use the monospace font (for code / SVG markup). */
  mono?: boolean;
}

export function TextArea({ value, onChange, mono = false, rows = 4, className = "", ...rest }: TextAreaProps) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      spellCheck={false}
      className={`w-full resize-y rounded bg-surface-2 px-2 py-1.5 text-[11px] leading-relaxed text-text-primary outline-none placeholder:text-text-muted focus:bg-surface-3 ${mono ? "font-mono" : ""} ${className}`}
      {...rest}
    />
  );
}

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Optional inline label shown before the switch. */
  label?: ReactNode;
  ariaLabel?: string;
}

export function Toggle({ checked, onChange, label, ariaLabel }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2"
    >
      {label != null && <span className="text-[11px] text-text-primary">{label}</span>}
      <span
        className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${checked ? "bg-slider-fill" : "bg-surface-3"}`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${checked ? "left-3.5" : "left-0.5"}`}
        />
      </span>
    </button>
  );
}

export interface SegmentedOption {
  value: string;
  label: ReactNode;
  title?: string;
}

export interface SegmentedControlProps {
  value: string;
  onChange: (value: string) => void;
  options: SegmentedOption[];
  size?: "sm" | "md";
}

export function SegmentedControl({ value, onChange, options, size = "md" }: SegmentedControlProps) {
  const pad = size === "sm" ? "px-2 py-1 text-[10px]" : "px-2.5 py-1.5 text-[11px]";
  return (
    <div className="flex overflow-hidden rounded border border-border">
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`flex-1 ${pad} ${i > 0 ? "border-l border-border" : ""} ${
            value === o.value
              ? "bg-slider-fill text-white"
              : "bg-surface-2 text-text-secondary hover:bg-surface-3"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Layout & containers ───────────────────────────────────────────────────────

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}

/** A stacked label + control + hint, matching the Preferences field look. */
export function Field({ label, hint, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {label != null && <span className={labelCls}>{label}</span>}
      {children}
      {hint != null && (
        <p className="text-[10px] leading-relaxed text-text-muted">{hint}</p>
      )}
    </div>
  );
}

export interface SectionProps {
  title: ReactNode;
  /** Optional control rendered at the right of the section header. */
  right?: ReactNode;
  children: ReactNode;
}

/** A labelled group: an uppercase header (with optional right-aligned control)
 *  over its children. The recurring "section title + stack" pattern. */
export function Section({ title, right, children }: SectionProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className={labelCls}>{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

export interface CardProps {
  children: ReactNode;
  className?: string;
}

export function Card({ children, className = "" }: CardProps) {
  return (
    <div className={`rounded-lg border border-border-subtle bg-surface-1 p-3 ${className}`}>
      {children}
    </div>
  );
}

export interface BadgeProps {
  children: ReactNode;
  /** Explicit background colour; defaults to a neutral surface chip. */
  color?: string;
}

export function Badge({ children, color }: BadgeProps) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-1.5 py-0.5 text-[9px] font-medium leading-none ${
        color ? "text-white" : "bg-surface-3 text-text-secondary"
      }`}
      style={color ? { background: color } : undefined}
    >
      {children}
    </span>
  );
}

export interface ProgressBarProps {
  /** 0..1. */
  value: number;
}

export function ProgressBar({ value }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="h-1 w-full overflow-hidden rounded bg-surface-3">
      <div className="h-full bg-slider-fill transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

export interface StackProps {
  children: ReactNode;
  /** Gap in pixels. */
  gap?: number;
  style?: CSSProperties;
}

/** Vertical flex with a pixel gap (gaps are inline so any value works). */
export function Stack({ children, gap = 8, style }: StackProps) {
  return <div style={{ display: "flex", flexDirection: "column", gap, ...style }}>{children}</div>;
}

export interface RowProps {
  children: ReactNode;
  gap?: number;
  align?: CSSProperties["alignItems"];
  justify?: CSSProperties["justifyContent"];
  wrap?: boolean;
  style?: CSSProperties;
}

/** Horizontal flex with a pixel gap. */
export function Row({ children, gap = 8, align = "center", justify, wrap, style }: RowProps) {
  return (
    <div
      style={{
        display: "flex",
        gap,
        alignItems: align,
        justifyContent: justify,
        flexWrap: wrap ? "wrap" : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── Token reference ───────────────────────────────────────────────────────────

/** The canonical theme CSS-variable strings, for the rare inline-style case. Use
 *  these instead of hand-writing `var(--color-…)` so extensions can't drift onto
 *  names that don't exist (some did, e.g. `--color-text` / `--color-text-tertiary`). */
export const tokens = {
  surface0: "var(--color-surface-0)",
  surface1: "var(--color-surface-1)",
  surface2: "var(--color-surface-2)",
  surface3: "var(--color-surface-3)",
  surface4: "var(--color-surface-4)",
  border: "var(--color-border)",
  borderSubtle: "var(--color-border-subtle)",
  textPrimary: "var(--color-text-primary)",
  textSecondary: "var(--color-text-secondary)",
  textMuted: "var(--color-text-muted)",
  accent: "var(--color-accent)",
  accentHover: "var(--color-accent-hover)",
  sliderFill: "var(--color-slider-fill)",
  rating: "var(--color-rating)",
  fontMono: "var(--font-mono)",
} as const;

/** The whole kit, as handed to extensions via api.ui. */
export const uiKit = {
  Button,
  Select,
  TextInput,
  NumberInput,
  TextArea,
  Toggle,
  SegmentedControl,
  Field,
  Section,
  Card,
  Badge,
  ProgressBar,
  Stack,
  Row,
  tokens,
};
