import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/ui/components/AppShell";
import { DevelopSidebar } from "./DevelopSidebar";
import { DevelopLeftSidebar } from "./DevelopLeftSidebar";
import { DevelopCanvas } from "./DevelopCanvas";
import { ZoomControls } from "@/ui/ZoomControls";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore } from "@/state/develop-store";

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
      loadEdit(activePhotoId);
    }
  }, [activePhotoId, loadEdit]);

  return (
    <AppShell
      leftSidebar={<DevelopLeftSidebar />}
      rightSidebar={<DevelopSidebar />}
      statusBar={
        activePhoto && (
          <div className="flex w-full items-center justify-between">
            <span>{activePhoto.filename}</span>
            <ZoomControls zoom={zoom} onChange={setZoom} />
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
