// Central contribution registry. Built-ins and external plugins register
// through the same door, so a built-in panel can be replaced by a better
// community version. Reactive (zustand) so UI updates as plugins load.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type {
  CatalogHooksContribution,
  ExportProcessorContribution,
  FilenameTemplateContribution,
  GridFilterContribution,
  LayoutContribution,
  LibrarySortContribution,
  PanelContribution,
  PanelSlot,
  PipelineContribution,
  PresetImporterContribution,
  ProcessingStageContribution,
  SettingsContribution,
  SlotContribution,
  SlotName,
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
import { clearExtensionCursors } from "@/state/cursor-store";

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
export interface RegisteredCatalogHooks extends CatalogHooksContribution {
  extensionId: string;
}
export interface RegisteredPresetImporter extends PresetImporterContribution {
  extensionId: string;
}
export interface RegisteredGridFilter extends GridFilterContribution {
  extensionId: string;
}
export interface RegisteredSlot extends SlotContribution {
  extensionId: string;
}
export interface RegisteredLibrarySort extends LibrarySortContribution {
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
  /** Keyed by contribution id. */
  catalogHooks: Record<string, RegisteredCatalogHooks>;
  presetImporters: Record<string, RegisteredPresetImporter>;
  /** Keyed by contribution id. Extra predicates that narrow the Library grid. */
  gridFilters: Record<string, RegisteredGridFilter>;
  /** Keyed by contribution id. Components mounted into named core UI slots. */
  slots: Record<string, RegisteredSlot>;
  /** Keyed by contribution id. Extra Library sort orders. */
  librarySorts: Record<string, RegisteredLibrarySort>;
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
  catalogHooks: {},
  presetImporters: {},
  gridFilters: {},
  slots: {},
  librarySorts: {},
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
  // Clear any prior descriptors for this id first, so re-registering the same
  // stage with a different uniform set (e.g. swapping denoise methods) fully
  // replaces its params instead of leaking the old ones.
  unregisterStageParams(c.id);
  registerStageParams(c.id, extensionId, c.uniforms);
  useRegistry.setState((s) => ({
    processingStages: {
      ...s.processingStages,
      [c.id]: { ...c, extensionId },
    },
  }));
}

/** Remove a single processing stage (e.g. a denoise method set to "Off") without
 *  disabling the whole extension. The render bridge re-syncs + recompiles. */
export function unregisterProcessingStage(extensionId: string, id: string): void {
  unregisterStageParams(id);
  useRegistry.setState((s) => {
    const owner = s.processingStages[id];
    // Only the owning extension may remove it.
    if (!owner || owner.extensionId !== extensionId) return s;
    const next = { ...s.processingStages };
    delete next[id];
    return { processingStages: next };
  });
}

export function registerLensProfile(
  extensionId: string,
  c: LensProfileContribution,
): void {
  useRegistry.setState((s) => ({
    lensProfiles: { ...s.lensProfiles, [c.id]: { ...c, extensionId } },
  }));
}

export function registerCatalogHooks(
  extensionId: string,
  c: CatalogHooksContribution,
): void {
  useRegistry.setState((s) => ({
    catalogHooks: { ...s.catalogHooks, [c.id]: { ...c, extensionId } },
  }));
}

export function registerPresetImporter(
  extensionId: string,
  c: PresetImporterContribution,
): void {
  useRegistry.setState((s) => ({
    presetImporters: { ...s.presetImporters, [c.id]: { ...c, extensionId } },
  }));
}

export function registerGridFilter(
  extensionId: string,
  c: GridFilterContribution,
): void {
  useRegistry.setState((s) => ({
    gridFilters: { ...s.gridFilters, [c.id]: { ...c, extensionId } },
  }));
}

export function registerSlot(extensionId: string, c: SlotContribution): void {
  useRegistry.setState((s) => ({
    slots: { ...s.slots, [c.id]: { ...c, extensionId } },
  }));
}

/** Reactive list of grid-filter predicates, for LibraryGrid. useShallow so the
 *  freshly-built array doesn't trigger an update loop. */
export function useGridFilters(): RegisteredGridFilter[] {
  return useRegistry(useShallow((s) => Object.values(s.gridFilters)));
}

/** Non-reactive snapshot for code outside React (e.g. culling navigation). */
export function gridFilterPredicates(): ((
  p: import("@/catalog/types").CatalogPhoto,
) => boolean)[] {
  return Object.values(useRegistry.getState().gridFilters).map((g) => g.test);
}

/** Fire every registered grid filter's onClear (the "Clear filters" action). */
export function runGridFilterClears(): void {
  for (const g of Object.values(useRegistry.getState().gridFilters)) g.onClear?.();
}

