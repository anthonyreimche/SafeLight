import { useEffect, useState } from "react";
import { AppShell } from "@/ui/components/AppShell";
import { LibrarySidebar } from "./LibrarySidebar";
import { LibraryToolbar } from "./LibraryToolbar";
import { LibraryGrid } from "./LibraryGrid";
import { MetadataPanel } from "./MetadataPanel";
import { Histogram } from "@/ui/components/Histogram";
import type { HistogramData } from "@/rendering/histogram";
import { renderPhotoHistogram } from "@/rendering/thumbnail-renderer";
import { loadSavedParams } from "@/catalog/edit-params";
import { onBroadcast } from "@/state/broadcast";
import { useCatalogStore } from "@/state/catalog-store";
import { useCullingShortcuts } from "./use-culling-shortcuts";

export function LibraryView() {
  const photos = useCatalogStore((s) => s.photos);

  useCullingShortcuts();

  return (
    <AppShell
      leftSidebar={<LibrarySidebar />}
      rightSidebar={
        <div className="flex flex-col">
          <LibraryHistogram />
          <MetadataPanel />
        </div>
      }
      statusBar={
        <span>
          {photos.length} photo{photos.length !== 1 && "s"} in catalog
        </span>
      }
    >
      <LibraryToolbar />
      <LibraryGrid />
    </AppShell>
  );
}

// Histogram of the active photo, rendered through the develop pipeline with its
// saved edits (and the base tone curve), so it reflects edits and matches the
// Develop view rather than the raw, unedited thumbnail.
function LibraryHistogram() {
  const photo = useCatalogStore((s) =>
    s.photos.find((p) => p.id === s.activePhotoId),
  );
  const photoId = photo?.id;
  const [data, setData] = useState<HistogramData | null>(null);
  // Bumped when this photo's saved edits change (live from Develop, including a
  // detached window) so the histogram re-renders.
  const [editNonce, setEditNonce] = useState(0);

  useEffect(() => {
    if (!photoId) return;
    return onBroadcast((msg) => {
      if (msg.type === "edit-update" && msg.payload.photoId === photoId) {
        setEditNonce((n) => n + 1);
      }
    });
  }, [photoId]);

  useEffect(() => {
    let cancelled = false;
    if (!photo) {
      setData(null);
      return;
    }
    (async () => {
      const params = await loadSavedParams(photo.id);
      const hist = await renderPhotoHistogram(photo, params);
      if (!cancelled) setData(hist);
    })();
    return () => {
      cancelled = true;
    };
  }, [photo, photoId, editNonce]);

  return <Histogram data={data} />;
}
