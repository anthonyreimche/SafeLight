import { useEffect, useMemo, useState } from "react";
import { useCatalogStore } from "@/state/catalog-store";
import { AppShell } from "@/ui/components/AppShell";
import { LoupeCanvas } from "./LoupeCanvas";
import { ZoomControls } from "@/ui/ZoomControls";

export function LoupeView() {
  const photos = useCatalogStore((s) => s.photos);
  const activePhotoId = useCatalogStore((s) => s.activePhotoId);
  const setActivePhoto = useCatalogStore((s) => s.setActivePhoto);
  const [showBefore, setShowBefore] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);

  const activePhoto = useMemo(
    () => photos.find((p) => p.id === activePhotoId),
    [photos, activePhotoId],
  );

  // Arrow keys cycle through photos. Reads fresh store state so there's no stale
  // closure, and works in both the attached and detached Loupe windows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const store = useCatalogStore.getState();
      if (!store.activePhotoId) return;
      const idx = store.photos.findIndex((p) => p.id === store.activePhotoId);
      const next = store.photos[idx + (e.key === "ArrowLeft" ? -1 : 1)];
      if (next) store.setActivePhoto(next.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const navigate = (dir: -1 | 1) => {
    if (!activePhotoId) return;
    const idx = photos.findIndex((p) => p.id === activePhotoId);
    const next = photos[idx + dir];
    if (next) setActivePhoto(next.id);
  };

  return (
    <AppShell
      statusBar={
        <div className="flex w-full items-center justify-between">
          <span>{activePhoto?.filename ?? "No photo selected"}</span>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowBefore(!showBefore)}
              className={`text-[10px] ${showBefore ? "text-accent" : "text-text-muted"}`}
            >
              Before
            </button>
            <ZoomControls zoom={zoom} onChange={setZoom} />
          </div>
        </div>
      }
    >
      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-surface-0">
        {activePhoto ? (
          <>
            <LoupeCanvas
              photo={activePhoto}
              showBefore={showBefore}
              zoom={zoom}
              onZoomChange={setZoom}
            />

            {showBefore && (
              <div className="absolute left-3 top-3 rounded bg-black/60 px-2 py-1 text-[10px] uppercase tracking-wide text-text-secondary">
                Before
              </div>
            )}

            <button
              onClick={() => navigate(-1)}
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded bg-black/50 px-2 py-4 text-text-muted hover:text-text-primary"
            >
              {"‹"}
            </button>
            <button
              onClick={() => navigate(1)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded bg-black/50 px-2 py-4 text-text-muted hover:text-text-primary"
            >
              {"›"}
            </button>
          </>
        ) : (
          <p className="text-sm text-text-muted">No photo selected</p>
        )}
      </div>
    </AppShell>
  );
}
