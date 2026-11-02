// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useRegistry } from "@/extensions/registry";
import { applyTheme, useThemeStore } from "@/extensions/themes";
import { detachedModule } from "@/state/detach";
import { openSetup } from "@/modules/welcome/setup/setup-store";
import { updateSettings, useSettings, UI_FONT_PRESETS } from "@/state/settings-store";
import { CanvasSurroundSwatches } from "@/ui/components/CanvasSurroundSwatches";
import { ScaleStepper } from "@/ui/components/ScaleStepper";
import { Select } from "@/ui/components/Select";
import { Switch } from "@/ui/components/Switch";
import {
  btnCls,
  Field,
  inputCls,
  OptionRow,
  SliderField,
  ToggleField,
  useFieldVisible,
} from "@/ui/preferences/fields";
import { closePreferences } from "@/ui/preferences/preferences-store";
import { settings, type PrefSection } from "@/ui/preferences/section-model";
import { LayoutField } from "./LayoutField";

export function InterfaceSection() {
  const themes = useRegistry((s) => s.themes);
  const activeTheme = useThemeStore((s) => s.activeId);
  const uiScale = useSettings((s) => s.uiScale);
  const assessBorderPct = useSettings((s) => s.assessBorderPct);
  const windowDim = useSettings((s) => s.windowDim);
  const sliderJumpToCursor = useSettings((s) => s.sliderJumpToCursor);
  const restoreLastProject = useSettings((s) => s.restoreLastProject);
  const autoSaveCollapsedPanels = useSettings((s) => s.autoSaveCollapsedPanels);

  return (
    <div className="flex flex-col gap-4">
      <Field label="Theme" hint="Themes from extensions appear here too.">
        <Select
          value={activeTheme}
          onChange={applyTheme}
          ariaLabel="Theme"
          className="w-full"
          options={Object.values(themes)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((t) => ({ value: t.id, label: t.name }))}
        />
      </Field>
      <LayoutField />
      <ToggleField
        label="Save collapsed panels to the layout"
        hint="Collapsing or expanding a panel updates the saved layout you're using, so panels stay that way when you switch between Library and Develop. Off: collapsing a panel switches to Custom until you save the layout with ↻."
        checked={autoSaveCollapsedPanels}
        onChange={(v) => updateSettings({ autoSaveCollapsedPanels: v })}
      />
      <Field label="Interface scale">
        <ScaleStepper
          value={uiScale}
          onChange={(v) => updateSettings({ uiScale: v })}
          label="Interface scale"
        />
      </Field>
      <CanvasSurroundField />
      <SliderField
        label="Color assessment border"
        value={assessBorderPct}
        min={1}
        max={12}
        step={0.5}
        format={(v) => `${v}%`}
        onChange={(v) => updateSettings({ assessBorderPct: v })}
      />
      <div>
        <SliderField
          label="Background dimming"
          value={windowDim}
          min={0}
          max={0.8}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateSettings({ windowDim: v })}
        />
        {useFieldVisible("Background dimming") && (
          <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
            How much the app dims behind the Preferences and Extensions windows.
            0% leaves the photo fully visible; higher values darken it to focus
            on the window.
          </p>
        )}
      </div>
      <ToggleField
        label="Sliders jump to cursor"
        hint="Clicking anywhere on a slider snaps its value to the cursor, then drags from there. Off keeps the default: a click grabs the current value and only dragging changes it. Hold Shift while dragging for fine control either way."
        checked={sliderJumpToCursor}
        onChange={(v) => updateSettings({ sliderJumpToCursor: v })}
      />
      <ToggleField
        label="Restore last project on launch"
        hint="Reopen the most-recently-used project at startup instead of the welcome grid. Falls back to the grid if the folder can't be reopened."
        checked={restoreLastProject}
        onChange={(v) => updateSettings({ restoreLastProject: v })}
      />
      {window.safelightNative && !detachedModule() && (
        <Field
          label="Welcome setup"
          hint="Pick a look, workspace settings and starter kits again. Nothing installed is removed."
        >
          <button
            type="button"
            className={btnCls}
            onClick={() => {
              closePreferences();
              openSetup("rerun");
            }}
          >
            Run again
          </button>
        </Field>
      )}
      <FontField />
    </div>
  );
}

function CanvasSurroundField() {
  const override = useSettings((s) => s.canvasSurroundOverride);
  const surround = useSettings((s) => s.canvasSurround);
  if (!useFieldVisible("Canvas surround", "color behind the image in Develop"))
    return null;
  return (
    <div>
      <Switch
        checked={override}
        onChange={(v) => updateSettings({ canvasSurroundOverride: v })}
        className="w-full justify-between gap-3 text-left"
      >
        <span className="text-[11px] text-text-primary">Canvas surround</span>
      </Switch>
      <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
        A fixed shade behind the image in Develop, independent of the theme.
        A middle grey keeps brightness, contrast and saturation perception
        accurate while editing; black and white bracket the range. Off = follow the active theme. Also adjustable from
        the Develop toolbar.
      </p>
      <div className="mt-2">
        <CanvasSurroundSwatches
          value={surround}
          enabled={override}
          onChange={(shade) => updateSettings({ canvasSurround: shade })}
        />
      </div>
    </div>
  );
}

function FontField() {
  const uiFont = useSettings((s) => s.uiFont);
  const isPreset = UI_FONT_PRESETS.some((p) => p.value === uiFont);
  return (
    <Field
      label="Interface font"
      hint="Any installed font works in the custom field (CSS font-family syntax)."
    >
      <OptionRow
        value={isPreset ? uiFont : "custom"}
        options={UI_FONT_PRESETS}
        onChange={(v) => updateSettings({ uiFont: v as string })}
      />
      <input
        value={uiFont}
        onChange={(e) => updateSettings({ uiFont: e.target.value })}
        placeholder='Custom, e.g. "IBM Plex Sans", sans-serif'
        aria-label="Custom interface font family"
        spellCheck={false}
        className={`mt-1.5 ${inputCls}`}
      />
    </Field>
  );
}

export const interfaceSection: PrefSection = {
  id: "Interface",
  label: "Interface",
  group: "General",
  items: settings(
    "Theme",
    "Panel layout",
    "Save collapsed panels to the layout",
    "Interface scale",
    "Canvas surround",
    "Color assessment border",
    "Background dimming",
    "Sliders jump to cursor",
    "Restore last project on launch",
    "Welcome setup",
    "Interface font",
  ),
  keywords: ["surround", "background", "grey", "gray", "neutral", "assessment", "proof", "mat", "border", "dim", "darken", "window", "preferences", "modal", "slider", "jump", "cursor", "click", "drag"],
  render: () => <InterfaceSection />,
};
