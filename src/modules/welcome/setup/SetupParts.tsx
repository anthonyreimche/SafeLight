// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Pieces every welcome-setup step shares. The heading takes focus on each step
// change (SetupFlow moves it there by id), and all text sits on text-primary
// or text-secondary: Safelight Neutral's muted grey is below AA on purpose,
// and this is the screen people who need contrast see first.

import { useId, type ReactNode } from "react";
import {
  updateSettings,
  useSettings,
  type AppSettings,
} from "@/state/settings-store";
import { Switch } from "@/ui/components/Switch";

export const primaryBtn =
  "rounded bg-slider-fill px-4 py-1.5 text-xs font-medium text-white hover:bg-surface-4";
export const secondaryBtn =
  "rounded bg-surface-3 px-3 py-1.5 text-xs text-text-primary hover:bg-surface-4";

export interface StepProps {
  /** Id of the step's heading, which labels the setup dialog. */
  headingId: string;
}

export function StepHeading({
  id,
  title,
  subtitle,
}: {
  id: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-6">
      <h1
        id={id}
        tabIndex={-1}
        className="text-xl font-semibold text-text-primary outline-none"
      >
        {title}
      </h1>
      <p className="mt-1 text-sm text-text-secondary">{subtitle}</p>
    </div>
  );
}

export function StepFooter({
  status,
  children,
}: {
  status?: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-8 flex items-center gap-2 border-t border-border pt-4">
      <span aria-live="polite" className="mr-auto text-sm text-text-secondary">
        {status}
      </span>
      {children}
    </div>
  );
}

/** AppSettings fields a switch can drive: the boolean ones. */
export type BooleanSetting = {
  [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never;
}[keyof AppSettings];

/** A setup switch bound to one boolean setting, under Preferences' label, with
 *  an optional one-line description linked by aria-describedby. */
export function SettingSwitch({
  label,
  setting,
  description,
}: {
  label: string;
  setting: BooleanSetting;
  description?: string;
}) {
  const checked = useSettings((s) => s[setting]);
  const descriptionId = useId();
  const set = (value: boolean) => {
    const patch: Partial<AppSettings> = {};
    patch[setting] = value;
    updateSettings(patch);
  };
  return (
    <div className="flex flex-col gap-1">
      <Switch
        checked={checked}
        onChange={set}
        ariaDescribedBy={description ? descriptionId : undefined}
        className="w-full justify-between gap-3 text-left"
      >
        <span className="text-sm text-text-primary">{label}</span>
      </Switch>
      {description && (
        <p id={descriptionId} className="text-xs text-text-secondary">
          {description}
        </p>
      )}
    </div>
  );
}

export function SettingGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-sm font-medium text-text-primary">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}
