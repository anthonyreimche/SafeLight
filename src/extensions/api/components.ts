// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The props of the core components api.components and api.ui hand out.

import type {
  ButtonHTMLAttributes,
  CSSProperties,
  DragEvent,
  InputHTMLAttributes,
  JSX,
  MouseEvent,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import type {
  CatalogPhoto,
  CurvePoint,
  ToneCurveChannel,
  ToneCurves,
} from "@/catalog/types";
import type { HistogramData } from "@/rendering/histogram";
import type { SlotName } from "./contributions";
import type { ClippingMask } from "./stores";

// ── api.components ───────────────────────────────────────────────────────────

export interface PanelProps {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

export interface SliderProps {
  label: string;
  /** Accessible name when `label` is intentionally empty. */
  ariaLabel?: string;
  /** Slider-icon contribution id (e.g. "core.exposure"); renders nothing if
   *  unregistered. */
  icon?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Double-clicking the track resets to this. */
  defaultValue?: number;
  /** Hide the editable numeric field. */
  hideValue?: boolean;
  /** Narrow label and value, for tight columns. */
  compact?: boolean;
  /** CSS background for the track (e.g. a hue gradient), drawn with a thumb
   *  marker instead of the filled bar. */
  trackBackground?: string;
  onChange: (value: number) => void;
  onCommit?: () => void;
  /** Fired with true while a drag is held with Alt or Ctrl down, and false
   *  when that ends. */
  onModifierPreview?: (active: boolean) => void;
}

/** Tonal zones across the histogram, left (dark) to right (light). */
export type HistogramZone =
  | "blacks"
  | "shadows"
  | "exposure"
  | "highlights"
  | "whites";

export interface HistogramProps {
  data: HistogramData | null;
  onAdjust?: (zone: HistogramZone, deltaPx: number, phase: "start" | "move" | "end") => void;
  onReset?: (zone: HistogramZone) => void;
  showClipping?: ClippingMask;
  onToggleClipping?: () => void;
  onSetClipping?: (mode: ClippingMask) => void;
}

export interface CurveEditorProps {
  curves: ToneCurves;
  onChange: (channel: ToneCurveChannel, points: CurvePoint[]) => void;
  onCommit: () => void;
  /** Compact mode for embedding inside another panel (mask sub-panels). */
  compact?: boolean;
  /** Show the selected point's In/Out row even without keyboard canvas editing. */
  showPointValues?: boolean;
}

/** Callbacks take the photo id, so one stable function serves every cell. */
export interface ThumbnailProps {
  photo: CatalogPhoto;
  selected: boolean;
  active: boolean;
  size: number;
  onClick: (id: string, e: MouseEvent) => void;
  onDoubleClick?: (id: string) => void;
  onContextMenu?: (id: string, e: MouseEvent) => void;
  onRatingChange?: (id: string, rating: number) => void;
  onDragStart?: (id: string, e: DragEvent) => void;
}

export interface PhotoListRowProps {
  photo: CatalogPhoto;
  selected: boolean;
  active: boolean;
  /** Drop the dimension and camera columns, for rows in a narrow container. */
  compact?: boolean;
  onClick: (id: string, e: MouseEvent) => void;
  onDoubleClick: (id: string) => void;
  onContextMenu?: (id: string, e: MouseEvent) => void;
  onDragStart?: (id: string, e: DragEvent) => void;
}

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  /** Render in the red danger colour (e.g. Remove). */
  danger?: boolean;
  disabled?: boolean;
}

/** A horizontal divider between groups of items. */
export type ContextMenuEntry = ContextMenuItem | "separator";

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}

export interface ScaleStepperProps {
  value: number;
  onChange: (value: number) => void;
  label: string;
}

export interface SlotProps {
  name: SlotName;
  fallback?: ReactNode;
}

export interface MaskScopeProps {
  maskId: string;
  children: ReactNode;
}

export interface DevelopCanvasProps {
  /** The view's zoom: null fits the photo, 1 is 100%. */
  zoom: number | null;
  onZoomChange(zoom: number | null): void;
  /** Shown in the surround while no photo is open. */
  empty?: ReactNode;
}

