// Application-wide Extensions pop-up (the puzzle button in the top bar). Wraps
// the existing ExtensionManagerPanel in a modal styled like Preferences, so
// extensions are managed in a window instead of a dockable panel.

import { useEffect } from "react";
import { create } from "zustand";
import { ExtensionManagerPanel } from "@/extensions/ExtensionManagerPanel";
import { pushEscapeHandler } from "@/ui/escape-stack";

const useOpen = create<{ open: boolean }>(() => ({ open: false }));
export const openExtensions = () => useOpen.setState({ open: true });
export const closeExtensions = () => useOpen.setState({ open: false });
export const toggleExtensions = () =>
  useOpen.setState((s) => ({ open: !s.open }));

export function ExtensionsDialog() {
  const open = useOpen((s) => s.open);
  // Esc closes the dialog, via the shared modal stack (topmost first).
  useEffect(() => {
    if (!open) return;
    return pushEscapeHandler(closeExtensions);
  }, [open]);
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) closeExtensions();
      }}
    >
      <div className="flex h-[560px] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-2xl">
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-2 px-3">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
            Extensions
          </span>
          <button
            onClick={closeExtensions}
            className="rounded px-1.5 text-[14px] leading-none text-text-muted hover:text-text-primary"
          >
            ×
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <ExtensionManagerPanel />
        </div>
      </div>
    </div>
  );
}
