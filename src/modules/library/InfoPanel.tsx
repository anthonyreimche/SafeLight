// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

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
  // Depend only on the fields the render actually consumes — the pixel source
  // (thumbnail blob, keyed by its object URL; the fallback decode's rotation),
  // as-shot WB, and file-access nonce — so metadata mutations that replace the
  // photo object (rating, flag, colour label, keywords) don't retrigger a full
  // develop-pipeline render. The live object is read inside the effect.
  const photoId = useCatalogStore((s) => s.activePhotoId);
  const thumbnailUrl = useCatalogStore(
    (s) => s.photos.find((p) => p.id === s.activePhotoId)?.thumbnailUrl,
  );
  const rotation = useCatalogStore(
    (s) => s.photos.find((p) => p.id === s.activePhotoId)?.rotation,
  );
  const colorTemperature = useCatalogStore(
    (s) => s.photos.find((p) => p.id === s.activePhotoId)?.exif.colorTemperature,
  );
  const fileAccessNonce = useCatalogStore((s) => s.fileAccessNonce);
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
    if (!photoId) {
      setData(null);
      return;
    }
    (async () => {
      const photo = useCatalogStore
        .getState()
        .photos.find((p) => p.id === photoId);
      if (!photo) {
        setData(null);
        return;
      }
      const params = await loadSavedParams(photo.id, photo.exif.colorTemperature);
      const hist = await renderPhotoHistogram(photo, params);
      if (!cancelled) setData(hist);
    })();
    return () => {
      cancelled = true;
    };
  }, [photoId, thumbnailUrl, rotation, colorTemperature, fileAccessNonce, editNonce]);

  return <Histogram data={data} />;
}
