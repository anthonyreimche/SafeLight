// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Central contribution registry. Built-ins and external plugins register
// through the same door, so a built-in panel can be replaced by a better
// community version. Reactive (zustand) so UI updates as plugins load.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";
import type {
  CatalogHooksContribution,
  ExportProcessorContribution,
  FilenameTemplateContribution,
  GridFilterContribution,
  GridMenuItemContribution,
  LayoutContribution,
  LibrarySortContribution,
  ModuleContribution,
  ModuleId,
  PanelContribution,
  PanelHeaderAccessoryContribution,
  PipelineContribution,
  PresetImporterContribution,
  ProcessingStageContribution,
  SettingsContribution,
  SlotContribution,
  SlotName,
  SliderIconContribution,
  StylesheetContribution,
  ThemeContribution,
} from "./types";
import {
  getAllDescriptors,
  getExtensionName,
  registerStageParams,
  unregisterExtensionParams,
  unregisterStageParams,
  type ParamDescriptor,
} from "./param-registry";
import { isBuiltinExtension } from "./core-extension";
import { officialExtension } from "./official-extensions";
import { checkStageContract } from "./stage-validation";
import { rawNameClash } from "@/rendering/webgl/raw-names";
import { writesRawNames } from "@/rendering/webgl/builtin-stage";
import { pipelineContractError } from "./pipeline-validation";
import { noteRendersPixels } from "./extension-kinds";
import { unregisterExtensionActions } from "@/state/keybindings-store";
import { clearExtensionCursors } from "@/state/cursor-store";
import { setPickDrag } from "@/modules/develop/pick-drag";
import { setCanvasTool } from "@/modules/develop/canvas-tool";
import { dropExtensionVariables } from "./variables-host";
import { CATALOG_HOOK_TIMEOUT_MS, ExtensionTimeoutError, dropSubscriptions, forgetCallbackFailures, guardCallback, guardExtension } from "./guard";
import { forgetStartFailure } from "./start-failures";

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

/** A tab in the module strip: a registered module. */
export interface ModuleTab {
  id: ModuleId;
  label: string;
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
   *  window after the core styles (see stylesheets.ts). */
  stylesheets: Record<string, RegisteredStylesheet>;
  /** Keyed by module id. Top-level modules an extension contributed, Library
   *  and Develop among them. */
  modules: Record<string, RegisteredModule>;
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
  gridMenuItems: {},
  slots: {},
  panelHeaderAccessories: {},
  librarySorts: {},
  stylesheets: {},
  modules: {},
}));

/** What each id-keyed registry map holds, before the registry stamps the
 *  owning extension on. */
interface ContributionOf {
  panels: PanelContribution;
  themes: ThemeContribution;
  sliderIcons: SliderIconContribution;
  layouts: LayoutContribution;
  pipelines: PipelineContribution;
  exportProcessors: ExportProcessorContribution;
  filenameTemplates: FilenameTemplateContribution;
  processingStages: ProcessingStageContribution;
  catalogHooks: CatalogHooksContribution;
  presetImporters: PresetImporterContribution;
  gridFilters: GridFilterContribution;
  gridMenuItems: GridMenuItemContribution;
  slots: SlotContribution;
  panelHeaderAccessories: PanelHeaderAccessoryContribution;
  librarySorts: LibrarySortContribution;
  stylesheets: StylesheetContribution;
  modules: ModuleContribution;
}

type IdKind = keyof ContributionOf;
type Entry<K extends IdKind> = RegistryState[K][string];

interface KindSpec<K extends IdKind> {
  /** The register call that fills the map, named in refusal warnings. */
  call: string;
  /** Checks a contribution, does what its registration needs besides storing
   *  it, and returns what to store, or null to refuse. `claim` is the id
   *  ownership check (see mayRegister): call it where the refusals before it
   *  end. Left out, the contribution is stored once claimed. */
  vet?: (extensionId: string, c: ContributionOf[K], claim: () => boolean) => ContributionOf[K] | null;
  /** Fields the registry adds to the stored entry, worked out from the map as
   *  it stands. */
  stamp?: (s: RegistryState, c: ContributionOf[K]) => Partial<Entry<K>>;
}

