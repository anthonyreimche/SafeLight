// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/ui/components/AppShell";
import { DevelopCanvas } from "./DevelopCanvas";
import { Slot } from "@/extensions/Slot";
import { ZoomControls } from "@/ui/ZoomControls";
import { SurroundControl } from "@/ui/SurroundControl";
import { DisplayTransformControl } from "@/ui/DisplayTransformControl";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore } from "@/state/develop-store";

// The canvas is the module's "main" dock panel; Tools (masks/retouch/presets)
// and the Edit stack are extension panels placed by the develop dock layout.
// ISO 12646 color-assessment surround: a fixed middle grey that pairs with the
// white image mat (ViewportImage). Slightly darker than the default surround so
// the white frame reads clearly and the mode is unmistakable.
const ASSESSMENT_SURROUND = "#666666";

export function DevelopView() {
  const activePhotoId = useCatalogStore((s) => s.activePhotoId);
  const photos = useCatalogStore((s) => s.photos);
  const loadEdit = useDevelopStore((s) => s.loadEdit);
  const colorAssessment = useDevelopStore((s) => s.colorAssessment);
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
              <AssessmentToggle />
              <DisplayTransformControl />
              <SurroundControl />
              <ZoomControls zoom={zoom} onChange={setZoom} />
            </div>
          </div>
        )
      }
    >
      <div
        data-canvas-surround
        className="flex flex-1 items-center justify-center overflow-hidden p-4"
        style={{
          // Neutral surround behind the image. Color assessment forces the ISO
          // middle grey; otherwise it follows the theme unless the user
          // overrides it (Preferences ▸ Interface ▸ Canvas surround).
          background: colorAssessment
            ? ASSESSMENT_SURROUND
            : "var(--color-canvas-surround, var(--color-surface-0))",
        }}
      >
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

// Status-bar toggle for ISO 12646 color assessment (also bound to a shortcut).
function AssessmentToggle() {
  const on = useDevelopStore((s) => s.colorAssessment);
  const toggle = useDevelopStore((s) => s.toggleColorAssessment);
  return (
    <button
      onClick={toggle}
      title="Color assessment (ISO 12646): white frame + middle-grey surround"
      aria-label="Toggle color assessment"
      aria-pressed={on}
      className={`text-[10px] ${on ? "text-text-primary" : "text-text-muted hover:text-text-primary"}`}
    >
      Assess
    </button>
  );
}
