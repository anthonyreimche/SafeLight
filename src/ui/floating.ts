// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

/** The surface every floating menu shares: the top-bar menus, the context
 *  menu, a Select's list and the status-bar popovers. Rows inside it highlight
 *  with surface-3; inside `p-1` padding they take `rounded-sm`, the menu's
 *  radius less the padding, so their corners run parallel to its own. */
export const MENU_SURFACE = "rounded-md border border-border bg-surface-2 shadow-xl";
