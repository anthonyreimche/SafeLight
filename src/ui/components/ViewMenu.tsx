// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// View menu: toggle any registered panel and switch themes. Panels open as
// floating windows centered over the workspace (drag one into a rail to dock
// it). Everything listed here comes from the extension registry.

import { useRegistry } from "@/extensions/registry";
import { toggleDockPanelFloating, useDockStore } from "@/extensions/dock";
import { applyTheme, useThemeStore } from "@/extensions/themes";
import { MenuItem, MenuLabel, TopBarMenu } from "./TopBarMenu";

export function ViewMenu() {
  const panels = useRegistry((s) => s.panels);
  const themes = useRegistry((s) => s.themes);
  const openPanels = useDockStore((s) => s.open);
  const activeTheme = useThemeStore((s) => s.activeId);

  const panelList = Object.values(panels).sort((a, b) =>
    a.title.localeCompare(b.title),
  );
  const themeList = Object.values(themes).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return (
    <TopBarMenu label="View">
      {() => (
        <>
          <MenuLabel>Panels</MenuLabel>
          {panelList.map((p) => (
            <MenuItem
              key={p.id}
              checked={openPanels.includes(p.id)}
              onClick={() => toggleDockPanelFloating(p.id)}
            >
              {p.title}
            </MenuItem>
          ))}
          <div className="my-1 border-t border-border-subtle" />
          <MenuLabel>Theme</MenuLabel>
          {themeList.map((t) => (
            <MenuItem
              key={t.id}
              checked={activeTheme === t.id}
              onClick={() => applyTheme(t.id)}
            >
              {t.name}
            </MenuItem>
          ))}
        </>
      )}
    </TopBarMenu>
  );
}
