// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { AppModule } from "@/catalog/types";
import { MODULE_ID, hasModule, moduleTabs } from "@/extensions/registry";
import { useUIStore } from "./ui-store";
import { broadcast } from "./broadcast";
import { privilegedWindow } from "@/native/privileged";

// The module this window is dedicated to, if it was opened as a detached window.
// Not checked against the registry: external plugins load after first paint, so
// a registered module's window must be recognized before its extension is.
export function detachedModule(): AppModule | null {
  const m = new URLSearchParams(window.location.search).get("detached");
  return m && MODULE_ID.test(m) ? m : null;
}

const popOutFailed = (err: unknown) => console.warn("[safelight] pop-out window:", err);

// The main process opens each module's window (one per module) and focuses it
// when it is open already. Never window.open: the opener would hold the
// pop-out's object, and extensions share this realm.
export function detachModule(module: AppModule): void {
  const bridge = privilegedWindow();
  if (!bridge) return;
  bridge.openApp("module", module).catch(popOutFailed);
  markModuleDetached(module);
}

/** The main window records `module` as in its own window and, if it is showing
 *  it, moves to `previous` when that is still here, else to the first tab that is. */
export function markModuleDetached(module: AppModule, previous?: AppModule): void {
  const ui = useUIStore.getState();
  ui.markDetached(module);
  // The main window shouldn't keep showing a module that's now in its own window.
  if (ui.activeModule !== module) return;
  const { detached } = useUIStore.getState();
  const next =
    previous && previous !== module && !detached.has(previous) && hasModule(previous)
      ? previous
      : moduleTabs().find((m) => !detached.has(m.id))?.id;
  if (next) ui.setActiveModule(next);
}

export function focusDetached(module: AppModule): void {
  privilegedWindow()?.openApp("module", module).catch(popOutFailed);
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
    privilegedWindow()?.focusMain().catch(popOutFailed);
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
  privilegedWindow()?.closeApp("module", module).catch(popOutFailed);
  const ui = useUIStore.getState();
  ui.markAttached(module);
  ui.setActiveModule(module);
}

// Re-attach from within a detached window: tell the main window, then close.
export function reattachSelf(module: AppModule): void {
  broadcast({ type: "attach", payload: { module } });
  window.close();
}
