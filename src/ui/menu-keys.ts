// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Keyboard behaviour shared by the status-bar popover menus: focus the checked
// item on open, and arrow / Home / End movement between enabled items with wrap.

const ITEMS = '[role^="menuitem"]:not(:disabled)';

const enabledItems = (menu: HTMLElement | null): HTMLButtonElement[] =>
  Array.from(menu?.querySelectorAll<HTMLButtonElement>(ITEMS) ?? []);

export function focusInitialMenuItem(menu: HTMLElement | null): void {
  const items = enabledItems(menu);
  const checked = items.find((el) => el.getAttribute("aria-checked") === "true");
  (checked ?? items[0])?.focus();
}

export type MenuAxis = "vertical" | "horizontal";

export function handleMenuKeyDown(
  menu: HTMLElement | null,
  e: Pick<KeyboardEvent, "key" | "preventDefault">,
  axis: MenuAxis,
): void {
  const items = enabledItems(menu);
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = axis === "vertical" ? ["ArrowDown"] : ["ArrowRight", "ArrowDown"];
  const prev = axis === "vertical" ? ["ArrowUp"] : ["ArrowLeft", "ArrowUp"];
  const target = next.includes(e.key)
    ? items[(at + 1) % items.length]
    : prev.includes(e.key)
      ? items[at <= 0 ? items.length - 1 : at - 1]
      : e.key === "Home"
        ? items[0]
        : e.key === "End"
          ? items[items.length - 1]
          : null;
  if (!target) return;
  e.preventDefault();
  target.focus();
}