/** Whether `extensionId` may register contribution `id` into registry map
 *  `kind`: an id is free, or its own to replace. One another extension holds
 *  stays with it, with a warning naming both: throwing would fail an activation
 *  that is otherwise fine. */
function mayRegister(extensionId: string, kind: IdKind, id: string): boolean {
  const holder = moduleEntry<{ extensionId: string }>(useRegistry.getState()[kind], id)?.extensionId;
  if (holder === undefined || holder === extensionId) return true;
  console.warn(
    `[extensions] ${extensionId}: "${id}" is already registered by ${holder}; ${KINDS[kind].call} ignored`,
  );
  return false;
}

/** `owns` with the keys that aren't develop params left out, with a warning:
 *  previewing the panel off resets each to its default every frame. */
function knownOwns(extensionId: string, c: PanelContribution): PanelContribution["owns"] {
  if (c.owns === undefined) return undefined;
  if (!Array.isArray(c.owns)) {
    console.warn(`[extensions] ${extensionId}: panel "${c.id}" owns isn't a list of develop params; ignored`);
    return undefined;
  }
  const unknown = c.owns.filter((k) => !Object.hasOwn(DEFAULT_DEVELOP_PARAMS, k));
  if (unknown.length === 0) return c.owns;
  console.warn(
    `[extensions] ${extensionId}: panel "${c.id}" owns ${unknown.map((k) => `"${k}"`).join(", ")}, not develop params; ignored`,
  );
  return c.owns.filter((k) => !unknown.includes(k));
}

/** The official extension module `id` belongs to, if any: the list row
 *  without a built-in named "safelight.<id>" (Library, Develop). */
function officialModuleOwner(id: ModuleId): string | undefined {
  const row = officialExtension(`safelight.${id}`);
  return row && row.replaces === null ? row.id : undefined;
}

/** The first inter-stage variable `c` produces that another registered stage
 *  already produces, as a refusal message, or null. Names are global across
 *  extensions, so a second producer would leave the value to pipeline order. */
function producerClash(
  c: ProcessingStageContribution,
  stages: Readonly<Record<string, RegisteredProcessingStage>>,
): string | null {
  for (const v of c.produces ?? []) {
    const other = Object.values(stages).find(
      (s) => s.id !== c.id && (s.produces ?? []).some((o) => o.name === v.name),
    );
    if (other) return `stage "${c.id}": inter-stage variable "${v.name}" is already produced by stage "${other.id}"`;
  }
  return null;
}

/** A stage whose values its derive works out: Safelight's own or an official
 *  extension's (derive is ignored on any other). */
const derivesValues = (c: ProcessingStageContribution, extensionId: string): boolean =>
  typeof c.derive === "function" && writesRawNames({ id: c.id, extensionId });