// ── api.ui ───────────────────────────────────────────────────────────────────

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  /** Render as the selected/active state (accent fill), overriding the variant. */
  active?: boolean;
  /** Stretch to the container width. */
  full?: boolean;
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectGroup {
  /** Optional heading shown above the group (like <optgroup label>). */
  title?: string;
  items: SelectOption[];
}

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

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
}

export interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> {
  value: number;
  onChange: (value: number) => void;
  /** CSS width (e.g. "54px"); defaults to a compact fixed width. */
  width?: string;
}

export interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  /** Use the monospace font (for code / SVG markup). */
  mono?: boolean;
}

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Optional inline label shown before the switch. */
  label?: ReactNode;
  ariaLabel?: string;
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

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}

export interface SectionProps {
  title: ReactNode;
  /** Optional control rendered at the right of the section header. */
  right?: ReactNode;
  children: ReactNode;
}

export interface CardProps {
  children: ReactNode;
  className?: string;
}

export interface BadgeProps {
  children: ReactNode;
  /** Explicit background colour; defaults to a neutral surface chip. */
  color?: string;
}

export interface ProgressBarProps {
  /** 0..1. */
  value: number;
}

export interface StackProps {
  children: ReactNode;
  /** Gap in pixels. */
  gap?: number;
  style?: CSSProperties;
}

export interface RowProps {
  children: ReactNode;
  gap?: number;
  align?: CSSProperties["alignItems"];
  justify?: CSSProperties["justifyContent"];
  wrap?: boolean;
  style?: CSSProperties;
}

/** The canonical theme CSS-variable strings, for the rare inline-style case. */
export interface UITokens {
  readonly surface0: "var(--color-surface-0)";
  readonly surface1: "var(--color-surface-1)";
  readonly surface2: "var(--color-surface-2)";
  readonly surface3: "var(--color-surface-3)";
  readonly surface4: "var(--color-surface-4)";
  readonly border: "var(--color-border)";
  readonly borderSubtle: "var(--color-border-subtle)";
  readonly textPrimary: "var(--color-text-primary)";
  readonly textSecondary: "var(--color-text-secondary)";
  readonly textMuted: "var(--color-text-muted)";
  readonly accent: "var(--color-accent)";
  readonly accentHover: "var(--color-accent-hover)";
  readonly sliderFill: "var(--color-slider-fill)";
  readonly rating: "var(--color-rating)";
  readonly labelRed: "var(--color-label-red)";
  readonly labelYellow: "var(--color-label-yellow)";
  readonly labelGreen: "var(--color-label-green)";
  readonly labelBlue: "var(--color-label-blue)";
  readonly labelPurple: "var(--color-label-purple)";
  readonly white: "var(--color-white)";
  readonly fontMono: "var(--font-mono)";
  readonly fontCode: "var(--font-code)";
}

export interface UIKit {
  Button: (props: ButtonProps) => JSX.Element;
  Select: (props: SelectProps) => JSX.Element;
  TextInput: (props: TextInputProps) => JSX.Element;
  NumberInput: (props: NumberInputProps) => JSX.Element;
  TextArea: (props: TextAreaProps) => JSX.Element;
  Toggle: (props: ToggleProps) => JSX.Element;
  SegmentedControl: (props: SegmentedControlProps) => JSX.Element;
  Field: (props: FieldProps) => JSX.Element;
  Section: (props: SectionProps) => JSX.Element;
  Card: (props: CardProps) => JSX.Element;
  Badge: (props: BadgeProps) => JSX.Element;
  ProgressBar: (props: ProgressBarProps) => JSX.Element;
  Stack: (props: StackProps) => JSX.Element;
  Row: (props: RowProps) => JSX.Element;
  tokens: UITokens;
}

// ── api.devtools ─────────────────────────────────────────────────────────────

export interface DevFolderControlsProps {
  /** Laid out for the Developer Tools tab or a settings dialogue. */
  variant: "tab" | "settings";
}
