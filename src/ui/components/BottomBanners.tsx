// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The bars along the bottom of the window, in one stack: any shown at once sit
// one above the other. The stack is above ModalWindow (z-[100]), so a storage
// failure stays in view over Preferences, and below Dialog and ContextMenu
// (z-[160]) and ConfirmDialog (z-[200]), which cover it.

import { ExtensionSecurityBanner } from "@/extensions/ExtensionSecurityBanner";
import { UpdateBanner } from "@/update/UpdateBanner";
import { GraphicsNotice } from "./GraphicsNotice";
import { StorageBanner } from "./StorageBanner";

export function BottomBanners() {
  return (
    <div
      data-bottom-banners
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[150] flex flex-col [&>*]:pointer-events-auto"
    >
      <GraphicsNotice />
      <ExtensionSecurityBanner />
      <StorageBanner />
      <UpdateBanner />
    </div>
  );
}
