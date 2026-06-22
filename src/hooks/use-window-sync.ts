// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect } from "react";
import { broadcast, onBroadcast, WINDOW_ID } from "@/state/broadcast";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { reloadThumbnail } from "@/state/thumbnail-loader";
import { detachedModule } from "@/state/detach";

// Keeps every window (main + detached) in sync: the active photo follows across
// windows, and the main window reflects detach/attach of modules. A detached
// window also announces its return when closed, so the module is reclaimed.
export function useWindowSync() {
  useEffect(() => {
    const dm = detachedModule();

    const off = onBroadcast((msg) => {
      if (msg.type === "selection-change") {
        // Apply the remote change locally but don't echo it back — re-broadcasting
        // a received selection makes windows ping-pong forever (see setActivePhoto).
        useCatalogStore
          .getState()
          .setActivePhoto(msg.payload.activePhotoId, { broadcast: false });
      } else if (
        msg.type === "catalog-change" &&
        msg.payload.action === "update" &&
        msg.payload.id &&
        msg.payload.origin !== WINDOW_ID
      ) {
        // Another window edited a photo and wrote its new <id>.jpg. Reload that
        // one preview from disk so this window's grid reflects the edit. Skipping
        // our own echo (origin === WINDOW_ID) keeps the single-window path — which
        // already applied the blob in-memory — from re-reading it from disk.
        void reloadThumbnail(msg.payload.id);
      } else if (!dm && msg.type === "attach") {
        const ui = useUIStore.getState();
        ui.markAttached(msg.payload.module);
        ui.setActiveModule(msg.payload.module);
      } else if (!dm && msg.type === "detach") {
        useUIStore.getState().markDetached(msg.payload.module);
      }
    });

    let onUnload: (() => void) | undefined;
    if (dm) {
      onUnload = () => broadcast({ type: "attach", payload: { module: dm } });
      window.addEventListener("beforeunload", onUnload);
    }

    return () => {
      off();
      if (onUnload) window.removeEventListener("beforeunload", onUnload);
    };
  }, []);
}
