// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Application-wide Extensions pop-up (the puzzle button in the top bar). Wraps
// the existing ExtensionManagerPanel in a modal styled like Preferences, so
// extensions are managed in a window instead of a dockable panel.

import { useEffect } from "react";
import { create } from "zustand";
import { ExtensionManagerPanel } from "@/extensions/ExtensionManagerPanel";
import { ModalWindow } from "@/ui/components/ModalWindow";
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
    <ModalWindow title="Extensions" onClose={closeExtensions}>
      <div className="flex min-h-0 flex-1">
        <ExtensionManagerPanel />
      </div>
    </ModalWindow>
  );
}
