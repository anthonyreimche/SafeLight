import { useEffect } from "react";
import { broadcast, onBroadcast } from "@/state/broadcast";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { detachedModule } from "@/state/detach";

// Keeps every window (main + detached) in sync: the active photo follows across
// windows, and the main window reflects detach/attach of modules. A detached
// window also announces its return when closed, so the module is reclaimed.
export function useWindowSync() {
  useEffect(() => {
    const dm = detachedModule();

    const off = onBroadcast((msg) => {
      if (msg.type === "selection-change") {
        useCatalogStore.getState().setActivePhoto(msg.payload.activePhotoId);
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