const KINDS: { [K in IdKind]: KindSpec<K> } = {
  panels: {
    call: "registerPanel",
    vet: (extensionId, c, claim) => (claim() ? { ...c, owns: knownOwns(extensionId, c) } : null),
  },
  themes: { call: "registerTheme" },
  sliderIcons: { call: "registerSliderIcon" },
  layouts: { call: "registerLayout" },
  pipelines: {
    call: "registerPipeline",
    vet: (extensionId, c, claim) => {
      if (!claim()) return null;
      const error = pipelineContractError(c);
      if (error) {
        console.error(`[extensions] ${extensionId}: ${error}; transform not registered`);
        return null;
      }
      noteRendersPixels(extensionId);
      // A transform's params are bag values like a stage's uniforms: descriptors
      // keep them through normalizeParamBag, and registering again replaces them.
      // Only a registration that declared params has descriptors to drop: a
      // param-less transform sharing a stage's id leaves the stage's in place.
      if (useRegistry.getState().pipelines[c.id]?.params) unregisterStageParams(c.id);
      if (c.params) registerStageParams(c.id, c.name, extensionId, c.params);
      return c;
    },
  },
  exportProcessors: {
    call: "registerExportProcessor",
    vet: (extensionId, c, claim) => {
      if (typeof c.process !== "function" && typeof c.processPixels !== "function") {
        console.warn(
          `[extensions] ${extensionId}: export processor "${c.id}" declares neither process nor processPixels as a function; registerExportProcessor ignored`,
        );
        return null;
      }
      if (!claim()) return null;
      noteRendersPixels(extensionId);
      return c;
    },
    // Processors run in registration order. An id keeps its slot on
    // re-registration; new ids append past the current max so a prior removal
    // can't leave a gap that re-mints a colliding index.
    stamp: (s, c) => ({
      order:
        s.exportProcessors[c.id]?.order ??
        Object.values(s.exportProcessors).reduce((m, p) => Math.max(m, p.order), -1) + 1,
    }),
  },
  filenameTemplates: { call: "registerFilenameTemplate" },
  processingStages: {
    call: "registerProcessingStage",
    vet: (extensionId, c, claim) => {
      const check = checkStageContract(c, extensionId);
      if (check.error) {
        console.error(`[extensions] ${extensionId}: ${check.error}; stage not registered`);
        return null;
      }
      const stages = useRegistry.getState().processingStages;
      const clash = producerClash(c, stages) ?? rawNameClash(c, extensionId, stages);
      if (clash) {
        console.error(`[extensions] ${extensionId}: ${clash}; stage not registered`);
        return null;
      }
      if (!claim()) return null;
      noteRendersPixels(extensionId);
      if (check.readsIgnored) console.warn(`[extensions] ${extensionId}: ${check.readsIgnored}`);
      for (const warning of check.warnings) {
        console.warn(`[extensions] ${extensionId}: ${warning}`);
      }
      const stage: ProcessingStageContribution = check.readsIgnored ? { ...c, reads: "source" } : c;
      // Clear any prior descriptors for this id, so re-registering the same stage
      // with a different uniform set (e.g. swapping denoise methods) fully replaces
      // its params instead of leaking the old ones.
      unregisterStageParams(stage.id);
      // A stage that derives its values takes them from the photo's DevelopParams,
      // so they never ride the param bag.
      if (!derivesValues(stage, extensionId)) registerStageParams(stage.id, stage.name, extensionId, stage.uniforms);
      return stage;
    },
  },
  catalogHooks: {
    call: "registerCatalogHooks",
    vet: (extensionId, c, claim) => {
      if (!claim()) return null;
      timedOutHooks.delete(extensionId);
      return c;
    },
  },
  presetImporters: { call: "registerPresetImporter" },
  gridFilters: { call: "registerGridFilter" },
  gridMenuItems: { call: "registerGridMenuItem" },
  slots: { call: "registerSlot" },
  panelHeaderAccessories: { call: "registerPanelHeaderAccessory" },
  librarySorts: { call: "registerLibrarySort" },
  stylesheets: { call: "registerStylesheet" },
  modules: {
    call: "registerModule",
    vet: (extensionId, c, claim) => {
      if (!MODULE_ID.test(c.id)) {
        console.warn(
          `[extensions] ${extensionId}: "${c.id}" is not a valid module id (lower-case letters, digits, ".", "_", "-", starting with a letter or digit); registerModule ignored`,
        );
        return null;
      }
      const owner = officialModuleOwner(c.id);
      if (owner && owner !== extensionId) {
        console.warn(
          `[extensions] ${extensionId}: the "${c.id}" module belongs to ${owner}; registerModule ignored`,
        );
        return null;
      }
      return claim() ? c : null;
    },
  },
};

function registerKind<K extends IdKind>(kind: K, extensionId: string, c: ContributionOf[K]): void {
  const spec: KindSpec<K> = KINDS[kind];
  let claimed: boolean | undefined;
  const claim = () => (claimed ??= mayRegister(extensionId, kind, c.id));
  const stored = spec.vet ? spec.vet(extensionId, c, claim) : c;
  if (!stored || !claim()) return;
  useRegistry.setState((s) => ({
    [kind]: { ...s[kind], [c.id]: { ...stored, extensionId, ...spec.stamp?.(s, stored) } },
  }));
}

