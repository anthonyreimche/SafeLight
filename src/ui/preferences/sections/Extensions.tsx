// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { DEFAULT_SETTINGS, updateSettings, useSettings } from "@/state/settings-store";
import { openExtensions } from "@/ui/components/extensions-dialog-store";
import { btnCls, Field, inputCls, ToggleField } from "@/ui/preferences/fields";
import { closePreferences } from "@/ui/preferences/preferences-store";
import { settings, type PrefSection } from "@/ui/preferences/section-model";

export function ExtensionsSection() {
  const topic = useSettings((s) => s.extensionTopic);
  const checkExtensionUpdates = useSettings((s) => s.checkExtensionUpdates);
  const autoUpdateExtensions = useSettings((s) => s.autoUpdateExtensions);
  const onlyVerifiedExtensions = useSettings((s) => s.onlyVerifiedExtensions);
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Official extension topic"
        hint="GitHub topic used to discover extensions in the Extensions window."
      >
        <input
          value={topic}
          onChange={(e) => updateSettings({ extensionTopic: e.target.value })}
          onBlur={(e) => {
            if (!e.target.value.trim())
              updateSettings({
                extensionTopic: DEFAULT_SETTINGS.extensionTopic,
              });
          }}
          spellCheck={false}
          className={inputCls}
        />
      </Field>
      <ToggleField
        label="Check extensions for updates"
        hint="On launch, compare installed extensions against the latest GitHub release and flag any with an update available."
        checked={checkExtensionUpdates}
        onChange={(v) => updateSettings({ checkExtensionUpdates: v })}
      />
      <ToggleField
        label="Auto-update extensions"
        hint="Silently install extension updates in the background when found. Off by default — updates are flagged for you to apply manually."
        checked={autoUpdateExtensions}
        onChange={(v) => updateSettings({ autoUpdateExtensions: v })}
      />
      <ToggleField
        label="Only verified extensions"
        hint="Show and install only extensions on Safelight's verified allowlist: unverified ones are hidden from the store and blocked from installing. Banned extensions are always blocked regardless of this setting."
        checked={onlyVerifiedExtensions}
        onChange={(v) => updateSettings({ onlyVerifiedExtensions: v })}
      />
      <Field label="Manage">
        <button
          onClick={() => {
            closePreferences();
            openExtensions();
          }}
          className={btnCls}
        >
          Open Extensions…
        </button>
      </Field>
    </div>
  );
}

export const extensionsSection: PrefSection = {
  id: "Extensions",
  label: "Extensions",
  group: "General",
  items: settings(
    "Official extension topic",
    "Check extensions for updates",
    "Auto-update extensions",
    "Only verified extensions",
  ),
  keywords: ["Manage", "plugins"],
  render: () => <ExtensionsSection />,
};
