// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Application-wide Extensions pop-up (the puzzle button in the top bar). Wraps
// the existing ExtensionManagerPanel in a modal styled like Preferences, so
// extensions are managed in a window instead of a dockable panel. It can be
// maximized to fill the app window like a module, which also switches the
// store to its expanded layout; the choice is remembered in settings.

import { useEffect } from "react";
import { create } from "zustand";
import { ExtensionManagerPanel } from "@/extensions/ExtensionManagerPanel";
import { StoreExpanded } from "@/extensions/StoreCards";
import { getSettings, updateSettings, useSettings } from "@/state/settings-store";
import { ModalWindow } from "@/ui/components/ModalWindow";
import { pushEscapeHandler } from "@/ui/escape-stack";

const useOpen = create<{ open: boolean }>(() => ({ open: false }));
export const openExtensions = () => useOpen.setState({ open: true });
export const closeExtensions = () => useOpen.setState({ open: false });
export const toggleExtensions = () =>
  useOpen.setState((s) => ({ open: !s.open }));

const toggleMaximized = () =>
  updateSettings({ extensionsMaximized: !getSettings().extensionsMaximized });

export function ExtensionsDialog() {
  const open = useOpen((s) => s.open);
  const maximized = useSettings((s) => s.extensionsMaximized);
  // Esc closes the dialog, via the shared modal stack (topmost first).
  useEffect(() => {
    if (!open) return;
    return pushEscapeHandler(closeExtensions);
  }, [open]);
  if (!open) return null;

  return (
    <ModalWindow
      title="Extensions"
      onClose={closeExtensions}
      maximized={maximized}
      onToggleMaximize={toggleMaximized}
    >
      <div className="flex min-h-0 flex-1">
        <StoreExpanded.Provider value={maximized}>
          <ExtensionManagerPanel />
        </StoreExpanded.Provider>
      </div>
    </ModalWindow>
  );
}
