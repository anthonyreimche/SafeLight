import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import type { LensCorrectionParams } from "@/catalog/types";
import { useState, useCallback } from "react";
import { LensPickerDialog } from "./LensPickerDialog";

type LensMode = LensCorrectionParams["mode"];

const MODE_LABELS: { value: LensMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "profile", label: "Profile" },
  { value: "manual", label: "Manual" },
];

export function LensCorrectionPanel() {
  const lc = useDevelopStore((s) => s.params.lensCorrection);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const detectedLensName = useDevelopStore((s) => s.detectedLensName);
  const resolvedProfile = useDevelopStore((s) => s.resolvedLensProfile);
  const [pickerOpen, setPickerOpen] = useState(false);

  const patch = useCallback(
    (updates: Partial<LensCorrectionParams>) => {
      setParam("lensCorrection", { ...lc, ...updates });
    },
    [lc, setParam],
  );

  const setMode = useCallback(
    (mode: LensMode) => {
      patch({ mode });
      void commitEdit("Lens Mode");
    },
    [patch, commitEdit],
  );

  const toggleFlag = useCallback(
    (key: "distortionEnabled" | "caEnabled" | "vignetteEnabled" | "autoCrop") => {
      patch({ [key]: !lc[key] });
      void commitEdit("Lens Toggle");
    },
    [lc, patch, commitEdit],
  );

  const profileName = detectedLensName ?? (lc.profileId ? "Custom Profile" : "No lens detected");
  const hasProfile = resolvedProfile !== null || lc.profileId !== null;

  return (
    <Panel title="Lens Correction" defaultOpen={false}>
      <div className="space-y-1">
        {/* Mode toggle */}
        <div className="flex gap-0.5 p-0.5">
          {MODE_LABELS.map((m) => (
            <button
              key={m.value}
              className={`flex-1 px-1.5 py-0.5 text-[11px] rounded transition-colors ${
                lc.mode === m.value
                  ? "bg-[var(--color-accent)] text-white"
                  : "bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
              }`}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Profile mode content */}
        {lc.mode === "profile" && (
          <div className="space-y-1 px-0.5">
            {/* Detected lens name */}
            <div className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)]">
              <span className="flex-1 truncate" title={profileName}>
                {profileName}
              </span>
              <button
                className="shrink-0 px-1 py-0.5 rounded text-[10px] hover:bg-[var(--color-surface-3)]"
                title="Choose lens manually"
                onClick={() => setPickerOpen(true)}
              >
                Edit
              </button>
            </div>

            {!hasProfile && (
              <div className="text-[10px] text-[var(--color-text-tertiary)] italic">
                No matching profile found. Click Edit to select a lens.
              </div>
            )}

            {/* Per-correction toggles */}
            <div className="space-y-0.5">
              <Toggle
                label="Distortion"
                checked={lc.distortionEnabled}
                onChange={() => toggleFlag("distortionEnabled")}
              />
              <Toggle
                label="Chromatic Aberration"
                checked={lc.caEnabled}
                onChange={() => toggleFlag("caEnabled")}
              />
              <Toggle
                label="Vignetting"
                checked={lc.vignetteEnabled}
                onChange={() => toggleFlag("vignetteEnabled")}
              />
              <Toggle
                label="Auto Crop"
                checked={lc.autoCrop}
                onChange={() => toggleFlag("autoCrop")}
              />
            </div>
          </div>
        )}

        {/* Manual sliders — all 4 in manual mode, fine-tuning subset in profile mode */}
        {lc.mode !== "off" && (
          <div className="space-y-0.5">
            <Slider
              label="Distortion"
              value={lc.distortion}
              min={-100}
              max={100}
              step={1}
              onChange={(v) => patch({ distortion: v })}
              onCommit={() => commitEdit("Lens Distortion")}
            />
            {lc.mode === "manual" && (
              <Slider
                label="Fringing"
                value={lc.chromaticAberration}
                min={0}
                max={100}
                step={1}
                onChange={(v) => patch({ chromaticAberration: v })}
                onCommit={() => commitEdit("Lens Fringing")}
              />
            )}
            <Slider
              label="Defringe"
              value={lc.defringe}
              min={0}
              max={100}
              step={1}
              onChange={(v) => patch({ defringe: v })}
              onCommit={() => commitEdit("Lens Defringe")}
            />
            {lc.mode === "manual" && (
              <Slider
                label="Vignetting"
                value={lc.vignetting}
                min={-100}
                max={100}
                step={1}
                onChange={(v) => patch({ vignetting: v })}
                onCommit={() => commitEdit("Lens Vignetting")}
              />
            )}
          </div>
        )}
      </div>

      {pickerOpen && (
        <LensPickerDialog
          onSelect={(lensId) => {
            patch({ profileId: lensId, profileSource: "lensfun" });
            void commitEdit("Select Lens");
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </Panel>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-[var(--color-text)] cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="w-3 h-3 accent-[var(--color-accent)]"
      />
      {label}
    </label>
  );
}
