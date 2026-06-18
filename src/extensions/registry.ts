// Central contribution registry. Built-ins and external plugins register
// through the same door, so a built-in panel can be replaced by a better
// community version. Reactive (zustand) so UI updates as plugins load.

import { create } from "zustand";
import type {
  ExportProcessorContribution,
  FilenameTemplateContribution,
  LayoutContribution,
  PanelContribution,
  PanelSlot,
  PipelineContribution,
  ProcessingStageContribution,
  SettingsContribution,
  SliderIconContribution,
  ThemeContribution,
} from "./types";
import type { LensProfileContribution } from "@/lens-profiles/types";
import {
  registerStageParams,
  unregisterExtensionParams,
  unregisterStageParams,
} from "./param-registry";
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
export interface RegisteredExportProcessor extends ExportProcessorContribution {
  extensionId: string;
  /** Insertion index; processors run in registration order. */
  order: number;
}
export interface RegisteredFilenameTemplate extends FilenameTemplateContribution {
  extensionId: string;
}
export interface RegisteredProcessingStage extends ProcessingStageContribution {
  extensionId: string;
}
export interface RegisteredLensProfile extends LensProfileContribution {
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
  exportProcessors: Record<string, RegisteredExportProcessor>;
  filenameTemplates: Record<string, RegisteredFilenameTemplate>;
  processingStages: Record<string, RegisteredProcessingStage>;
  lensProfiles: Record<string, RegisteredLensProfile>;
}

export const useRegistry = create<RegistryState>(() => ({
  panels: {},
  themes: {},
  sliderIcons: {},
  layouts: {},
  settings: {},
  pipelines: {},
  exportProcessors: {},
  filenameTemplates: {},
  processingStages: {},
  lensProfiles: {},
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

export function registerExportProcessor(
  extensionId: string,
  c: ExportProcessorContribution,
): void {
  useRegistry.setState((s) => {
    const order = Object.keys(s.exportProcessors).length;
    return {
      exportProcessors: {
        ...s.exportProcessors,
        [c.id]: { ...c, extensionId, order },
      },
    };
  });
}

export function registerFilenameTemplate(
  extensionId: string,
  c: FilenameTemplateContribution,
): void {
  useRegistry.setState((s) => ({
    filenameTemplates: {
      ...s.filenameTemplates,
      [c.id]: { ...c, extensionId },
    },
  }));
}

export function registerProcessingStage(
  extensionId: string,
  c: ProcessingStageContribution,
): void {
  registerStageParams(c.id, extensionId, c.uniforms);
  useRegistry.setState((s) => ({
    processingStages: {
      ...s.processingStages,
      [c.id]: { ...c, extensionId },
    },
  }));
}

export function registerLensProfile(
  extensionId: string,
  c: LensProfileContribution,
): void {
  useRegistry.setState((s) => ({
    lensProfiles: { ...s.lensProfiles, [c.id]: { ...c, extensionId } },
  }));
}

/** Remove every contribution an extension made (uninstall/deactivate). */
export function unregisterExtension(extensionId: string): void {
  const drop = <T extends { extensionId: string }>(map: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(map).filter(([, v]) => v.extensionId !== extensionId),
    );
  // Clean up param descriptors for any processing stages owned by this extension
  const stages = useRegistry.getState().processingStages;
  for (const s of Object.values(stages)) {
    if (s.extensionId === extensionId) unregisterStageParams(s.id);
  }
  unregisterExtensionParams(extensionId);
  useRegistry.setState((s) => ({
    panels: drop(s.panels),
    themes: drop(s.themes),
    sliderIcons: drop(s.sliderIcons),
    layouts: drop(s.layouts),
    settings: drop(s.settings),
    pipelines: drop(s.pipelines),
    exportProcessors: drop(s.exportProcessors),
    filenameTemplates: drop(s.filenameTemplates),
    processingStages: drop(s.processingStages),
    lensProfiles: drop(s.lensProfiles),
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
