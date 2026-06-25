// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Settings UI for the `core.accessibility` built-in extension. Registered via
// api.registerSettings({ component }) so it appears under Preferences ▸
// Extensions and disappears when the extension is disabled. It reads/writes the
// core settings store directly (a built-in extension can) and reuses the
// dialog's search-aware field primitives; the overlays it drives are applied in
// state/accessibility.ts.

import {
  Field,
  OptionRow,
  SliderField,
  ToggleField,
  useFieldVisible,
} from "@/ui/components/PreferencesDialog";
import {
  updateSettings,
  useSettings,
  type ColorVisionFilter,
} from "@/state/settings-store";
import { ColorOverrides } from "./ColorOverrides";

const COLOR_VISION_OPTIONS: { value: ColorVisionFilter; label: string }[] = [
  { value: "none", label: "Off" },
  { value: "protanopia", label: "Protanopia" },
  { value: "deuteranopia", label: "Deuteranopia" },
  { value: "tritanopia", label: "Tritanopia" },
];

// `function` (not a const arrow) so its binding is hoisted — builtin.tsx
// references this at module-eval time inside the BUILTIN_EXTENSIONS array, and
// the extension import graph is cyclic (builtin → here → PreferencesDialog →
// ExtensionsDialog → loader → builtin). Hoisting keeps that reference valid.
export function AccessibilitySettings() {
  const syncOS = useSettings((s) => s.syncOSAccessibility);
  const highContrast = useSettings((s) => s.highContrast);
  const uiScale = useSettings((s) => s.uiScale);
  const largerText = useSettings((s) => s.largerText);
  const largerControls = useSettings((s) => s.largerControls);
  const lowercaseHeadings = useSettings((s) => s.lowercaseHeadings);
  const strongFocus = useSettings((s) => s.strongFocus);
  const reduceTransparency = useSettings((s) => s.reduceTransparency);
  const colorVisionFilter = useSettings((s) => s.colorVisionFilter);
  const keyboardCanvasEditing = useSettings((s) => s.keyboardCanvasEditing);
  const editingHighlights = useSettings((s) => s.editingHighlights);
  const reduceMotion = useSettings((s) => s.reduceMotion);

  return (
    <div className="flex flex-col gap-4">
      <ToggleField
        label="Match system accessibility settings"
        hint="Also apply your operating system's reduced-motion, increased-contrast and reduced-transparency preferences. The options below add to these — they never switch a system preference back off. (Windows High Contrast mode is always respected.)"
        checked={syncOS}
        onChange={(v) => updateSettings({ syncOSAccessibility: v })}
      />
      <ToggleField
        label="High contrast"
        hint="Override the current theme with a maximal-contrast palette (WCAG AA). The Dark and Neutral themes switch to a high-contrast dark palette; the Light theme to a high-contrast light one. Your default theme is left unchanged while this is off."
        checked={highContrast}
        onChange={(v) => updateSettings({ highContrast: v })}
      />
      <div>
        <SliderField
          label="Interface scale"
          value={uiScale}
          min={0.8}
          max={2}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateSettings({ uiScale: v })}
        />
        {useFieldVisible("Interface scale") && (
          <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
            Enlarges the whole interface — text included — up to 200%. The same
            control lives under Interface ▸ Interface scale.
          </p>
        )}
      </div>
      <ToggleField
        label="Larger text"
        hint="Enlarge the smallest labels and drop their all-caps styling so they read as words — without scaling the rest of the interface. Best for cramped labels; it can reflow tight rows."
        checked={largerText}
        onChange={(v) => updateSettings({ largerText: v })}
      />
      <ToggleField
        label="Larger controls"
        hint="Grow buttons and inputs to a comfortable minimum size (≥24px) for easier pointing. Can loosen dense toolbars."
        checked={largerControls}
        onChange={(v) => updateSettings({ largerControls: v })}
      />
      <ToggleField
        label="Lowercase headings"
        hint="Show the all-caps section headings in Title Case (capitalise the first letter of each word) instead of UPPERCASE, which is harder to read at a glance."
        checked={lowercaseHeadings}
        onChange={(v) => updateSettings({ lowercaseHeadings: v })}
      />
      <ToggleField
        label="Strong focus indicator"
        hint="Draw a thick outline around whichever control has keyboard focus, so it's easy to see where you are when navigating by keyboard."
        checked={strongFocus}
        onChange={(v) => updateSettings({ strongFocus: v })}
      />
      <ToggleField
        label="Reduce transparency"
        hint="Make translucent backgrounds opaque so edges and content read clearly."
        checked={reduceTransparency}
        onChange={(v) => updateSettings({ reduceTransparency: v })}
      />
      <Field
        label="Colour-vision simulation"
        hint="Filters the whole window so you can check how the interface and your photo read to colour-blind viewers. This recolours the image too — turn it off for colour-critical editing."
      >
        <OptionRow
          value={colorVisionFilter}
          options={COLOR_VISION_OPTIONS}
          onChange={(v) => updateSettings({ colorVisionFilter: v })}
        />
      </Field>
      <ToggleField
        label="Keyboard canvas editing"
        hint="Edit direct-manipulation tools with the keyboard: focus a tool (e.g. the tone curve) and use the arrow keys. Also shows the tone curve's numeric point editor (In/Out, prev/next, add/remove)."
        checked={keyboardCanvasEditing}
        onChange={(v) => updateSettings({ keyboardCanvasEditing: v })}
      />
      <ToggleField
        label="Editing highlights"
        hint="Draw the selection/focus ring on the active point in canvas editors (such as the tone curve). Turn off to hide these visible editing highlights."
        checked={editingHighlights}
        onChange={(v) => updateSettings({ editingHighlights: v })}
      />
      <ToggleField
        label="Reduce motion"
        hint="Minimize animated UI affordances."
        checked={reduceMotion}
        onChange={(v) => updateSettings({ reduceMotion: v })}
      />
      <ColorOverrides />
    </div>
  );
}