/** The extension that registered `id` into map `kind`, if any. */
function ownerOf(kind: IdKind, id: string): string | undefined {
  const map: Record<string, { extensionId: string } | undefined> = useRegistry.getState()[kind];
  return map[id]?.extensionId;
}

function dropEntry(kind: IdKind, id: string): void {
  useRegistry.setState((s) => {
    const next = { ...s[kind] };
    delete next[id];
    return { [kind]: next };
  });
}

/** Remove contribution `id` of map `kind` if `extensionId` registered it: only
 *  the owning extension may remove it. */
function unregisterKind(kind: IdKind, extensionId: string, id: string): void {
  if (ownerOf(kind, id) === extensionId) dropEntry(kind, id);
}

export function registerPanel(extensionId: string, c: PanelContribution): void {
  registerKind("panels", extensionId, c);
}

/** The name a panel goes by in the View menu and its dock header. An
 *  extension's only panel takes the extension's name, so the panel matches what
 *  the user installed; panels of an extension with several keep their titles. */
export function panelTitle(panels: Record<string, RegisteredPanel>, id: string): string {
  const panel = panels[id];
  if (!panel) return id;
  const own = Object.values(panels).filter((p) => p.extensionId === panel.extensionId);
  if (own.length > 1) return panel.title;
  return getExtensionName(panel.extensionId, panel.title);
}

export const usePanelTitle = (id: string): string =>
  useRegistry((s) => panelTitle(s.panels, id));

export function registerTheme(extensionId: string, c: ThemeContribution): void {
  registerKind("themes", extensionId, c);
}

export function registerSliderIcon(
  extensionId: string,
  c: SliderIconContribution,
): void {
  registerKind("sliderIcons", extensionId, c);
}

export function registerLayout(
  extensionId: string,
  c: LayoutContribution,
): void {
  registerKind("layouts", extensionId, c);
}

/** A module id: lower-case letters, digits, ".", "_" and "-", starting with a
 *  letter or digit. The id travels in its pop-out window's `?detached=` URL and
 *  names that window, so a detached window can always read back its module. */
export const MODULE_ID = /^[a-z0-9][a-z0-9._-]*$/;

/** The entry for module `id` in a record keyed by module id, only if the record
 *  owns it: "constructor" is a valid id, and a plain lookup would find
 *  Object.prototype's. */
export function moduleEntry<T>(
  record: Partial<Record<string, T>> | undefined,
  id: string,
): T | undefined {
  return record && Object.hasOwn(record, id) ? record[id] : undefined;
}

export function registerModule(extensionId: string, c: ModuleContribution): void {
  registerKind("modules", extensionId, c);
}

/** Sort order of the contributions that declare one: lower first, 100 when unset. */
const byOrder = (a: { order?: number }, b: { order?: number }): number =>
  (a.order ?? 100) - (b.order ?? 100);

/** Library and Develop lead the strip once their extensions register them, as
 *  they did built in. Only their official extensions can register those ids. */
const LEADING_MODULES: readonly ModuleId[] = ["library", "develop"];

function leadRank(id: ModuleId): number {
  const i = LEADING_MODULES.indexOf(id);
  return i < 0 ? LEADING_MODULES.length : i;
}

function sortedModules(modules: Record<string, RegisteredModule>): RegisteredModule[] {
  return Object.values(modules).sort(
    (a, b) =>
      leadRank(a.id) - leadRank(b.id) ||
      byOrder(a, b) ||
      a.label.localeCompare(b.label),
  );
}

/** Tab order: Library and Develop, then the other modules by order then
 *  label. Non-reactive snapshot for code outside React. */
export function moduleTabs(): ModuleTab[] {
  return sortedModules(useRegistry.getState().modules);
}

/** The tab the main window turns to when module `gone` isn't there: the first
 *  other tab, or null when there is none. */
