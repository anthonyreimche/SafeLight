import { useEffect, useState } from "react";
import { AppShell } from "@/ui/components/AppShell";
import { LibrarySidebar } from "./LibrarySidebar";
import { LibraryToolbar } from "./LibraryToolbar";
import { LibraryGrid } from "./LibraryGrid";
import { MetadataPanel } from "./MetadataPanel";
import { Histogram } from "@/ui/components/Histogram";
import { computeHistogram, type HistogramData } from "@/rendering/histogram";
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

// Histogram of the active photo, computed from its (upright) thumbnail.
function LibraryHistogram() {
  const photo = useCatalogStore((s) =>
    s.photos.find((p) => p.id === s.activePhotoId),
  );
  const [data, setData] = useState<HistogramData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const blob = photo?.thumbnailBlob;
    if (!blob) {
      setData(null);
      return;
    }
    createImageBitmap(blob)
      .then((bmp) => {
        if (cancelled) {
          bmp.close();
          return;
        }
        setData(computeHistogram(bmp));
        bmp.close();
      })
      .catch(() => setData(null));
    return () => {
      cancelled = true;
    };
  }, [photo?.id, photo?.thumbnailBlob]);

  return <Histogram data={data} />;
}
