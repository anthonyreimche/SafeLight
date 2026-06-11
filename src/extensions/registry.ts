// Central contribution registry. Built-ins and external plugins register
// through the same door, so a built-in panel can be replaced by a better
// community version. Reactive (zustand) so UI updates as plugins load.

import { create } from "zustand";
import type {
  LayoutContribution,
  PanelContribution,
  PanelSlot,
  SliderIconContribution,
  ThemeContribution,
} from "./types";

export interface RegisteredPanel extends PanelContribution {
  extensionId: string;
}
export interface RegisteredTheme extends ThemeContribution {
  extensionId: string;
}
export interface RegisteredIcon extends SliderIconContribution {
  extensionId: string;
}
export interface RegisteredLayout extends LayoutContribution {
  extensionId: string;
}

interface RegistryState {
  panels: Record<string, RegisteredPanel>;
  themes: Record<string, RegisteredTheme>;
  sliderIcons: Record<string, RegisteredIcon>;
  layouts: Record<string, RegisteredLayout>;
}

export const useRegistry = create<RegistryState>(() => ({
  panels: {},
  themes: {},
  sliderIcons: {},
  layouts: {},
}));

export function registerPanel(extensionId: string, c: PanelContribution): void {
  useRegistry.setState((s) => ({
    panels: { ...s.panels, [c.id]: { ...c, extensionId } },
  }));
}

export function registerTheme(extensionId: string, c: ThemeContribution): void {
  useRegistry.setState((s) => ({
    themes: { ...s.themes, [c.id]: { ...c, extensionId } },
  }));
}

export function registerSliderIcon(
  extensionId: string,
  c: SliderIconContribution,
): void {
  useRegistry.setState((s) => ({
    sliderIcons: { ...s.sliderIcons, [c.id]: { ...c, extensionId } },
  }));
}

export function registerLayout(
  extensionId: string,
  c: LayoutContribution,
): void {
  useRegistry.setState((s) => ({
    layouts: { ...s.layouts, [c.id]: { ...c, extensionId } },
  }));
}

/** Remove every contribution an extension made (uninstall/deactivate). */
export function unregisterExtension(extensionId: string): void {
  const drop = <T extends { extensionId: string }>(map: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(map).filter(([, v]) => v.extensionId !== extensionId),
    );
  useRegistry.setState((s) => ({
    panels: drop(s.panels),
    themes: drop(s.themes),
    sliderIcons: drop(s.sliderIcons),
    layouts: drop(s.layouts),
  }));
}

export function panelsForSlot(
  panels: Record<string, RegisteredPanel>,
  slot: PanelSlot,
): RegisteredPanel[] {
  return Object.values(panels)
    .filter((p) => (p.slot ?? "none") === slot)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}