export function fallbackModule(gone?: ModuleId): ModuleId | null {
  return moduleTabs().find((m) => m.id !== gone)?.id ?? null;
}

/** Reactive moduleTabs. Registered entries are the registry's own objects, so
 *  the shallow compare holds across unrelated registry changes. */
export function useModules(): ModuleTab[] {
  return useRegistry(
    useShallow((s) => sortedModules(s.modules)),
  );
}

/** Whether module `id` is registered in this window. */
export function hasModule(id: ModuleId): boolean {
  return moduleEntry(useRegistry.getState().modules, id) !== undefined;
}

/** Display label for a module id. An unknown id (its extension isn't loaded in
 *  this window) reads as itself. */
export function moduleLabel(id: ModuleId): string {
  return moduleEntry(useRegistry.getState().modules, id)?.label ?? id;
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
  registerKind("pipelines", extensionId, c);
}

export function registerExportProcessor(
  extensionId: string,
  c: ExportProcessorContribution,
): void {
  registerKind("exportProcessors", extensionId, c);
}

export function registerFilenameTemplate(
  extensionId: string,
  c: FilenameTemplateContribution,
): void {
  registerKind("filenameTemplates", extensionId, c);
}

export function registerProcessingStage(
  extensionId: string,
  c: ProcessingStageContribution,
): void {
  registerKind("processingStages", extensionId, c);
}

/** Whether `extensionId` may set or clear stage texture `qualifiedKey`
 *  ("{stageId}.{key}"). A key belongs to the longest registered stage id it
 *  extends, and only that stage's extension may write it. With no such stage
 *  a clear is let through, so an extension can drop what it left after
 *  unregistering its stage. */
export function mayWriteStageTexture(
  extensionId: string,
  qualifiedKey: string,
  clearing: boolean,
): boolean {
  let holder: RegisteredProcessingStage | undefined;
  for (const stage of Object.values(useRegistry.getState().processingStages)) {
    if (qualifiedKey.startsWith(`${stage.id}.`) && stage.id.length > (holder?.id.length ?? 0)) holder = stage;
  }
  if (holder ? holder.extensionId === extensionId : clearing) return true;
  console.warn(
    holder
      ? `[extensions] ${extensionId}: "${holder.id}" is registered by ${holder.extensionId}; setStageTexture ignored`
      : `[extensions] ${extensionId}: no stage is registered for "${qualifiedKey}"; setStageTexture ignored`,
  );
  return false;
}

/** Remove a single processing stage (e.g. a denoise method set to "Off") without
 *  disabling the whole extension. The render bridge re-syncs + recompiles. */
export function unregisterProcessingStage(extensionId: string, id: string): void {
  // Only the owning extension may remove it — check before dropping the stage's
  // param descriptors, or a stranger's call would strip params off a live stage.
  if (ownerOf("processingStages", id) !== extensionId) return;
  unregisterStageParams(id);
  dropEntry("processingStages", id);
}

export function registerCatalogHooks(
  extensionId: string,
  c: CatalogHooksContribution,
): void {
  registerKind("catalogHooks", extensionId, c);
}

export function registerPresetImporter(
  extensionId: string,
  c: PresetImporterContribution,
): void {
  registerKind("presetImporters", extensionId, c);
}

export function registerGridFilter(
  extensionId: string,
  c: GridFilterContribution,
): void {
  registerKind("gridFilters", extensionId, c);
}

export function registerGridMenuItem(
  extensionId: string,
  c: GridMenuItemContribution,
): void {
  registerKind("gridMenuItems", extensionId, c);
}

/** Reactive, order-sorted list of extension items for the grid context menu. */
export function useGridMenuItems(): RegisteredGridMenuItem[] {
  return useRegistry(useShallow((s) => Object.values(s.gridMenuItems).sort(byOrder)));
}

export function registerSlot(extensionId: string, c: SlotContribution): void {
  registerKind("slots", extensionId, c);
}

