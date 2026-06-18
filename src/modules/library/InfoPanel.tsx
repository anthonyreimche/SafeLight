// Library "Info" panel: histogram of the active photo (rendered through the
// develop pipeline with its saved edits) plus the metadata readout. Docked
// right of the grid by default.

import { useEffect, useState } from "react";
import { MetadataPanel } from "./MetadataPanel";
import { KeywordEditor } from "./KeywordEditor";
import { Panel } from "@/ui/components/Panel";
import { Histogram } from "@/ui/components/Histogram";
import type { HistogramData } from "@/rendering/histogram";
import { renderPhotoHistogram } from "@/rendering/thumbnail-renderer";
import { loadSavedParams } from "@/catalog/edit-params";
import { onBroadcast } from "@/state/broadcast";
import { useCatalogStore } from "@/state/catalog-store";

export function InfoPanel() {
  return (
    <div className="flex flex-col">
      <LibraryHistogram />
      <Panel title="Keywords">
        <KeywordEditor />
      </Panel>
      <MetadataPanel />
    </div>
  );
}

// Histogram of the active photo with its saved edits, so it matches Develop
// rather than the raw, unedited thumbnail.
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
      const params = await loadSavedParams(photo.id, photo.exif.colorTemperature);
      const hist = await renderPhotoHistogram(photo, params);
      if (!cancelled) setData(hist);
    })();
    return () => {
      cancelled = true;
    };
  }, [photo, photoId, editNonce]);

  return <Histogram data={data} />;
}
