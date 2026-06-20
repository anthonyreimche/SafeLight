import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/ui/components/AppShell";
import { DevelopCanvas } from "./DevelopCanvas";
import { Slot } from "@/extensions/Slot";
import { ZoomControls } from "@/ui/ZoomControls";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore } from "@/state/develop-store";

// The canvas is the module's "main" dock panel; Tools (masks/retouch/presets)
// and the Edit stack are extension panels placed by the develop dock layout.
export function DevelopView() {
  const activePhotoId = useCatalogStore((s) => s.activePhotoId);
  const photos = useCatalogStore((s) => s.photos);
  const loadEdit = useDevelopStore((s) => s.loadEdit);
  const [zoom, setZoom] = useState<number | null>(null);

  const activePhoto = useMemo(
    () => photos.find((p) => p.id === activePhotoId),
    [photos, activePhotoId],
  );

  useEffect(() => {
    if (activePhotoId) {
      const p = useCatalogStore.getState().photos.find((ph) => ph.id === activePhotoId);
      loadEdit(activePhotoId, p?.exif.colorTemperature);
    }
  }, [activePhotoId, loadEdit]);

  return (
    <AppShell
      module="develop"
      statusBar={
        activePhoto && (
          <div className="flex w-full items-center justify-between">
            <span>{activePhoto.filename}</span>
            <div className="flex items-center gap-3">
              <Slot name="develop-toolbar" />
              <ZoomControls zoom={zoom} onChange={setZoom} />
            </div>
          </div>
        )
      }
    >
      <div className="flex flex-1 items-center justify-center overflow-hidden p-4">
        {activePhoto ? (
          <DevelopCanvas
            key={activePhoto.id}
            photo={activePhoto}
            zoom={zoom}
            onZoomChange={setZoom}
          />
        ) : (
          <div className="text-center text-text-muted">
            <p className="text-sm">No photo selected</p>
            <p className="text-xs">
              Select a photo in Library to begin editing
            </p>
          </div>
        )}
      </div>
    </AppShell>
  );
}
