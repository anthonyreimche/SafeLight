// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Layout menu: switch the whole dock between registered layout presets
// (built-in "Classic" plus any extension-provided arrangements) and "Custom",
// the user's own saved per-module arrangement. Editing the dock while a
// preset is active automatically flips back to Custom. Extensions add sections
// below the layouts (registerLayoutMenu); one may take over the saved list.

import { useLayoutMenus, useRegistry } from "@/extensions/registry";
import { ErrorBoundary } from "./ErrorBoundary";
import { boundaryKey } from "@/extensions/guard";
import {
  CUSTOM_LAYOUT,
  applyDockLayout,
  useLayoutStore,
  useUserLayouts,
} from "@/extensions/dock";
import { openPreferences } from "@/ui/preferences/preferences-store";
import { MenuItem, TopBarMenu } from "./TopBarMenu";

export function LayoutMenu() {
  const layouts = useRegistry((s) => s.layouts);
  const userLayouts = useUserLayouts((s) => s.layouts);
  const activeId = useLayoutStore((s) => s.activeId);
  const sections = useLayoutMenus();
  const showSaved = !sections.some((m) => m.replacesSavedLayouts);

  const layoutList = Object.values(layouts).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const userList = Object.values(userLayouts).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return (
    <TopBarMenu label="Layout">
      {(close) => {
        const pick = (id: string) => {
          close();
          void applyDockLayout(id);
        };
        return (
          <>
            <MenuItem
              checked={activeId === CUSTOM_LAYOUT}
              title="Your own arrangement. Any change you make to a layout is saved here."
              onClick={() => pick(CUSTOM_LAYOUT)}
            >
              Custom
            </MenuItem>
            {showSaved && userList.map((l) => (
              <MenuItem
                key={l.id}
                checked={activeId === l.id}
                onClick={() => pick(l.id)}
              >
                {l.name}
              </MenuItem>
            ))}
            {layoutList.length > 0 && (
              <div role="separator" className="my-1 border-t border-border-subtle" />
            )}
            {layoutList.map((l) => (
              <MenuItem
                key={l.id}
                checked={activeId === l.id}
                title={l.description}
                onClick={() => pick(l.id)}
              >
                {l.name}
              </MenuItem>
            ))}
            {sections.map(({ id, component: Section }) => (
              <ErrorBoundary key={boundaryKey(id, Section)} what={`Layout menu "${id}"`} className="px-3 text-[11px] text-danger">
                <div role="separator" className="my-1 border-t border-border-subtle" />
                <Section close={close} />
              </ErrorBoundary>
            ))}
            {showSaved && (
              <>
                <div role="separator" className="my-1 border-t border-border-subtle" />
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
          </>
        );
      }}
    </TopBarMenu>
  );
}
