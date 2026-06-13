// Central contribution registry. Built-ins and external plugins register
// through the same door, so a built-in panel can be replaced by a better
// community version. Reactive (zustand) so UI updates as plugins load.

import { create } from "zustand";
import type {
  LayoutContribution,
  PanelContribution,
  PanelSlot,
  PipelineContribution,
  SettingsContribution,
  SliderIconContribution,
  ThemeContribution,
} from "./types";
import { unregisterExtensionActions } from "@/state/keybindings-store";

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
export interface RegisteredSettings extends SettingsContribution {
  extensionId: string;
}
export interface RegisteredPipeline extends PipelineContribution {
  extensionId: string;
}

interface RegistryState {
  panels: Record<string, RegisteredPanel>;
  themes: Record<string, RegisteredTheme>;
  sliderIcons: Record<string, RegisteredIcon>;
  layouts: Record<string, RegisteredLayout>;
  /** Keyed by extension id — one settings dialog per extension. */
  settings: Record<string, RegisteredSettings>;
  pipelines: Record<string, RegisteredPipeline>;
}

export const useRegistry = create<RegistryState>(() => ({
  panels: {},
  themes: {},
  sliderIcons: {},
  layouts: {},
  settings: {},
  pipelines: {},
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

export function registerSettings(
  extensionId: string,
  c: SettingsContribution,
): void {
  useRegistry.setState((s) => ({
    settings: { ...s.settings, [extensionId]: { ...c, extensionId } },
  }));
}

export function registerPipeline(
  extensionId: string,
  c: PipelineContribution,
): void {
  useRegistry.setState((s) => ({
    pipelines: { ...s.pipelines, [c.id]: { ...c, extensionId } },
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
    settings: drop(s.settings),
    pipelines: drop(s.pipelines),
  }));
  unregisterExtensionActions(extensionId);
}

export function panelsForSlot(
  panels: Record<string, RegisteredPanel>,
  slot: PanelSlot,
): RegisteredPanel[] {
  return Object.values(panels)
    .filter((p) => (p.slot ?? "none") === slot)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}
