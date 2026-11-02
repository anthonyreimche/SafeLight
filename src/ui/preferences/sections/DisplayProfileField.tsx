// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { getSettings, updateSettings, useSettings } from "@/state/settings-store";
import { nativeFs } from "@/project/native-fs";
import { DISPLAY_CURVE_LABEL } from "@/rendering/display-profile";
import {
  displayProfileSupported,
  reloadDisplayProfile,
  useDisplayProfile,
  type DisplayProfileState,
} from "@/rendering/display-profile-store";
import { btnCls, Field } from "@/ui/preferences/fields";

// ICC only: the chosen file is read whole, now and at every launch.
const ICC_FILTERS = [{ name: "ICC profiles", extensions: ["icc", "icm", "ICC", "ICM"] }];

function displayProfileStatus(
  state: DisplayProfileState,
): { text: string; error: boolean } | null {
  switch (state.status) {
    case "off":
      return null;
    case "loading":
      return { text: "Reading profile…", error: false };
    case "error":
      return { text: state.error, error: true };
    case "active": {
      const name = state.description || state.path.split(/[\\/]/).pop();
      const curve = DISPLAY_CURVE_LABEL[state.transform.curve];
      return {
        text: `${name}. Primaries from the profile, tone curve treated as ${curve}.`,
        error: false,
      };
    }
  }
}

// Linux only: Wayland desktops other than a colour-managed KDE leave
// Safelight's window unconverted, so the Develop view converts itself to the
// monitor's profile.
export function DisplayProfileField() {
  const path = useSettings((s) => s.displayProfilePath);
  const status = displayProfileStatus(useDisplayProfile());
  if (!displayProfileSupported()) return null;

  const choose = () => {
    void nativeFs()
      ?.pickFile?.(ICC_FILTERS)
      .then((picked) => {
        if (!picked) return;
        // The same file again may have been recalibrated in place.
        if (picked === getSettings().displayProfilePath) void reloadDisplayProfile();
        else updateSettings({ displayProfilePath: picked });
      });
  };

  return (
    <Field
      label="Display profile"
      hint="Under Wayland, Safelight's window reaches your monitor unconverted unless your desktop converts it, so a wide-gamut monitor shows colors oversaturated. Choose the monitor's ICC profile to convert the Develop view to it. On KDE Plasma, set Color profile in System Settings ▸ Display & Monitor instead, which converts every app. Leave this empty when your desktop already converts (KDE with a Color profile set, or the X11 workaround from the FAQ), or colors are converted twice. Library thumbnails aren't converted, and exports don't change."
    >
      <div className="flex items-center gap-1.5">
        <span
          className="min-w-0 flex-1 truncate rounded bg-surface-2 px-2 py-1 text-[11px] text-text-secondary"
          title={path || undefined}
        >
          {path || "None"}
        </span>
        <button onClick={choose} className={btnCls}>
          Choose profile…
        </button>
        {path && (
          <button
            onClick={() => updateSettings({ displayProfilePath: "" })}
            className={btnCls}
          >
            Clear
          </button>
        )}
      </div>
      {status && (
        <p
          className={`mt-1 text-[10px] leading-relaxed ${
            status.error ? "text-danger" : "text-text-secondary"
          }`}
        >
          {status.text}
        </p>
      )}
    </Field>
  );
}
