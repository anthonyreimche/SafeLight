// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Custom Lightroom-style dock. Side rails are single scrollable columns where
// every docked panel renders at its natural height (height follows content and
// width — panels never get their own scrollbar; the rail scrolls), except that
// one `fill` panel per rail may stretch to the remaining height and scroll
// itself. Bottom rails are full-width horizontal strips under the main view
// whose panels sit side-by-side and always fill the rail height. Dragging a
// panel header re-docks it at any position in any rail, drops it on an edge
// strip to create a new rail, or anywhere else to float it as a window.
// Layouts persist per module; Tab hides everything and restores it unchanged.
//
// The dock lives in ./dock/: store (state + persistence), replacements (panel
// ids that moved), layouts (presets and user layouts), actions (toggles and
// mutations), dnd (hit-testing, drag, resize) and DockHost (rendering). This
// file is the public surface.

export { useDockStore } from "./dock/store";
export type { RailState, FloatState } from "./dock/store";
export { panelReplacements, replacePanelIds } from "./dock/replacements";
export type { DockPlacement } from "./dock/replacements";
export {
  CUSTOM_LAYOUT,
  useLayoutStore,
  useUserLayouts,
  applyDockLayout,
  initDockLayouts,
  addUserLayout,
  updateUserLayout,
  setLayoutSwitchesExtensions,
  setLayoutExtensions,
  recordActiveLayoutExtension,
  renameUserLayout,
  deleteUserLayout,
} from "./dock/layouts";
export type { UserLayout } from "./dock/layouts";
export {
  toggleDockPanel,
  toggleDockPanelFloating,
  toggleDockVisibility,
  toggleDockSide,
} from "./dock/actions";
export { DockPanelTitleCtx, useDockPlacement, DockHost } from "./dock/DockHost";