/** Reactive, order-sorted list of components contributed to a UI slot. */
export function useSlot(name: SlotName): RegisteredSlot[] {
  return useRegistry(
    useShallow((s) =>
      Object.values(s.slots)
        .filter((c) => c.slot === name)
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
    ),
  );
}

export function registerLibrarySort(
  extensionId: string,
  c: LibrarySortContribution,
): void {
  useRegistry.setState((s) => ({
    librarySorts: { ...s.librarySorts, [c.id]: { ...c, extensionId } },
  }));
}

/** Reactive list of extension-contributed Library sort orders, for the toolbar. */
export function useLibrarySorts(): RegisteredLibrarySort[] {
  return useRegistry(useShallow((s) => Object.values(s.librarySorts)));
}

/** The comparator for a sort id, or undefined if it's a built-in / unknown sort.
 *  Non-reactive snapshot for code outside React (e.g. culling navigation). */
export function librarySortCompare(
  id: string,
): ((
  a: import("@/catalog/types").CatalogPhoto,
  b: import("@/catalog/types").CatalogPhoto,
) => number) | undefined {
  return useRegistry.getState().librarySorts[id]?.compare;
}

// ─── Catalog hook emitters (called by core) ─────────────────────────────────
// Each awaits every registered handler. A handler that throws is logged and
// skipped so a misbehaving extension can't break an import or a save.

type ImportCtx = Parameters<NonNullable<CatalogHooksContribution["onPhotoImport"]>>[0];
type MetadataCtx = Parameters<NonNullable<CatalogHooksContribution["onMetadataChange"]>>[0];
type EditCommitCtx = Parameters<NonNullable<CatalogHooksContribution["onEditCommit"]>>[0];
type RemoveCtx = Parameters<NonNullable<CatalogHooksContribution["onPhotoRemove"]>>[0];

function catalogHookList(): RegisteredCatalogHooks[] {
  return Object.values(useRegistry.getState().catalogHooks);
}

/** Run every onPhotoImport handler and merge their returned partials (later
 *  handlers win). Returns the merged overrides, or null if none contributed. */
export async function emitPhotoImport(
  ctx: ImportCtx,
): Promise<Partial<import("@/catalog/types").CatalogPhoto> | null> {
  let merged: Partial<import("@/catalog/types").CatalogPhoto> | null = null;
  for (const h of catalogHookList()) {
    if (!h.onPhotoImport) continue;
    try {
      const ov = await h.onPhotoImport(ctx);
      if (ov) merged = { ...(merged ?? {}), ...ov };
    } catch (e) {
      console.warn(`[ext:${h.extensionId}] onPhotoImport failed:`, e);
    }
  }
  return merged;
}

export async function emitMetadataChange(ctx: MetadataCtx): Promise<void> {
  for (const h of catalogHookList()) {
    if (!h.onMetadataChange) continue;
    try {
      await h.onMetadataChange(ctx);
    } catch (e) {
      console.warn(`[ext:${h.extensionId}] onMetadataChange failed:`, e);
    }
  }
}

export async function emitEditCommit(ctx: EditCommitCtx): Promise<void> {
  for (const h of catalogHookList()) {
    if (!h.onEditCommit) continue;
    try {
      await h.onEditCommit(ctx);
    } catch (e) {
      console.warn(`[ext:${h.extensionId}] onEditCommit failed:`, e);
    }
  }
}

export async function emitPhotoRemove(ctx: RemoveCtx): Promise<void> {
  for (const h of catalogHookList()) {
    if (!h.onPhotoRemove) continue;
    try {
      await h.onPhotoRemove(ctx);
    } catch (e) {
      console.warn(`[ext:${h.extensionId}] onPhotoRemove failed:`, e);
    }
  }
}

/** Reactive list of registered preset importers, for the Presets panel.
 *  useShallow so the freshly-built array doesn't trigger an update loop. */
export function usePresetImporters(): RegisteredPresetImporter[] {
  return useRegistry(useShallow((s) => Object.values(s.presetImporters)));
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
    catalogHooks: drop(s.catalogHooks),
    presetImporters: drop(s.presetImporters),
    gridFilters: drop(s.gridFilters),
    slots: drop(s.slots),
    librarySorts: drop(s.librarySorts),
  }));
  unregisterExtensionActions(extensionId);
  clearExtensionCursors(extensionId);
}

export function panelsForSlot(
  panels: Record<string, RegisteredPanel>,
  slot: PanelSlot,
): RegisteredPanel[] {
  return Object.values(panels)
    .filter((p) => (p.slot ?? "none") === slot)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}