export function unregisterSlot(extensionId: string, id: string): void {
  unregisterKind("slots", extensionId, id);
}

export function registerStylesheet(
  extensionId: string,
  c: StylesheetContribution,
): void {
  registerKind("stylesheets", extensionId, c);
}

export function unregisterStylesheet(extensionId: string, id: string): void {
  unregisterKind("stylesheets", extensionId, id);
}

export function registerPanelHeaderAccessory(
  extensionId: string,
  c: PanelHeaderAccessoryContribution,
): void {
  registerKind("panelHeaderAccessories", extensionId, c);
}

/** Reactive, order-sorted list of controls to render in every panel header. */
export function usePanelHeaderAccessories(): RegisteredPanelHeaderAccessory[] {
  return useRegistry(useShallow((s) => Object.values(s.panelHeaderAccessories).sort(byOrder)));
}

/** Reactive list of grid-filter predicates, for the Library grid. useShallow so the
 *  freshly-built array doesn't trigger an update loop. */
export function useGridFilters(): RegisteredGridFilter[] {
  return useRegistry(useShallow((s) => Object.values(s.gridFilters)));
}

/** Fire every registered grid filter's onClear (the "Clear filters" action);
 *  one that throws doesn't stop the rest. */
export function runGridFilterClears(): void {
  for (const g of Object.values(useRegistry.getState().gridFilters)) {
    if (g.onClear) guardCallback(g.extensionId, "grid filter clear", g.onClear, undefined, g)();
  }
}

/** Reactive, order-sorted list of components contributed to a UI slot. */
export function useSlot(name: SlotName): RegisteredSlot[] {
  return useRegistry(
    useShallow((s) => Object.values(s.slots).filter((c) => c.slot === name).sort(byOrder)),
  );
}

export function registerLibrarySort(
  extensionId: string,
  c: LibrarySortContribution,
): void {
  registerKind("librarySorts", extensionId, c);
}

/** Reactive list of extension-contributed Library sort orders, for the toolbar. */
export function useLibrarySorts(): RegisteredLibrarySort[] {
  return useRegistry(useShallow((s) => Object.values(s.librarySorts)));
}

// ─── Catalog hook emitters (called by core) ─────────────────────────────────
// Each awaits every registered handler in turn. A handler that throws, or
// doesn't finish within CATALOG_HOOK_TIMEOUT_MS, is logged and skipped so a
// misbehaving extension can't break or stall an import or a save. An import
// runs onPhotoImport once per photo, so after one of an extension's hooks
// times out all of its hooks are skipped until it registers them again.

type ImportCtx = Parameters<NonNullable<CatalogHooksContribution["onPhotoImport"]>>[0];
type MetadataCtx = Parameters<NonNullable<CatalogHooksContribution["onMetadataChange"]>>[0];
type EditCommitCtx = Parameters<NonNullable<CatalogHooksContribution["onEditCommit"]>>[0];
type RemoveCtx = Parameters<NonNullable<CatalogHooksContribution["onPhotoRemove"]>>[0];

/** Extensions whose catalog hooks are skipped after one timed out. */
const timedOutHooks = new Set<string>();

function catalogHookList(): RegisteredCatalogHooks[] {
  return Object.values(useRegistry.getState().catalogHooks).filter(
    (h) => !timedOutHooks.has(h.extensionId),
  );
}

/** Run one handler of `h`; undefined when it failed or timed out. */
async function runHook<R>(
  h: RegisteredCatalogHooks,
  name: string,
  call: () => R | PromiseLike<R>,
): Promise<R | undefined> {
  try {
    return await guardExtension(h.extensionId, call, CATALOG_HOOK_TIMEOUT_MS);
  } catch (e) {
    if (!(e instanceof ExtensionTimeoutError)) {
      console.warn(`[ext:${h.extensionId}] ${name} failed:`, e);
    } else if (!timedOutHooks.has(h.extensionId)) {
      timedOutHooks.add(h.extensionId);
      console.warn(
        `[ext:${h.extensionId}] ${name} timed out; its catalog hooks are skipped until it is reloaded:`,
        e,
      );
    }
    return undefined;
  }
}

