// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Step 2 of the welcome setup: how Safelight behaves while you edit. Every
// switch writes the setting Preferences reads, under Preferences' label; the
// one-line descriptions are setup's own, shorter than Preferences' hints.

import { updateSettings, useSettings } from "@/state/settings-store";
import { CanvasSurroundSwatches } from "@/ui/components/CanvasSurroundSwatches";
import { setSetupStep } from "./setup-store";
import {
  primaryBtn,
  secondaryBtn,
  SettingGroup,
  SettingSwitch,
  StepFooter,
  StepHeading,
  type StepProps,
} from "./SetupParts";

export function WorkspaceStep({ headingId }: StepProps) {
  const surroundOn = useSettings((s) => s.canvasSurroundOverride);
  const surround = useSettings((s) => s.canvasSurround);

  return (
    <>
      <StepHeading
        id={headingId}
        title="Your workspace, your rules"
        subtitle="How Safelight behaves while you edit. Change any of it later in Preferences."
      />
      <div className="flex max-w-[480px] flex-col gap-6">
        <SettingGroup title="Develop">
          <SettingSwitch
            label="Canvas surround"
            setting="canvasSurroundOverride"
            description="A fixed shade behind the photo in Develop. Middle grey keeps your judgement of brightness and colour accurate."
          />
          <CanvasSurroundSwatches
            value={surround}
            enabled={surroundOn}
            onChange={(shade) => updateSettings({ canvasSurround: shade })}
          />
          <SettingSwitch
            label="Sliders jump to cursor"
            setting="sliderJumpToCursor"
            description="Click anywhere on a slider to jump there, then drag."
          />
          <SettingSwitch
            label="Highlight & shadow detail sliders"
            setting="basicDetailSliders"
            description="Adds Highlight Detail and Shadow Detail to the Basic panel."
          />
        </SettingGroup>
        <SettingGroup title="Shortcuts and startup">
          <SettingSwitch
            label="Single-key shortcuts"
            setting="singleKeyShortcuts"
            description="Bare letters work as shortcuts: G for Library, D for Develop, F for fullscreen. Turn this off if they get in your way."
          />
          <SettingSwitch
            label="Restore last project on launch"
            setting="restoreLastProject"
            description="Skip the welcome screen and reopen the folder you used last."
          />
        </SettingGroup>
      </div>
      <StepFooter>
        <button
          type="button"
          className={secondaryBtn}
          onClick={() => setSetupStep("look")}
        >
          Back
        </button>
        <button
          type="button"
          className={primaryBtn}
          onClick={() => setSetupStep("extensions")}
        >
          Continue
        </button>
      </StepFooter>
    </>
  );
}
