// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { Panel } from "@/ui/components/Panel";
import { HSLMixer } from "@/ui/components/HSLMixer";
import { PickerIcon } from "@/ui/components/PickerIcon";
import { useDevelopStore } from "@/state/develop-store";
<<<<<<< Updated upstream
import { getExtSetting, useExtSettings } from "@/extensions/ext-settings";
=======
import { getExtSetting } from "@/extensions/ext-settings";
import { useMaskScope } from "@/modules/develop/mask-scope";
>>>>>>> Stashed changes
import { useEffect, useState } from "react";
import type { HSLBand } from "@/catalog/types";

const VIEWS: { key: "tabs" | "all"; label: string }[] = [
  { key: "tabs", label: "Tabs" },
  { key: "all", label: "All" },
];

const TARGET_BANDS: { key: HSLBand; label: string }[] = [
  { key: "hue", label: "Hue" },
  { key: "saturation", label: "Sat" },
  { key: "luminance", label: "Lum" },
];

export function HSLPanel() {
  const hsl = useDevelopStore((s) => s.params.hsl);
  const setHslValue = useDevelopStore((s) => s.setHslValue);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const hslPicking = useDevelopStore((s) => s.hslPicking);
  const setHslPicking = useDevelopStore((s) => s.setHslPicking);
  const selectedBand = useDevelopStore((s) => s.selectedHslBand);
  const setSelectedBand = useDevelopStore((s) => s.setSelectedHslBand);

  // Mount-time default only (Preferences ▸ HSL ▸ Default layout); the toggle
  // below overrides it for the session.
  const [view, setView] = useState<"tabs" | "all">(() =>
    getExtSetting<"tabs" | "all">("core.hsl", "defaultView", "tabs"),
  );

  // Exit picking mode on Escape key
  useEffect(() => {
    if (!hslPicking) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setHslPicking(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hslPicking, setHslPicking]);

  return (
    <Panel title="HSL">
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setHslPicking(!hslPicking)}
          aria-pressed={hslPicking}
          className={`flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
            hslPicking
              ? "border-accent bg-accent/30 text-text-primary"
              : "border-border-subtle text-text-secondary hover:border-border hover:text-text-primary"
          }`}
          title={`Click-drag up/down on the image to adjust ${selectedBand}`}
        >
          <PickerIcon />
          Target
        </button>

        <div className="flex rounded bg-surface-2" role="group" aria-label="HSL view">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => setView(v.key)}
              aria-pressed={view === v.key}
              className={`px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                view === v.key
                  ? "bg-surface-3 text-text-primary"
                  : "text-text-muted hover:text-text-secondary"
              } first:rounded-l last:rounded-r`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* In the "All" view there are no band tabs, so when the target tool is
          active surface a compact band selector so the drag has a clear target. */}
      {view === "all" && hslPicking && (
        <div
          className="mb-2 flex rounded bg-surface-2"
          role="group"
          aria-label="Target band"
        >
          {TARGET_BANDS.map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => setSelectedBand(b.key)}
              aria-pressed={selectedBand === b.key}
              className={`flex-1 py-1 text-[10px] uppercase tracking-wider ${
                selectedBand === b.key
                  ? "bg-surface-3 text-text-primary"
                  : "text-text-muted hover:text-text-secondary"
              } first:rounded-l last:rounded-r`}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}

      <HSLMixer
        value={hsl}
        onChange={setHslValue}
        onCommit={(channel) => commitEdit(`HSL ${channel}`)}
        selectedBand={selectedBand}
        onBandChange={setSelectedBand}
        view={view}
      />
    </Panel>
  );
}