/** Run every onPhotoImport handler and merge their returned partials (later
 *  handlers win). Returns the merged overrides, or null if none contributed. */
export async function emitPhotoImport(
  ctx: ImportCtx,
): Promise<Partial<import("@/catalog/types").CatalogPhoto> | null> {
  let merged: Partial<import("@/catalog/types").CatalogPhoto> | null = null;
  for (const h of catalogHookList()) {
    if (!h.onPhotoImport) continue;
    const ov = await runHook(h, "onPhotoImport", () => h.onPhotoImport?.(ctx));
    if (ov) merged = { ...(merged ?? {}), ...ov };
  }
  return merged;
}

export async function emitMetadataChange(ctx: MetadataCtx): Promise<void> {
  for (const h of catalogHookList())
    if (h.onMetadataChange) await runHook(h, "onMetadataChange", () => h.onMetadataChange?.(ctx));
}

export async function emitEditCommit(ctx: EditCommitCtx): Promise<void> {
  for (const h of catalogHookList())
    if (h.onEditCommit) await runHook(h, "onEditCommit", () => h.onEditCommit?.(ctx));
}

export async function emitPhotoRemove(ctx: RemoveCtx): Promise<void> {
  for (const h of catalogHookList())
    if (h.onPhotoRemove) await runHook(h, "onPhotoRemove", () => h.onPhotoRemove?.(ctx));
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

/** Whether a bag value has moved from its param's default, for the preset
 *  fields that carry bag keys. */
export function bagDiffersFromDefault(
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
    // A built-in's adjustments are DevelopParams preset fields already.
    if (isBuiltinExtension(stage.extensionId)) continue;
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

// What is kept for a stage outside the registry (the render bridge's stage
// textures) goes with it when its extension is swept.
const stageReleases = new Set<(stageIds: readonly string[]) => void>();

/** Call `release` with the ids of the stages an extension owned whenever
 *  unregisterExtension sweeps one. A single stage removed with
 *  unregisterProcessingStage isn't released: its extension may register it
 *  again and expects what it set for it to be there. */
export function onStagesReleased(release: (stageIds: readonly string[]) => void): void {
  stageReleases.add(release);
}

/** Every registry map an extension's contributions sit in: the id-keyed kinds,
 *  and settings, which is keyed by extension. */
const SWEPT_MAPS = Object.keys({
  ...KINDS,
  settings: true,
} satisfies Record<keyof RegistryState, unknown>) as (keyof RegistryState)[];

/** Per-extension state kept outside the registry, dropped when the extension is
 *  swept. */
const OTHER_SWEEPS: readonly ((extensionId: string) => void)[] = [
  (id) => unregisterExtensionActions(id),
  (id) => clearExtensionCursors(id),
  (id) => setPickDrag(id, null),
  (id) => setCanvasTool(id, null),
  (id) => dropExtensionVariables(id),
  (id) => forgetCallbackFailures(id),
  (id) => dropSubscriptions(id),
  (id) => forgetStartFailure(id),
];

/** Remove every contribution an extension made (uninstall/deactivate). */
export function unregisterExtension(extensionId: string): void {
  const drop = <T extends { extensionId: string }>(map: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(map).filter(([, v]) => v.extensionId !== extensionId),
    );
  // Clean up param descriptors for any processing stages owned by this extension
  const stages = useRegistry.getState().processingStages;
  const owned: string[] = [];
  for (const s of Object.values(stages)) {
    if (s.extensionId !== extensionId) continue;
    unregisterStageParams(s.id);
    owned.push(s.id);
  }
  unregisterExtensionParams(extensionId);
  useRegistry.setState((s) =>
    Object.fromEntries(SWEPT_MAPS.map((kind) => [kind, drop<{ extensionId: string }>(s[kind])])),
  );
  for (const sweep of OTHER_SWEEPS) sweep(extensionId);
  if (owned.length > 0) for (const release of stageReleases) release(owned);
}
