// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

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
  PanelHeaderAccessoryContribution,
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
import {
  getAllDescriptors,
  registerStageParams,
  unregisterExtensionParams,
  unregisterStageParams,
  type ParamDescriptor,
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
export interface RegisteredPanelHeaderAccessory
  extends PanelHeaderAccessoryContribution {
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
  /** Keyed by contribution id. */
  catalogHooks: Record<string, RegisteredCatalogHooks>;
  presetImporters: Record<string, RegisteredPresetImporter>;
  /** Keyed by contribution id. Extra predicates that narrow the Library grid. */
  gridFilters: Record<string, RegisteredGridFilter>;
  /** Keyed by contribution id. Components mounted into named core UI slots. */
  slots: Record<string, RegisteredSlot>;
  /** Keyed by contribution id. Controls rendered in every panel's dock header. */
  panelHeaderAccessories: Record<string, RegisteredPanelHeaderAccessory>;
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
  catalogHooks: {},
  presetImporters: {},
  gridFilters: {},
  slots: {},
  panelHeaderAccessories: {},
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
    const existing = Object.values(s.exportProcessors);
    // Keep an id's slot on re-registration; new ids append past the current max
    // so a prior removal can't leave a gap that re-mints a colliding index.
    const nextOrder =
      existing.reduce((m, p) => Math.max(m, p.order), -1) + 1;
    const order = s.exportProcessors[c.id]?.order ?? nextOrder;
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
  // Only the owning extension may remove it — check before dropping the stage's
  // param descriptors, or a stranger's call would strip params off a live stage.
  const owner = useRegistry.getState().processingStages[id];
  if (!owner || owner.extensionId !== extensionId) return;
  unregisterStageParams(id);
  useRegistry.setState((s) => {
    const next = { ...s.processingStages };
    delete next[id];
    return { processingStages: next };
  });
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

export function unregisterSlot(extensionId: string, id: string): void {
  useRegistry.setState((s) => {
    const owner = s.slots[id];
    // Only the owning extension may remove it.
    if (!owner || owner.extensionId !== extensionId) return s;
    const next = { ...s.slots };
    delete next[id];
    return { slots: next };
  });
}

export function registerPanelHeaderAccessory(
  extensionId: string,
  c: PanelHeaderAccessoryContribution,
): void {
  useRegistry.setState((s) => ({
    panelHeaderAccessories: {
      ...s.panelHeaderAccessories,
      [c.id]: { ...c, extensionId },
    },
  }));
}

/** Reactive, order-sorted list of controls to render in every panel header. */
export function usePanelHeaderAccessories(): RegisteredPanelHeaderAccessory[] {
  return useRegistry(
    useShallow((s) =>
      Object.values(s.panelHeaderAccessories).sort(
        (a, b) => (a.order ?? 100) - (b.order ?? 100),
      ),
    ),
  );
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

// ─── Preset-savable extension stages ────────────────────────────────────────
// Core adjustments (exposure, crop, vignette …) live in DevelopParams and are
// surfaced by the core preset fields, so only genuinely external extensions are
// enumerated here — their params live in the generic paramBag and would
// otherwise be invisible to (and silently bundled into) presets.

/** One external processing stage's preset-savable metadata. */
export interface PresetStageField {
  stageId: string;
  /** Stage display name, shown as the field label. */
  label: string;
  /** "global" looks are offered/pre-checked; "per-image" tools are hidden under
   *  "Show all" and never pre-selected. */
  scope: "global" | "per-image";
  /** Qualified paramBag keys this stage owns (the keys a preset would carry). */
  paramKeys: string[];
  /** True when any owned key in `bag` differs from the stage's default. */
  changed: boolean;
}

/** A built-in stage lives in the "core" / "core.*" extension namespace; its
 *  adjustments are already represented by DevelopParams preset fields. */
function isCoreExtension(extensionId: string): boolean {
  return extensionId === "core" || extensionId.startsWith("core.");
}

function bagDiffersFromDefault(
  value: unknown,
  def: ParamDescriptor["default"],
): boolean {
  if (value === undefined) return false; // absent → still the default
  return JSON.stringify(value) !== JSON.stringify(def);
}

/** Enumerate external processing stages that contribute preset-savable params,
 *  each tagged with its scope and whether `bag` differs from the stage defaults.
 *  Non-reactive snapshot — call it when opening the Save dialog. */
export function collectPresetStages(
  bag: Record<string, unknown>,
): PresetStageField[] {
  const stages = useRegistry.getState().processingStages;
  const descsByStage = new Map<string, ParamDescriptor[]>();
  for (const d of getAllDescriptors().values()) {
    const arr = descsByStage.get(d.stageId);
    if (arr) arr.push(d);
    else descsByStage.set(d.stageId, [d]);
  }

  const out: PresetStageField[] = [];
  for (const stage of Object.values(stages)) {
    if (isCoreExtension(stage.extensionId)) continue;
    const descs = descsByStage.get(stage.id);
    if (!descs || descs.length === 0) continue; // no savable params
    out.push({
      stageId: stage.id,
      label: stage.name,
      scope: stage.presetScope ?? "global",
      paramKeys: descs.map((d) => d.qualifiedKey),
      changed: descs.some((d) => bagDiffersFromDefault(bag[d.qualifiedKey], d.default)),
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/** Display labels for the external stages whose params appear in a saved
 *  preset's bag, for the preset tooltip. Best-effort: stages whose extension is
 *  currently disabled resolve to nothing and are omitted. */
export function describePresetBag(
  bag: Record<string, unknown> | undefined,
): string[] {
  if (!bag || Object.keys(bag).length === 0) return [];
  return collectPresetStages(bag)
    .filter((s) => s.paramKeys.some((k) => k in bag))
    .map((s) => s.label);
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
    catalogHooks: drop(s.catalogHooks),
    presetImporters: drop(s.presetImporters),
    gridFilters: drop(s.gridFilters),
    slots: drop(s.slots),
    panelHeaderAccessories: drop(s.panelHeaderAccessories),
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
