// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The app's dropdown. A custom listbox that replaces the native <select> so every
// dropdown matches the theme (the native popup can't be styled and ignores the
// app's dark surfaces). Drop-in for `<select value onChange>` with <option>s:
// pass `options`, or `groups` for headed sections (the old <optgroup>). The menu
// is portalled to <body> and fixed-positioned from the trigger rect, so it's
// never clipped by a scroll container and sits above dialogs. Keyboard: open with
// Enter/Space/↑/↓, navigate with ↑/↓/Home/End, type to jump, Enter to choose,
// Esc to close.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { pushEscapeHandler } from "@/ui/escape-stack";

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
  /** Flat options, or use `groups` for headed sections. */
  options?: SelectOption[];
  groups?: SelectGroup[];
  placeholder?: string;
  disabled?: boolean;
  /** Extra classes for the trigger (width, margin, etc.). */
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  title?: string;
}

const TRIGGER_CLS =
  "inline-flex items-center justify-between gap-2 rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary outline-none cursor-pointer hover:bg-surface-3 focus-visible:ring-1 focus-visible:ring-slider-fill disabled:cursor-default disabled:opacity-45";

function firstEnabled(list: SelectOption[]): number {
  for (let i = 0; i < list.length; i++) if (!list[i].disabled) return i;
  return -1;
}
function lastEnabled(list: SelectOption[]): number {
  for (let i = list.length - 1; i >= 0; i--) if (!list[i].disabled) return i;
  return -1;
}
function step(list: SelectOption[], from: number, dir: number): number {
  if (list.length === 0) return -1;
  let i = from;
  for (let n = 0; n < list.length; n++) {
    i = (i + dir + list.length) % list.length;
    if (!list[i].disabled) return i;
  }
  return from;
}

export function Select({
  value,
  onChange,
  options,
  groups,
  placeholder,
  disabled,
  className = "",
  style,
  ariaLabel,
  title,
}: SelectProps) {
  const groupList: SelectGroup[] = groups ?? [{ items: options ?? [] }];
  const flat: SelectOption[] = groupList.flatMap((g) => g.items);
  const selectedIndex = flat.findIndex((o) => o.value === value);
  // Trigger label is qualified by its group heading (e.g. "Grain · Amount"), so a
  // selection stays unambiguous once the menu is closed; list items stay short.
  let currentLabel = placeholder ?? "";
  for (const g of groupList)
    for (const o of g.items)
      if (o.value === value) currentLabel = g.title ? `${g.title} · ${o.label}` : o.label;

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{
    left: number;
    edge: number;
    width: number;
    maxH: number;
    up: boolean;
  } | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef<{ str: string; t: number }>({ str: "", t: 0 });
  const baseId = useId();

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const above = r.top;
    const up = below < 220 && above > below;
    const maxH = Math.max(120, Math.min(280, (up ? above : below) - 12));
    setPos({
      left: r.left,
      edge: up ? window.innerHeight - r.top : r.bottom,
      width: r.width,
      maxH,
      up,
    });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    // Close on Escape via the shared stack, so the menu (most recently opened)
    // closes before any dialog it lives inside.
    const popEsc = pushEscapeHandler(() => setOpen(false));
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      popEsc();
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const el = menuRef.current?.querySelector(`[data-idx="${active}"]`);
    (el as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const openMenu = () => {
    if (disabled) return;
    setActive(selectedIndex >= 0 ? selectedIndex : firstEnabled(flat));
    setOpen(true);
  };
  const choose = (o: SelectOption | undefined) => {
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => step(flat, i, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => step(flat, i, -1));
        break;
      case "Home":
        e.preventDefault();
        setActive(firstEnabled(flat));
        break;
      case "End":
        e.preventDefault();
        setActive(lastEnabled(flat));
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(flat[active]);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = Date.now();
          typeahead.current.str =
            now - typeahead.current.t > 600 ? e.key : typeahead.current.str + e.key;
          typeahead.current.t = now;
          const q = typeahead.current.str.toLowerCase();
          const idx = flat.findIndex(
            (o) => !o.disabled && o.label.toLowerCase().startsWith(q),
          );
          if (idx >= 0) setActive(idx);
        }
    }
  };

  let idx = -1;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-activedescendant={open && active >= 0 ? `${baseId}-opt-${active}` : undefined}
        aria-label={ariaLabel}
        title={title}
        // This custom dropdown is a <button>, not a native <select>, so the
        // global capture-phase shortcut handler doesn't treat it as a text-entry
        // target by default — it would steal the keys this listbox needs (↑/↓,
        // Enter/Space to open, type-ahead letters), especially once an extension
        // binds a bare key. Opt into the keyboard-capture convention so the
        // global handlers defer while the trigger is focused, exactly as they did
        // for the native <select> this replaced. See isEditableTarget().
        data-keyboard-capture=""
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        className={`${TRIGGER_CLS} ${className}`}
        style={style}
      >
        <span className="truncate">{currentLabel}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" className="shrink-0 opacity-60" aria-hidden="true">
          <path
            d="M6 9l6 6 6-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.up ? undefined : pos.edge + 4,
              bottom: pos.up ? pos.edge + 4 : undefined,
              width: pos.width,
              maxHeight: pos.maxH,
              zIndex: 9999,
            }}
            className="overflow-y-auto rounded-md border border-border bg-surface-1 p-1 shadow-xl"
          >
            {groupList.map((g, gi) => (
              <div key={gi}>
                {g.title && (
                  <div className="px-2 pb-0.5 pt-1 text-[9px] uppercase tracking-widest text-text-muted">
                    {g.title}
                  </div>
                )}
                {g.items.map((o) => {
                  idx += 1;
                  const i = idx;
                  const sel = o.value === value;
                  const act = i === active;
                  return (
                    <div
                      key={o.value}
                      id={`${baseId}-opt-${i}`}
                      data-idx={i}
                      role="option"
                      aria-selected={sel}
                      aria-disabled={o.disabled || undefined}
                      onMouseEnter={() => !o.disabled && setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(o)}
                      className={`truncate rounded px-2 py-1 text-[11px] ${
                        o.disabled
                          ? "cursor-default text-text-muted opacity-60"
                          : sel
                            ? "cursor-pointer bg-slider-fill text-white"
                            : act
                              ? "cursor-pointer bg-surface-3 text-text-primary"
                              : "cursor-pointer text-text-primary"
                      }`}
                    >
                      {o.label}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
