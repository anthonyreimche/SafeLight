// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, type ReactNode } from "react";
import { DevelopCanvas } from "./DevelopCanvas";
import { MissingAdjustmentsNotice } from "./MissingAdjustmentsNotice";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore } from "@/state/develop-store";
import { useActivePhoto } from "@/state/use-active-photo";
import { useDisplaySpace } from "@/rendering/display-space";

// The Develop module's main area as core draws it: the surround behind the
// image and the canvas of the active photo, with its overlays. The Develop
// extension supplies the zoom it shares with its status bar, and what shows
// with no photo open.
// ISO 12646 colour-assessment surround: a fixed middle grey that pairs with the
// white image mat (ViewportImage). Slightly darker than the default surround so
// the white frame reads clearly and the mode is unmistakable.
const ASSESSMENT_SURROUND = "#666666";

export interface DevelopStageProps {
  /** The view's zoom: null fits the photo, 1 is 100%. */
  zoom: number | null;
  onZoomChange(zoom: number | null): void;
  /** Shown in the surround while no photo is open. */
  empty?: ReactNode;
}

export function DevelopStage({ zoom, onZoomChange, empty }: DevelopStageProps) {
  const activePhotoId = useCatalogStore((s) => s.activePhotoId);
  const activePhoto = useActivePhoto();
  const loadEdit = useDevelopStore((s) => s.loadEdit);
  const editError = useDevelopStore((s) => (s.photoId === activePhotoId ? s.editError : null));
  const colorAssessment = useDevelopStore((s) => s.colorAssessment);
  // A 2D context's colour space is fixed by its first getContext, so the canvases are
  // built again when the window moves to a screen of another space.
  const displaySpace = useDisplaySpace();

  // Runs after the canvas's own effects, as the renderer expects of a new photo.
  useEffect(() => {
    if (activePhotoId) {
      const p = useCatalogStore.getState().photos.find((ph) => ph.id === activePhotoId);
      loadEdit(activePhotoId, p?.exif.colorTemperature).catch((error: unknown) =>
        console.error("Couldn't save the edit left on the previous photo", error),
      );
    }
  }, [activePhotoId, loadEdit]);

  return (
    <div
      data-canvas-surround
      className="relative flex flex-1 items-center justify-center overflow-hidden p-4"
      style={{
        // Neutral surround behind the image. Colour assessment forces the ISO
        // middle grey; otherwise it follows the theme unless the user
        // overrides it (Preferences ▸ Interface ▸ Canvas surround). The
        // renderer reads it back for the crop-mode margin.
        background: colorAssessment
          ? ASSESSMENT_SURROUND
          : "var(--color-canvas-surround, var(--color-surface-0))",
      }}
    >
      {activePhoto ? (
        <>
          <DevelopCanvas
            key={`${activePhoto.id}:${displaySpace}`}
            photo={activePhoto}
            zoom={zoom}
            onZoomChange={onZoomChange}
          />
          <MissingAdjustmentsNotice />
          {editError !== null && (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
              <div
                role="alert"
                className="pointer-events-auto flex items-center gap-2 rounded border border-border bg-surface-2 px-3 py-1.5 text-[11px] text-text-primary shadow-lg"
              >
                <span>
                  Can't open this photo's saved edits ({editError}). Changes to it won't be saved until it
                  opens.
                </span>
                <button
                  className="rounded border border-border px-2 py-0.5 hover:bg-surface-3"
                  onClick={() => void loadEdit(activePhoto.id, activePhoto.exif.colorTemperature)}
                >
                  Try again
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        empty
      )}
    </div>
  );
}
