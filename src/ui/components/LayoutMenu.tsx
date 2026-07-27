// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Layout menu: switch the whole dock between registered layout presets
// (built-in "Classic" plus any extension-provided arrangements) and "Custom",
// the user's own saved per-module arrangement. Editing the dock while a
// preset is active automatically flips back to Custom.

import { useRegistry } from "@/extensions/registry";
import {
  CUSTOM_LAYOUT,
  applyDockLayout,
  useLayoutStore,
  useUserLayouts,
} from "@/extensions/dock";
import { openPreferences } from "./PreferencesDialog";
import { MenuItem, TopBarMenu } from "./TopBarMenu";

export function LayoutMenu() {
  const layouts = useRegistry((s) => s.layouts);
  const userLayouts = useUserLayouts((s) => s.layouts);
  const activeId = useLayoutStore((s) => s.activeId);

  const layoutList = Object.values(layouts).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const userList = Object.values(userLayouts).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return (
    <TopBarMenu label="Layout">
      {(close) => (
        <>
          <MenuItem
            checked={activeId === CUSTOM_LAYOUT}
            title="Your own arrangement. Any change you make to a layout is saved here."
            onClick={() => applyDockLayout(CUSTOM_LAYOUT)}
          >
            Custom
          </MenuItem>
          {userList.map((l) => (
            <MenuItem
              key={l.id}
              checked={activeId === l.id}
              onClick={() => applyDockLayout(l.id)}
            >
              {l.name}
            </MenuItem>
          ))}
          {layoutList.length > 0 && (
            <div className="my-1 border-t border-border-subtle" />
          )}
          {layoutList.map((l) => (
            <MenuItem
              key={l.id}
              checked={activeId === l.id}
              title={l.description}
              onClick={() => applyDockLayout(l.id)}
            >
              {l.name}
            </MenuItem>
          ))}
          <div className="my-1 border-t border-border-subtle" />
          <MenuItem
            checked={false}
            title="Add, rename or delete layouts in Preferences"
            onClick={() => {
              close();
              openPreferences("Interface");
            }}
          >
            Manage layouts…
          </MenuItem>
        </>
      )}
    </TopBarMenu>
  );
}
