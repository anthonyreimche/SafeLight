// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { AppModule } from "@/catalog/types";
import { MODULE_ID, hasModule, moduleTabs } from "@/extensions/registry";
import { useUIStore } from "./ui-store";
import { broadcast } from "./broadcast";

// The module this window is dedicated to, if it was opened as a detached window.
// Not checked against the registry: external plugins load after first paint, so
// a registered module's window must be recognised before its extension is.
export function detachedModule(): AppModule | null {
  const m = new URLSearchParams(window.location.search).get("detached");
  return m && MODULE_ID.test(m) ? m : null;
}

// Live references to the windows this (main) window has popped out, so they can
// be focused/closed. The window `name` also enforces a single instance per
// module at the browser level; its "safelight-module-" prefix keeps every module
// clear of the Developer Tools window's "safelight-devtools".
const popped = new Map<AppModule, Window>();

export function detachModule(module: AppModule): void {
  const existing = popped.get(module);
  if (existing && !existing.closed) {
    existing.focus();
    return;
  }
  const url = `${window.location.origin}${window.location.pathname}?detached=${encodeURIComponent(module)}`;
  const win = window.open(url, `safelight-module-${module}`, "width=1280,height=860");
  if (!win) return;
  popped.set(module, win);

  const ui = useUIStore.getState();
  ui.markDetached(module);
  // The main window shouldn't keep showing a module that's now in its own window.
  if (ui.activeModule === module) {
    const next = moduleTabs().find((m) => !useUIStore.getState().detached.has(m.id));
    if (next) ui.setActiveModule(next.id);
  }
  win.focus();
}

export function focusDetached(module: AppModule): void {
  const win = popped.get(module);
  if (win && !win.closed) win.focus();
  else detachModule(module); // ref lost (e.g. after a reload) → reopen/focus
}

// api.navigation.goTo. A pop-out shows only its own module, so it hands any
// other id to the main window (over the sync channel) and brings that forward.
// The main window ignores an id it doesn't know, focuses a popped-out module's
// window, and otherwise switches to the module.
export function goToModule(module: AppModule): void {
  const own = detachedModule();
  if (own) {
    if (module === own) return;
    broadcast({ type: "navigate", payload: { module } });
    (window.opener as Window | null)?.focus();
    return;
  }
  if (!hasModule(module)) {
    console.warn(
      `[extensions] navigation.goTo: "${module}" is not a built-in or registered module; ignored`,
    );
    return;
  }
  const ui = useUIStore.getState();
  if (ui.detached.has(module)) focusDetached(module);
  else ui.setActiveModule(module);
}

// Re-attach from the main window: close the popped window and reclaim the module.
export function attachModule(module: AppModule): void {
  const win = popped.get(module);
  if (win && !win.closed) win.close();
  popped.delete(module);
  const ui = useUIStore.getState();
  ui.markAttached(module);
  ui.setActiveModule(module);
}

// Re-attach from within a detached window: tell the main window, then close.
export function reattachSelf(module: AppModule): void {
  broadcast({ type: "attach", payload: { module } });
  window.close();
}
