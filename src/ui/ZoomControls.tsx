// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Zoom controls for the image viewports, rendered in the status bar (off the
// image). `null` is fit-to-frame; numbers are scale factors of the buffer. The
// stops are the ones picked in Preferences, as far in as the maximum zoom.
import { formatZoom, useSettings } from "@/state/settings-store";
import { STATUS_HIT } from "./status-button";

export function ZoomControls({
  zoom,
  onChange,
}: {
  zoom: number | null;
  onChange: (zoom: number | null) => void;
}) {
  const stops = useSettings((s) => s.developZoomStops);
  const maxZoom = useSettings((s) => s.developMaxZoom);
  const btn = (active: boolean) =>
    `${STATUS_HIT} text-[10px] ${active ? "text-text-primary" : "text-text-muted hover:text-text-primary"}`;

  return (
    <div className="flex gap-2">
      <button
        onClick={() => onChange(null)}
        title="Fit the photo to the view"
        aria-pressed={zoom == null}
        className={btn(zoom == null)}
      >
        Fit
      </button>
      {stops
        .filter((stop) => stop <= maxZoom)
        .map((stop) => {
          const label = formatZoom(stop);
          return (
            <button
              key={stop}
              onClick={() => onChange(stop)}
              title={`Zoom to ${label}`}
              aria-pressed={zoom === stop}
              className={btn(zoom === stop)}
            >
              {label}
            </button>
          );
        })}
    </div>
  );
}
