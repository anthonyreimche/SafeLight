// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Keeps Tab inside a modal surface, per WCAG 2.4.3 (focus order) / modal focus
// containment: Tab from the last tab stop wraps to the first, Shift+Tab from
// the first wraps to the last. Focus on something inside that isn't a tab stop
// (a step heading, the container itself) moves to the nearest tab stop in the
// direction of travel, since the browser would otherwise step out of the
// surface from it. With no tab stops at all, Tab does nothing. Tab stops that
// aren't laid out (display:none, collapsed) are skipped, since focusing them
// would lose the user.

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const follows = (el: Node, from: Node): boolean =>
  (from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

export function trapTab(
  e: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">,
  container: HTMLElement | null,
): void {
  if (e.key !== "Tab" || !container) return;
  const items = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE),
  ).filter((el) => el.getClientRects().length > 0);
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const atStop = items.some((el) => el === active);
  if (active && !atStop && container.contains(active)) {
    e.preventDefault();
    const next = e.shiftKey
      ? (items.findLast((el) => follows(active, el)) ?? last)
      : (items.find((el) => follows(el, active)) ?? first);
    next.focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
