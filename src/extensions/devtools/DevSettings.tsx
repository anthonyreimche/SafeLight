// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Developer Tools section. Contributed by the Developer Tools
// extension via api.registerSettings({ component }), so it only exists while the
// extension is enabled and disappears the moment it's disabled. Lets the user
// point Safelight at a local folder of built extensions to load them live.

import { DevFolderControls } from "./DevFolderControls";

export function DevSettings() {
  const native = window.safelightNative;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-text-muted">
          Development extensions folder
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-text-muted">
          Point Safelight at a local folder of built extensions to load them
          live, without installing through GitHub. Point at a single extension's
          folder — a <code>safelight.json</code> manifest plus its built bundle,
          the same layout an installed extension uses — or at a parent folder
          whose immediate subfolders are each one. Loaded extensions appear
          under Extensions ▸ Dev.
        </p>
      </div>

      {!native ? (
        <p className="text-[11px] text-text-muted">
          Loading extensions from a folder requires the desktop app.
        </p>
      ) : (
        <DevFolderControls variant="settings" />
      )}
    </div>
  );
}
