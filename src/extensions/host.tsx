// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension host: builds the SafelightAPI handed to every extension (built-in
// and external) and boots the whole system. Called once from main.tsx before
// the first render.

import * as React from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import type { SafelightAPI } from "./types";
import {
  collectPresetStages,
  describePresetBag,
  usePresetImporters,
  useRegistry,
  registerCatalogHooks,
  registerExportProcessor,
  registerFilenameTemplate,
  registerGridFilter,
  registerGridMenuItem,
  registerLayout,
  registerLibrarySort,
  registerModule,
  registerPanel,
  registerPanelHeaderAccessory,
  registerPipeline,
  registerPresetImporter,
  registerProcessingStage,
  unregisterProcessingStage,
  mayWriteStageTexture,
  registerSettings,
  registerSlot,
  unregisterSlot,
  registerSliderIcon,
  registerStylesheet,
  unregisterStylesheet,
  registerTheme,
} from "./registry";
import { initStylesheets } from "./stylesheets";
import { initStagePrewarm, prewarmExtension } from "./dock/prewarm";
import {
  applyPipeline,
  effectivePipelineId,
  initPipelines,
  transformParamKeys,
  transformPresetField,
  usePipelineStore,
} from "./pipelines";
import {
  dropStageTextureVariants,
  getRenderBridge,
  prepareStageVariant,
  setStageTexture,
  setStageTextureProvider,
  stageTextureProviderOwner,
} from "@/rendering/render-bridge";
import { variantTextureKey } from "@/rendering/webgl/stage-texture-variant";
import {
  getExtSetting,
  initExtSettings,
  onExtSettingChange,
  setExtSetting,
} from "./ext-settings";
import {
  getBinding,
  initKeybindings,
  listBindings,
  registerExtensionAction,
  useKeybindings,
} from "@/state/keybindings-store";
import {
  applyDockLayout,
  initDockLayouts,
  toggleDockPanel,
  useDockPlacement,
  useDockStore,
  useLayoutStore,
} from "./dock";
import { useVisiblePhotos } from "@/modules/library/photo-navigation";
import { usePhotoActions } from "@/modules/library/photo-actions";
import {
  FOCUS_KEYWORD_INPUT_EVENT,
  useCullingShortcuts,
} from "@/modules/library/use-culling-shortcuts";
import { LibraryListRow } from "@/modules/library/LibraryListRow";
import { applyTheme, initThemes, useThemeStore } from "./themes";
import {
  captureDevelopFloatFrame,
  captureDevelopFrame,
  readDevelopSourceSample,
  renderDevelopPhotoFloatFrame,
  renderDevelopPhotoFrame,
  useDevelopOverlay,
} from "./develop-host";
import { MaskScopeProvider, useMaskScope, useParamScope } from "@/modules/develop/mask-scope";
import { showMaskCoverage } from "@/modules/develop/mask-coverage-view";
import { ownStageValues, setStageViewValues } from "@/modules/develop/stage-view-values";
import { brushTips, registerBrushTip, unregisterBrushTip, useBrushTips } from "@/rendering/brush-tip-registry";
import { inputProfileOwner, invalidateInputProfiles, registerInputProfiles } from "@/catalog/input-profiles";
import { setInputProfiles, watchInputProfiles } from "@/state/input-profile-redraw";
import { useMaskPanels } from "@/modules/develop/mask-panels";
import {
  exportPhotos,
  getDefaultExportSettings,
  proPhotoAt8Bit,
  renderPhotosToBlobs,
} from "@/modules/export/export-image";
import { getPhotoData, putPhotoData } from "@/state/photo-blob-store";
import { requestThumbnail } from "@/state/thumbnail-loader";
import {
  createFolder,
  deleteFolder,
  exportPhotoData,
  moveFolder,
  movePhotos,
  renameFolder,
  renamePhoto,
} from "@/project/folder-ops";
import { nativePathOf, pickDirectoryHandle, revealNativePath } from "@/project/native-fs";
import { useProjectStore } from "@/project/project-store";
import { isEditState } from "@/project/edit-files";
import { isPlainObject } from "@/project/fs";
import { settleSelectedPhoto } from "@/modules/library/import-photos";
import { importFiles } from "@/modules/library/import-files";
import { librarySourcesAPI } from "./library-sources-api";
import { keptDirectoriesAPI } from "./kept-directories";
import { networkAPI } from "./network";
import { secretsAPI } from "./secrets";
import { socketsAPI } from "./sockets";
import { exportPreset, importPresetFile, pickPresetFile, presetPickerAccept } from "@/modules/develop/preset-io";
import { presetFields, summarizePreset } from "@/modules/develop/preset-summary";
import { loadSavedEdit } from "@/catalog/edit-params";
import { normalizeParams, usesOlderProcessing } from "@/catalog/types";
import { renderPhotoHistogram } from "@/rendering/thumbnail-renderer";
import { onBroadcast } from "@/state/broadcast";
import {
  activateAccessibility,
  deactivateAccessibility,
  useKeyboardCanvasEditing,
  restoreAccessibility,
  settleAccessibility,
} from "@/state/accessibility";
import { useTitleBarOverlay } from "@/ui/window-chrome";
import { readAppVersion, readWebGLInfo } from "@/diagnostics/environment";
import { initDevFolder, teardownDevFolder } from "./devtools/dev-folder";
import { DevFolderControls } from "./devtools/DevFolderControls";
import {
  PIPELINE_VERSIONS,
  useOpenProcessVersion,
  usePipelineRows,
  usePipelineScreen,
} from "./pipeline-inspect";
import { useExtStoreUI } from "./store-ui";
import {
  contributionToSpec,
  registerCursor,
  setCanvasCursor,
  resolveCursorCss,
  CURSOR_LABELS,
} from "@/state/cursor-store";
import { uiKit } from "./ui-kit";
import { getAllDescriptors, getParamDescriptor } from "./param-registry";
import {
  listAdjustments,
  getAdjustment,
  setAdjustment,
} from "@/state/develop-adjustments";
import {
  checkAllExtensionUpdates,
  EXT_UPDATE_POLL_MS,
  initEnablement,
  loadBuiltins,
  loadExternalPlugins,
} from "./loader";
import { initPinSync } from "./pins";
import { provideScopedAPI } from "./instance";
import { trackSubscription } from "./guard";
import { ensureCoreModules, startEssentialsMigration } from "./essentials-migration";
import { DEVTOOLS_EXTENSION_ID } from "./official-extensions";
import { windowRole } from "@/diagnostics/environment";
import { initVariables, variableRegistry } from "./variables-host";
import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { Histogram } from "@/ui/components/Histogram";
import { CurveEditor } from "@/ui/components/CurveEditor";
import { Rating } from "@/ui/components/Rating";
import { Thumbnail } from "@/ui/components/Thumbnail";
import { ContextMenu } from "@/ui/components/ContextMenu";
import { ScaleStepper } from "@/ui/components/ScaleStepper";
import { ResolutionControl } from "@/modules/export/ResolutionControl";
import { alertDialog, confirmDialog } from "@/ui/components/ConfirmDialog";
import { pushEscapeHandler } from "@/ui/escape-stack";
import { VirtualGrid } from "@/ui/components/VirtualGrid";
import { ZoomControls } from "@/ui/ZoomControls";
import { SurroundControl } from "@/ui/SurroundControl";
import { DisplayTransformControl } from "@/ui/DisplayTransformControl";
import { ProcessingUpdateControl } from "@/modules/develop/ProcessingUpdateControl";
import { DevelopStage } from "@/modules/develop/DevelopStage";
import { AssessmentToggle, ProofToggle } from "@/modules/develop/view-toggles";
import { setPickDrag, usePickDragStore } from "@/modules/develop/pick-drag";
import { setCanvasTool, useCanvasToolStore } from "@/modules/develop/canvas-tool";
import { onSourcePixels, sourcePixels } from "@/rendering/source-pixels";
import { probeCanvas } from "@/modules/develop/canvas-probe";
import { autoAdjust } from "@/hooks/use-auto-adjust";
import { PickerIcon } from "@/ui/components/PickerIcon";
import { AutoButton } from "@/ui/components/AutoButton";
import { Slot } from "./Slot";
import { useActivePhoto } from "@/state/use-active-photo";
import { photoDisplayName } from "@/catalog/copy-name";
import { stackOf } from "@/catalog/stacks";
import { openExtensions } from "@/ui/components/extensions-dialog-store";
import { openingAnotherPhoto, useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import { catalogStorage } from "@/catalog/storage";
import { GRID_SIZE_MAX, GRID_SIZE_MIN, GRID_SIZE_STEP, useUIStore } from "@/state/ui-store";
import { goToModule } from "@/state/detach";
import { initSettings, updateSettingsFromExtension, useSettings } from "@/state/settings-store";
import { initDisplayProfile } from "@/rendering/display-profile-store";
import { initPresets, usePresetsStore } from "@/state/presets-store";
import {
  openPreferences,
  closePreferences,
  togglePreferences,
} from "@/ui/preferences/preferences-store";
import {
  Field,
  OptionRow,
  ToggleField,
  useFieldVisible,
} from "@/ui/preferences/fields";

type DevtoolsAPI = NonNullable<SafelightAPI["devtools"]>;

function nativeDetails(): DevtoolsAPI["native"] {
  const native = window.safelightNative;
  if (!native) return undefined;
  return {
    platform: native.platform,
    versions: native.versions,
    gpuInfo: native.diagnostics?.gpuInfo,
    metrics: native.diagnostics?.metrics,
  };
}

/** Handed to Developer Tools only. window.safelight is the "host" API every
 *  extension can reach, so the host goes without it too. */
function devtoolsAPI(): DevtoolsAPI {
  const variables = variableRegistry();
  return {
    devFolder: { init: initDevFolder, teardown: teardownDevFolder, Controls: DevFolderControls },
    pipeline: {
      versions: PIPELINE_VERSIONS,
      useOpenVersion: useOpenProcessVersion,
      useRows: usePipelineRows,
      useScreen: usePipelineScreen,
    },
    variables: {
      inspect: variables.inspect,
      subscribeChanges: variables.subscribeChanges,
      changeCount: variables.changeCount,
      windowName: variables.windowName,
    },
    webglInfo: readWebGLInfo,
    appVersion: readAppVersion,
    electron: window.safelightNative?.devtools,
    native: nativeDetails(),
  };
}

const PHOTO_TEXT_FIELDS = ["id", "filename", "relPath", "folder"] as const;
const PHOTO_NUMBER_FIELDS = ["width", "height", "rating", "rotation"] as const;

/** Why `photos` can't go into the catalogue, or null when they can. The store
 *  writes records to storage before it shows them, so a malformed one would
 *  stay stored and one reusing an id would overwrite that photo's record. */
function catalogPhotoError(photos: unknown): string | null {
  if (!Array.isArray(photos)) return "not a list of photo records";
  const taken = new Set(useCatalogStore.getState().photos.map((p) => p.id));
  const batch = new Set<string>();
  for (const [i, p] of photos.entries()) {
    const invalid = `photo ${i} is not a valid record; it needs`;
    if (!isPlainObject(p)) return `${invalid} to be an object`;
    const text = PHOTO_TEXT_FIELDS.find((k) => typeof p[k] !== "string");
    if (text) return `${invalid} a string ${text}`;
    const number = PHOTO_NUMBER_FIELDS.find((k) => !Number.isFinite(p[k]));
    if (number) return `${invalid} a finite number ${number}`;
    if (!Array.isArray(p.keywords)) return `${invalid} a keywords list`;
    if (!isPlainObject(p.exif)) return `${invalid} an exif object`;
    const id = String(p.id);
    if (taken.has(id)) return `photo id "${id}" is already in the catalogue`;
    if (batch.has(id)) return `photo id "${id}" appears twice`;
    batch.add(id);
  }
  return null;
}

/** Every register* call made through a scoped API is tagged with the
 *  extension's id, so uninstalling can sweep all of its contributions. */
/** Whether `extensionId` provides stage texture `plain`: only it may stop the
 *  provider or drop its variants, whether or not a stage holds the key now. */
function providesStageTexture(extensionId: string, plain: string): boolean {
  const owner = stageTextureProviderOwner(plain);
  if (owner === extensionId) return true;
  if (owner) console.warn(`[extensions] ${extensionId}: "${plain}" is provided by ${owner}; ignored`);
  return false;
}

export function makeScopedAPI(extensionId: string): SafelightAPI {
  return {
    version: 1,
    extensionId,
    react: React,
    registerPanel: (c) => registerPanel(extensionId, c),
    registerTheme: (c) => registerTheme(extensionId, c),
    registerLayout: (c) => registerLayout(extensionId, c),
    registerModule: (c) => registerModule(extensionId, c),
    registerSliderIcon: (c) => registerSliderIcon(extensionId, c),
    registerPipeline: (c) => registerPipeline(extensionId, c),
    registerProcessingStage: (c) => registerProcessingStage(extensionId, c),
    unregisterProcessingStage: (id) => unregisterProcessingStage(extensionId, id),
    setStageTexture: (stageId, key, tex, variant) => {
      const plain = `${stageId}.${key}`;
      const qualifiedKey = variant === undefined ? plain : variantTextureKey(plain, variant);
      if (qualifiedKey === null) {
        console.warn(`[extensions] ${extensionId}: texture variant "${variant}" of "${plain}" isn't 1 to 64 letters, digits, - or _; setStageTexture ignored`);
        return;
      }
      if (mayWriteStageTexture(extensionId, qualifiedKey, tex === null)) setStageTexture(qualifiedKey, tex);
    },
    setStageTextureProvider: (stageId, key, provide) => {
      const plain = `${stageId}.${key}`;
      if (provide ? mayWriteStageTexture(extensionId, plain, false) : providesStageTexture(extensionId, plain))
        setStageTextureProvider(plain, extensionId, provide);
    },
    dropStageTextureVariants: (stageId, key, variant) => {
      const plain = `${stageId}.${key}`;
      if (providesStageTexture(extensionId, plain)) dropStageTextureVariants(plain, variant);
    },
    prepareStageTextureVariant: async (stageId, key, variant) => {
      const plain = `${stageId}.${key}`;
      if (!mayWriteStageTexture(extensionId, plain, false)) throw new Error(`"${plain}" isn't a stage texture of ${extensionId}`);
      await prepareStageVariant(plain, variant);
    },
    registerKeybinding: (c) => registerExtensionAction(extensionId, c),
    registerSettings: (c) => registerSettings(extensionId, c),
    registerExportProcessor: (c) => registerExportProcessor(extensionId, c),
    registerFilenameTemplate: (c) => registerFilenameTemplate(extensionId, c),
    registerCatalogHooks: (c) => registerCatalogHooks(extensionId, c),
    registerPresetImporter: (c) => registerPresetImporter(extensionId, c),
    registerGridFilter: (c) => registerGridFilter(extensionId, c),
    registerSlot: (c) => registerSlot(extensionId, c),
    unregisterSlot: (id) => unregisterSlot(extensionId, id),
    registerPanelHeaderAccessory: (c) =>
      registerPanelHeaderAccessory(extensionId, c),
    registerCursor: (c) => registerCursor(extensionId, c),
    registerLibrarySort: (c) => registerLibrarySort(extensionId, c),
    registerGridMenuItem: (c) => registerGridMenuItem(extensionId, c),
    registerStylesheet: (c) => registerStylesheet(extensionId, c),
    unregisterStylesheet: (id) => unregisterStylesheet(extensionId, id),
    settings: {
      get: (key, fallback) => getExtSetting(extensionId, key, fallback),
      set: (key, value) => setExtSetting(extensionId, key, value),
      onChange: trackSubscription(
        extensionId,
        (cb: (key: string, value: unknown) => void) => onExtSettingChange(extensionId, cb),
      ),
    },
    components: {
      Panel,
      Slider,
      Histogram,
      CurveEditor,
      Rating,
      Thumbnail,
      PhotoListRow: LibraryListRow,
      ContextMenu,
      ScaleStepper,
      ResolutionControl,
      Slot,
      MaskScope: MaskScopeProvider,
      VirtualGrid,
      DevelopCanvas: DevelopStage,
      ZoomControls,
      SurroundControl,
      DisplayTransformControl,
      ProcessingUpdateControl,
      ProofToggle,
      AssessmentToggle,
      PickerIcon,
      AutoButton,
    },
    ui: {
      ...uiKit,
      confirmDialog,
      alertDialog,
      onEscape: (handler) =>
        pushEscapeHandler(() => {
          try {
            handler();
          } catch (err) {
            console.warn(`[extensions] ${extensionId}: its Escape handler threw:`, err);
          }
        }),
    },
    reactDom: { createPortal },
    stores: {
      useDevelopStore,
      useCatalogStore,
      useUIStore,
      useSettings,
      usePresetsStore,
      useKeybindings,
      useThemeStore,
      useLayoutStore,
      usePipelineStore,
      useProjectStore,
      /** For plugins that need their own state. */
      create,
    },
    registry: { use: (selector) => useRegistry(selector) },
    appSettings: { update: updateSettingsFromExtension },
    params: {
      list: () => Array.from(getAllDescriptors().values()),
      get: (qualifiedKey) => getParamDescriptor(qualifiedKey),
    },
    dock: {
      togglePanel: toggleDockPanel,
      usePanelPlacement: useDockPlacement,
      isPanelOpen: (id) => useDockStore.getState().open.includes(id),
    },
    themes: { apply: applyTheme },
    layouts: { apply: applyDockLayout },
    pipelines: { apply: applyPipeline, effectiveId: effectivePipelineId, paramKeys: transformParamKeys },
    preferences: {
      open: openPreferences,
      close: closePreferences,
      toggle: togglePreferences,
      fields: { Field, ToggleField, OptionRow, useFieldVisible },
    },
    navigation: { goTo: goToModule },
    keybindings: { getBinding, list: () => listBindings() },
    cursors: { labels: CURSOR_LABELS, resolve: (token) => resolveCursorCss(token) },
    develop: {
      useDevelopOverlay,
      useMaskScope,
      useParamScope,
      captureFrame: captureDevelopFrame,
      captureFloatFrame: captureDevelopFloatFrame,
      renderPhotoFrame: renderDevelopPhotoFrame,
      renderPhotoFloatFrame: renderDevelopPhotoFloatFrame,
      readSourceSample: readDevelopSourceSample,
      setCanvasCursor: (cursor, opts) =>
        setCanvasCursor(
          extensionId,
          cursor == null || typeof cursor === "string"
            ? cursor
            : contributionToSpec(cursor),
          opts,
        ),
      putPhotoData: (key, data) => putPhotoData(`${extensionId}.${key}`, data),
      setPickDrag: (tool) => setPickDrag(extensionId, tool),
      usePickDragHeld: () => usePickDragStore((s) => s.held?.owner === extensionId),
      setCanvasTool: (tool) => setCanvasTool(extensionId, tool),
      readDevelopedPixels: (edge) => getRenderBridge().readDevelopedPixels(edge),
      sourcePixels,
      onSourcePixels: trackSubscription(extensionId, onSourcePixels),
      useCanvasToolHeld: () => useCanvasToolStore((s) => s.held?.owner === extensionId),
      probe: probeCanvas,
      probeMaskColour: (u, v) => getRenderBridge().probe(u, v, "mask"),
      showMaskCoverage,
      registerBrushTip: (tip) => registerBrushTip(extensionId, tip),
      unregisterBrushTip: (id) => unregisterBrushTip(extensionId, id),
      brushTips,
      useBrushTips,
      registerInputProfiles: (resolver) => registerInputProfiles(extensionId, resolver),
      invalidateInputProfiles: () => invalidateInputProfiles(extensionId),
      setViewValues: (values) =>
        setStageViewValues(
          extensionId,
          values && ownStageValues(extensionId, values, Object.values(useRegistry.getState().processingStages)),
        ),
      prewarmStages: () => prewarmExtension(extensionId),
      useMaskPanels,
      useOlderProcessing: () => useDevelopStore((s) => usesOlderProcessing(s.params)),
      autoAdjust,
      getPhotoData: (key) => getPhotoData(`${extensionId}.${key}`),
      adjustments: {
        list: () => listAdjustments(),
        get: getAdjustment,
        set: setAdjustment,
      },
      normalizeParams,
    },
    export: {
      getDefaultSettings: () => getDefaultExportSettings(),
      // Merge the caller's overrides over the persisted defaults, so a caller
      // can pass just { format, longEdge, quality } and inherit the rest. A PNG
      // is 8-bit unless the caller asks: the user's PNG default is for their own
      // exports, and a headless render that decodes the file back to 8 bits would
      // only pay for the slow, large 16-bit path.
      renderPhotos: (photos, settings, onProgress, options) =>
        renderPhotosToBlobs(
          photos,
          { ...getDefaultExportSettings(), pngBitDepth: 8, ...(settings ?? {}) },
          onProgress,
          options,
        ),
      exportPhotos,
      proPhotoAt8Bit,
    },
    catalog: {
      addPhotos: async (photos, opts) => {
        const error = catalogPhotoError(photos);
        if (error) throw new Error(`addPhotos: ${error}`);
        await useCatalogStore.getState().addPhotos(photos, opts);
      },
      getEditState: (photoId) =>
        catalogStorage()
          .getEditState(photoId)
          .then((e) => e ?? null),
      putEditState: async (editState) => {
        if (!isEditState(editState))
          throw new Error(
            "putEditState: not a valid edit state; it needs a photoId, a currentIndex and a stack of snapshots that are objects",
          );
        const stored = catalogStorage().putEditState(editState);
        // Develop's next commit writes back the history it holds, which would drop
        // this edit, so the photo open there reloads from the catalogue. The storage
        // holds the edit once the call returns, so that is now, not after the save.
        const develop = useDevelopStore.getState();
        const reloaded =
          develop.photoId === editState.photoId &&
          !openingAnotherPhoto() &&
          develop.loadEdit(editState.photoId, develop.asShotTemperature);
        await Promise.all([stored, reloaded]);
      },
      renamePhoto: (photoId, newBaseName) => renamePhoto(photoId, newBaseName),
      useVisiblePhotos,
      usePhotoActions,
      useCullingShortcuts,
      requestThumbnail,
      readPreview: async (photoId) =>
        (await catalogStorage().readPreview?.(photoId, { hold: false })) ?? null,
      settleSelectedPhoto,
      renderHistogram: async (photo) => {
        const { params, paramBag } = await loadSavedEdit(photo.id, photo.exif.colorTemperature);
        return renderPhotoHistogram(photo, params, paramBag);
      },
      useActivePhoto,
      setStack: (ids, opts) => useCatalogStore.getState().setStack(ids, opts),
      clearStack: (ids) => useCatalogStore.getState().clearStack(ids),
      setInputProfile: async (ids, token) => {
        const owner = inputProfileOwner();
        if (owner !== extensionId) {
          throw new Error(
            owner
              ? `setInputProfile: ${owner} holds the input profile resolver, and only it may set tokens`
              : "setInputProfile: register an input profile resolver before setting tokens",
          );
        }
        if (!Array.isArray(ids)) throw new Error("setInputProfile: ids must be an array of photo ids");
        if (token !== null && typeof token !== "string") throw new Error("setInputProfile: the token must be a string or null");
        await setInputProfiles(ids, token);
      },
      stackOf: (id) => stackOf(useCatalogStore.getState().photos, id),
      photoDisplayName,
      exportPhotoData,
      gridSize: { min: GRID_SIZE_MIN, max: GRID_SIZE_MAX, step: GRID_SIZE_STEP },
    },
    events: { onBroadcast: trackSubscription(extensionId, onBroadcast), FOCUS_KEYWORD_INPUT: FOCUS_KEYWORD_INPUT_EVENT },
    project: {
      createFolder,
      renameFolder,
      moveFolder,
      movePhotos,
      deleteFolder,
      pickDirectory: pickDirectoryHandle,
      ...keptDirectoriesAPI(extensionId),
      pathOf: nativePathOf,
      reveal: revealNativePath,
    },
    library: { importFiles, ...librarySourcesAPI(extensionId) },
    network: networkAPI(extensionId),
    secrets: secretsAPI(extensionId),
    sockets: socketsAPI(extensionId),
    presets: {
      useImporters: usePresetImporters,
      describeBag: describePresetBag,
      summarize: summarizePreset,
      fields: (params, paramBag) =>
        presetFields(
          params,
          collectPresetStages(paramBag),
          transformPresetField(params.displayTransform, paramBag),
        ),
      exportFile: exportPreset,
      importFile: importPresetFile,
      pickFile: pickPresetFile,
      pickerAccept: presetPickerAccept,
    },
    extensions: {
      openStore: (category) => {
        if (category) useExtStoreUI.getState().openCategory(category);
        openExtensions();
      },
    },
    accessibility: { activate: activateAccessibility, deactivate: deactivateAccessibility, useKeyboardCanvasEditing },
    titleBar: { useOverlay: useTitleBarOverlay },
    devtools: extensionId === DEVTOOLS_EXTENSION_ID ? devtoolsAPI() : undefined,
    variables: variableRegistry().scoped(extensionId),
  };
}

let booted = false;

provideScopedAPI(makeScopedAPI);

export function initExtensionHost(): void {
  if (booted) return;
  booted = true;
  initVariables(); // before any extension registers, and before window.safelight below
  // Before anything reads the state it renames from the old built-in ids.
  const essentials = windowRole() === "main" ? startEssentialsMigration() : [];
  loadBuiltins(); // pre-installed extensions, minus any the user disabled
  // Before initThemes, as the built-in Accessibility extension did: the
  // installed one activates only after the theme is on screen.
  restoreAccessibility();
  window.safelight = makeScopedAPI("host");
  initSettings();
  initDisplayProfile();
  initKeybindings();
  initPresets();
  initExtSettings();
  initEnablement();
  initPinSync();
  initThemes();
  initStylesheets();
  initPipelines();
  initDockLayouts();
  initStagePrewarm();
  // One window redraws the edited thumbnails a resolver change leaves stale.
  if (windowRole() === "main") watchInputProfiles();
  // Load external plugins, then quietly check them for updates (and auto-update
  // if the user opted in). The check is gated on a setting and rate-limited.
  void loadExternalPlugins().then(() => {
    settleAccessibility();
    if (windowRole() === "main") void ensureCoreModules(essentials);
    void checkAllExtensionUpdates();
  });
  // Re-discover periodically so a version bumped while the app is left open is
  // noticed without a restart (force past the per-extension TTL).
  setInterval(() => void checkAllExtensionUpdates(true), EXT_UPDATE_POLL_MS);
}
