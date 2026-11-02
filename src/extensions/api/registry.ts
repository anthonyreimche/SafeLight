// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What api.registry and api.params read: every contribution as registered,
// with the extension that registered it.

import type {
  CatalogHooksContribution,
  ExportProcessorContribution,
  FilenameTemplateContribution,
  GlslType,
  GridFilterContribution,
  GridMenuItemContribution,
  LayoutContribution,
  LibrarySortContribution,
  ModuleContribution,
  PanelContribution,
  PanelHeaderAccessoryContribution,
  PipelineContribution,
  PresetImporterContribution,
  ProcessingStageContribution,
  SettingsContribution,
  SliderIconContribution,
  SlotContribution,
  StylesheetContribution,
  ThemeContribution,
} from "./contributions";

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
export interface RegisteredCatalogHooks extends CatalogHooksContribution {
  extensionId: string;
}
export interface RegisteredPresetImporter extends PresetImporterContribution {
  extensionId: string;
}
export interface RegisteredGridFilter extends GridFilterContribution {
  extensionId: string;
}
export interface RegisteredGridMenuItem extends GridMenuItemContribution {
  extensionId: string;
}
export interface RegisteredSlot extends SlotContribution {
  extensionId: string;
}
export interface RegisteredPanelHeaderAccessory
  extends PanelHeaderAccessoryContribution {
  extensionId: string;
}
export interface RegisteredLibrarySort extends LibrarySortContribution {
  extensionId: string;
}
export interface RegisteredStylesheet extends StylesheetContribution {
  extensionId: string;
}
export interface RegisteredModule extends ModuleContribution {
  extensionId: string;
}

export interface RegistryState {
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
  /** Keyed by contribution id. */
  catalogHooks: Record<string, RegisteredCatalogHooks>;
  presetImporters: Record<string, RegisteredPresetImporter>;
  /** Keyed by contribution id. Extra predicates that narrow the Library grid. */
  gridFilters: Record<string, RegisteredGridFilter>;
  /** Keyed by contribution id. Extra items appended to the grid's right-click menu. */
  gridMenuItems: Record<string, RegisteredGridMenuItem>;
  /** Keyed by contribution id. Components mounted into named core UI slots. */
  slots: Record<string, RegisteredSlot>;
  /** Keyed by contribution id. Controls rendered in every panel's dock header. */
  panelHeaderAccessories: Record<string, RegisteredPanelHeaderAccessory>;
  /** Keyed by contribution id. Extra Library sort orders. */
  librarySorts: Record<string, RegisteredLibrarySort>;
  /** Keyed by contribution id, in registration order. CSS applied to every
   *  window after the core styles. */
  stylesheets: Record<string, RegisteredStylesheet>;
  /** Keyed by module id. Top-level modules, Library and Develop among them. */
  modules: Record<string, RegisteredModule>;
}

/** A stage uniform another extension contributed, as api.params lists it. */
export interface ParamDescriptor {
  qualifiedKey: string;
  localKey: string;
  stageId: string;
  /** Human-facing name of the owning stage (ProcessingStageContribution.name). */
  stageName: string;
  extensionId: string;
  /** Human-facing name of the owning extension (its manifest name). */
  extensionName: string;
  glslType: GlslType;
  default: number | number[] | boolean;
  range?: { min: number; max: number; step?: number };
  label?: string;
}
