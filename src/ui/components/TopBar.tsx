import { useEffect, useRef } from "react";
import { useUIStore } from "@/state/ui-store";
import { useCatalogStore } from "@/state/catalog-store";
import {
  MODULES,
  MODULE_LABELS,
  attachModule,
  detachModule,
  detachedModule,
  focusDetached,
  reattachSelf,
} from "@/state/detach";
import { ViewMenu } from "./ViewMenu";
import { LayoutMenu } from "./LayoutMenu";
import { openPreferences } from "./PreferencesDialog";

const prefsButton = (
  <button
    onClick={openPreferences}
    title="Preferences (Ctrl+,)"
    className="rounded px-2 py-1 text-[13px] leading-none text-text-secondary hover:text-text-primary"
  >
    ⚙
  </button>
);

export function TopBar() {
  const dm = detachedModule();
  const activeModule = useUIStore((s) => s.activeModule);
  const setActiveModule = useUIStore((s) => s.setActiveModule);
  const detached = useUIStore((s) => s.detached);
  const needsReconnect = useCatalogStore((s) => s.needsReconnect);
  const reconnecting = useCatalogStore((s) => s.reconnecting);
  const reconnectFiles = useCatalogStore((s) => s.reconnectFiles);

  // Browsers only allow re-requesting file permission inside a user gesture, so
  // we arm a one-time listener: the first click anywhere triggers the reconnect.
  const armed = useRef(false);
  useEffect(() => {
    if (!needsReconnect || armed.current) return;
    armed.current = true;
    const onGesture = () => void reconnectFiles();
    window.addEventListener("pointerdown", onGesture, { once: true });
    return () => window.removeEventListener("pointerdown", onGesture);
  }, [needsReconnect, reconnectFiles]);

  const reconnectButton =
    needsReconnect || reconnecting ? (
      <button
        onClick={() => void reconnectFiles()}
        disabled={reconnecting}
        title="Re-grant access to your project folder so Develop and Export use full-resolution originals (browsers reset this each session)."
        className="flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-70"
      >
        {reconnecting && (
          <span className="h-2.5 w-2.5 animate-spin rounded-full border border-white/40 border-t-white" />
        )}
        {reconnecting ? "Reconnecting…" : "Reconnect originals"}
      </button>
    ) : null;

  // Detached window: just the brand + the module name + a re-attach control.
  if (dm) {
    return (
      <div className="flex h-9 items-center justify-between border-b border-border bg-surface-1 px-3">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold tracking-widest text-text-secondary">
            SAFELIGHT
          </span>
          <span className="text-[11px] uppercase tracking-wider text-text-primary">
            {MODULE_LABELS[dm]}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {reconnectButton}
          {prefsButton}
          <button
            onClick={() => reattachSelf(dm)}
            title="Return this window to the main app"
            className="rounded bg-surface-3 px-3 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary"
          >
            {"⧈"} Re-attach
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-9 items-center justify-between border-b border-border bg-surface-1 px-3">
      <div className="flex items-center gap-1">
        <span className="mr-3 text-xs font-semibold tracking-widest text-text-secondary">
          SAFELIGHT
        </span>
        {MODULES.map((m) => {
          const isDetached = detached.has(m);
          const isActive = activeModule === m && !isDetached;
          return (
            <div key={m} className="flex items-center rounded">
              <button
                onClick={() => (isDetached ? focusDetached(m) : setActiveModule(m))}
                className={`rounded-l px-3 py-1 text-[11px] uppercase tracking-wider transition-colors ${
                  isActive
                    ? "bg-surface-3 text-text-primary"
                    : isDetached
                      ? "italic text-text-muted hover:text-text-secondary"
                      : "text-text-secondary hover:text-text-primary"
                }`}
                title={isDetached ? "Open in its window" : undefined}
              >
                {MODULE_LABELS[m]}
              </button>
              <button
                onClick={() => (isDetached ? attachModule(m) : detachModule(m))}
                title={isDetached ? "Re-attach to this window" : "Open in a new window"}
                className="rounded-r py-1 pr-1.5 pl-0.5 text-[10px] text-text-muted hover:text-text-primary"
              >
                {isDetached ? "⧈" : "⧉"}
              </button>
            </div>
          );
        })}
        <div className="mx-1 h-4 w-px bg-border" />
        <ViewMenu />
        <LayoutMenu />
        <button
          onClick={openPreferences}
          title="Preferences (Ctrl+,)"
          className="rounded px-3 py-1 text-[11px] uppercase tracking-wider text-text-secondary transition-colors hover:text-text-primary"
        >
          Preferences
        </button>
      </div>
      <div className="flex items-center gap-2">{reconnectButton}</div>
    </div>
  );
}
