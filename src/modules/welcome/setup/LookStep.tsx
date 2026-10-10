// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Step 1 of the welcome setup: theme, interface font and scale, and the
// accessibility switches people most often need before they could find
// Preferences. Every control writes the setting Preferences reads, under
// Preferences' label. Reduce motion always shows (the core applies it even
// with the accessibility extension off); the other switches need that
// extension, so they show only while it is on.

import { useDisabledExtensions } from "@/extensions/loader";
import { useRegistry } from "@/extensions/registry";
import { applyTheme, useThemeStore } from "@/extensions/themes";
import type { ThemeContribution } from "@/extensions/types";
import {
  DEFAULT_UI_FONT_STACK,
  UI_FONT_PRESETS,
  updateSettings,
  useSettings,
} from "@/state/settings-store";
import { ScaleStepper } from "@/ui/components/ScaleStepper";
import { setSetupStep } from "./setup-store";
import {
  primaryBtn,
  SettingSwitch,
  StepFooter,
  StepHeading,
  type BooleanSetting,
  type StepProps,
} from "./SetupParts";

const ACCESSIBILITY: { label: string; setting: BooleanSetting }[] = [
  { label: "High contrast", setting: "highContrast" },
  { label: "Larger text", setting: "largerText" },
  { label: "Larger controls", setting: "largerControls" },
  { label: "Strong focus indicator", setting: "strongFocus" },
  { label: "Lowercase headings", setting: "lowercaseHeadings" },
  { label: "Reduce transparency", setting: "reduceTransparency" },
];

const cardCls = (picked: boolean) =>
  `relative flex cursor-pointer flex-col gap-2 rounded-lg border bg-surface-1 p-2 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-text-primary ${
    picked ? "border-text-primary" : "border-border hover:border-text-secondary"
  }`;

/** A second cue for the picked card, so colour isn't the only one. The radio's
 *  checked state already reaches assistive tech, so this stays hidden from it. */
function PickedMark() {
  return (
    <span
      aria-hidden="true"
      className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-text-primary text-[10px] leading-none text-surface-0"
    >
      ✓
    </span>
  );
}

function ThemeSwatch({ vars }: { vars: ThemeContribution["vars"] }) {
  const v = (name: string) => vars[name] ?? `var(${name})`;
  return (
    <div
      aria-hidden="true"
      className="flex h-14 w-full flex-col justify-end gap-1 rounded p-2"
      style={{ background: v("--color-surface-0") }}
    >
      <div
        className="h-1.5 w-3/4 rounded-full"
        style={{ background: v("--color-text-primary") }}
      />
      <div
        className="h-1.5 w-1/2 rounded-full"
        style={{ background: v("--color-text-secondary") }}
      />
      <div
        className="mt-1 h-3 w-full rounded-sm"
        style={{ background: v("--color-surface-2") }}
      >
        <div
          className="h-full w-2/5 rounded-sm"
          style={{ background: v("--color-slider-fill") }}
        />
      </div>
    </div>
  );
}

export function LookStep({ headingId }: StepProps) {
  const themes = useRegistry((s) => s.themes);
  const activeTheme = useThemeStore((s) => s.activeId);
  const uiFont = useSettings((s) => s.uiFont);
  const uiScale = useSettings((s) => s.uiScale);
  const accessibilityOn = useDisabledExtensions(
    (s) => !s.ids.includes("core.accessibility"),
  );
  const sorted = Object.values(themes).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const customFont = !UI_FONT_PRESETS.some((f) => f.value === uiFont);

  return (
    <>
      <StepHeading
        id={headingId}
        title="Pick a look"
        subtitle="Theme, font and size. All of this also lives in Preferences."
      />
      {/* CSS zoom grows the window from the top-left, so each + click moves
          the stepper away from a still cursor. Right under the heading, a
          missed click lands on text, not on a card. */}
      <div className="mb-6 flex max-w-[420px] items-center justify-between gap-4">
        <span className="text-sm font-medium text-text-primary">
          Interface scale
        </span>
        <ScaleStepper
          value={uiScale}
          onChange={(v) => updateSettings({ uiScale: v })}
          label="Interface scale"
        />
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-text-primary">
          Theme
        </legend>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
          {sorted.map((t) => (
            <label key={t.id} className={cardCls(t.id === activeTheme)}>
              <input
                type="radio"
                name="sl-setup-theme"
                value={t.id}
                checked={t.id === activeTheme}
                onChange={() => applyTheme(t.id)}
                className="sr-only"
              />
              <ThemeSwatch vars={t.vars} />
              <span className="text-sm text-text-primary">{t.name}</span>
              {t.id === activeTheme && <PickedMark />}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-6">
        <legend className="mb-2 text-sm font-medium text-text-primary">
          Interface font
        </legend>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
          {UI_FONT_PRESETS.map((f) => (
            <label key={f.label} className={cardCls(f.value === uiFont)}>
              <input
                type="radio"
                name="sl-setup-font"
                value={f.value}
                checked={f.value === uiFont}
                onChange={() => updateSettings({ uiFont: f.value })}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className="text-2xl leading-none text-text-primary"
                style={{ fontFamily: f.value || DEFAULT_UI_FONT_STACK }}
              >
                Aa
              </span>
              <span className="text-sm text-text-primary">{f.label}</span>
              {f.value === uiFont && <PickedMark />}
            </label>
          ))}
        </div>
        {customFont && (
          <p className="mt-2 text-sm text-text-secondary">
            You're using a custom font from Preferences ▸ Interface. Pick one
            here to replace it.
          </p>
        )}
      </fieldset>

      <fieldset className="mt-6 max-w-[560px]">
        <legend className="mb-1 text-sm font-medium text-text-primary">
          Accessibility
        </legend>
        {accessibilityOn && (
          <p className="mb-3 text-sm text-text-secondary">
            Preferences ▸ Accessibility has more options.
          </p>
        )}
        <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          {accessibilityOn &&
            ACCESSIBILITY.map((a) => (
              <SettingSwitch
                key={a.setting}
                label={a.label}
                setting={a.setting}
              />
            ))}
          <SettingSwitch label="Reduce motion" setting="reduceMotion" />
        </div>
      </fieldset>

      <StepFooter>
        <button
          type="button"
          className={primaryBtn}
          onClick={() => setSetupStep("workspace")}
        >
          Continue
        </button>
      </StepFooter>
    </>
  );
}
