// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Keyboard behaviour shared by the app's menus: focus the checked item on open,
// arrow / Home / End movement between enabled items with wrap, and type to jump.

import { createTypeahead, isTypeaheadKey, type Typeahead } from "@/ui/typeahead";

const ITEMS = '[role^="menuitem"]:not(:disabled)';

const enabledItems = (menu: HTMLElement | null): HTMLButtonElement[] =>
  Array.from(menu?.querySelectorAll<HTMLButtonElement>(ITEMS) ?? []);

// One prefix per open menu; it goes with the element when the menu closes.
const typeaheads = new WeakMap<HTMLElement, Typeahead>();

/** An item's visible name, without decorative glyphs such as the tick. */
function itemLabel(el: Element): string {
  let text = "";
  for (const node of Array.from(el.childNodes)) {
    if (node instanceof Element) {
      if (node.getAttribute("aria-hidden") !== "true") text += itemLabel(node);
    } else text += node.textContent ?? "";
  }
  return text;
}

export function focusInitialMenuItem(menu: HTMLElement | null): void {
  const items = enabledItems(menu);
  const checked = items.find((el) => el.getAttribute("aria-checked") === "true");
  (checked ?? items[0])?.focus();
}

export type MenuAxis = "vertical" | "horizontal";

export function handleMenuKeyDown(
  menu: HTMLElement | null,
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "preventDefault">,
  axis: MenuAxis,
): void {
  const items = enabledItems(menu);
  if (!menu || items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  let typeahead = typeaheads.get(menu);
  if (!typeahead) typeaheads.set(menu, (typeahead = createTypeahead()));
  // A space mid-prefix is part of the label being typed; otherwise it runs
  // the focused item, as Enter does.
  if (isTypeaheadKey(e) && (e.key !== " " || typeahead.active())) {
    e.preventDefault();
    const i = typeahead.match(items.map(itemLabel), e.key, at);
    if (i >= 0) items[i].focus();
    return;
  }
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
