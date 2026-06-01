import type { AppModule } from "@/catalog/types";
import { useUIStore } from "./ui-store";
import { broadcast } from "./broadcast";

export const MODULES: AppModule[] = ["library", "develop", "loupe", "export"];

export const MODULE_LABELS: Record<AppModule, string> = {
  library: "Library",
  develop: "Develop",
  loupe: "Loupe",
  export: "Export",
};

// The module this window is dedicated to, if it was opened as a detached window.
export function detachedModule(): AppModule | null {
  const m = new URLSearchParams(window.location.search).get("detached");
  return m && (MODULES as string[]).includes(m) ? (m as AppModule) : null;
}

// Live references to the windows this (main) window has popped out, so they can
// be focused/closed. The window `name` also enforces a single instance per
// module at the browser level.
const popped = new Map<AppModule, Window>();

export function detachModule(module: AppModule): void {
  const existing = popped.get(module);
  if (existing && !existing.closed) {
    existing.focus();
    return;
  }
  const url = `${window.location.origin}${window.location.pathname}?detached=${module}`;
  const win = window.open(url, `safelight-${module}`, "width=1280,height=860");
  if (!win) return;
  popped.set(module, win);

  const ui = useUIStore.getState();
  ui.markDetached(module);
  // The main window shouldn't keep showing a module that's now in its own window.
  if (ui.activeModule === module) {
    const next = MODULES.find((m) => !useUIStore.getState().detached.has(m));
    if (next) ui.setActiveModule(next);
  }
  win.focus();
}

export function focusDetached(module: AppModule): void {
  const win = popped.get(module);
  if (win && !win.closed) win.focus();
  else detachModule(module); // ref lost (e.g. after a reload) → reopen/focus
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
