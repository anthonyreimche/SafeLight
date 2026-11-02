// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Pins the hand-written public API shapes to the core objects the host passes
// through them. SafelightAPI spells these out instead of importing the core
// modules, so a core change that would alter what extensions see has to show
// up here: each pair must stay assignable both ways, or `npx tsc --noEmit`
// fails on the drifted line. The checks are compile-time; the test body only
// gives vitest something to run.

import { describe, expect, it } from "vitest";
import type { SafelightAPI } from "./scoped-api";
import type { ParamDescriptor as RealParamDescriptor } from "../param-registry";
import type { RegistryState as RealRegistryState, describePresetBag, usePresetImporters } from "../registry";
import type { uiKit } from "../ui-kit";
import type { Slot } from "../Slot";
import type { useThemeStore } from "../themes";
import type { useLayoutStore } from "../dock";
import type { usePipelineStore } from "../pipelines";
import type { useOpenProcessVersion, usePipelineRows, usePipelineScreen } from "../pipeline-inspect";
import type { VariableRegistry } from "../variables";
import type { initDevFolder, teardownDevFolder } from "../devtools/dev-folder";
import type { DevFolderControls } from "../devtools/DevFolderControls";
import type { Panel } from "@/ui/components/Panel";
import type { Slider } from "@/ui/components/Slider";
import type { Histogram } from "@/ui/components/Histogram";
import type { CurveEditor } from "@/ui/components/CurveEditor";
import type { Thumbnail } from "@/ui/components/Thumbnail";
import type { ContextMenu } from "@/ui/components/ContextMenu";
import type { ScaleStepper } from "@/ui/components/ScaleStepper";
import type { Field, OptionRow, ToggleField, useFieldVisible } from "@/ui/components/PreferencesDialog";
import type { SurroundControl } from "@/ui/SurroundControl";
import type { DisplayTransformControl } from "@/ui/DisplayTransformControl";
import type { useTitleBarOverlay } from "@/ui/window-chrome";
import type { LibraryListRow } from "@/modules/library/LibraryListRow";
import type { PhotoActions as RealPhotoActions } from "@/modules/library/photo-actions";
import type { FOCUS_KEYWORD_INPUT_EVENT, useCullingShortcuts } from "@/modules/library/use-culling-shortcuts";
import type { settleSelectedPhoto } from "@/modules/library/import-photos";
import type { MaskScopeProvider, useMaskScope, useParamScope } from "@/modules/develop/mask-scope";
import type { DevelopStage } from "@/modules/develop/DevelopStage";
import type { ProcessingUpdateControl } from "@/modules/develop/ProcessingUpdateControl";
import type { AssessmentToggle, ProofToggle } from "@/modules/develop/view-toggles";
import type { CanvasTool as RealCanvasTool } from "@/modules/develop/canvas-tool";
import type { MaskPanelEntry as RealMaskPanelEntry } from "@/modules/develop/mask-panels";
import type { PresetField as RealPresetField, summarizePreset } from "@/modules/develop/preset-summary";
import type { exportPreset, importPresetFile, pickPresetFile, presetPickerAccept } from "@/modules/develop/preset-io";
import type {
  ExportProgress as RealExportProgress,
  ExportSettings as RealExportSettings,
  RenderedPhoto as RealRenderedPhoto,
  RenderPhotosOptions as RealRenderPhotosOptions,
  exportPhotos,
  proPhotoAt8Bit,
} from "@/modules/export/export-image";
import type { autoAdjust } from "@/hooks/use-auto-adjust";
import type { useDevelopStore } from "@/state/develop-store";
import type { useCatalogStore } from "@/state/catalog-store";
import type { useUIStore } from "@/state/ui-store";
import type { updateSettings, useSettings } from "@/state/settings-store";
import type { useActivePhoto } from "@/state/use-active-photo";
import type {
  activateAccessibility,
  deactivateAccessibility,
  useKeyboardCanvasEditing,
} from "@/state/accessibility";
import type { useProjectStore } from "@/project/project-store";
import type {
  RenamePhotoResult as RealRenamePhotoResult,
  createFolder,
  deleteFolder,
  exportPhotoData,
  moveFolder,
  movePhotos,
  renameFolder,
} from "@/project/folder-ops";
import type { nativePathOf, pickDirectoryHandle, revealNativePath } from "@/project/native-fs";
import type {
  FloatCaptureOptions as RealFloatCaptureOptions,
  FloatFrame as RealFloatFrame,
  LiveFloatCaptureOptions as RealLiveFloatCaptureOptions,
} from "@/rendering/float-frame";
import type { DevelopedPixels as RealDevelopedPixels } from "@/rendering/render-protocol";
import type { ProcessVersion as RealProcessVersion } from "@/rendering/webgl/shaders";
import type { readAppVersion, readWebGLInfo } from "@/diagnostics/environment";

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Compiles only when A and B are assignable to each other. */
function same<A, B>(..._drift: Mutual<A, B> extends true ? [] : [never]): void {}

type API = SafelightAPI;
type Dev = API["develop"];
type Devtools = NonNullable<API["devtools"]>;
type ReturnOf<F> = F extends (...args: never[]) => infer R ? R : never;
type FirstParam<F> = F extends (first: infer P, ...rest: never[]) => unknown ? P : never;

describe("SafelightAPI public shapes", () => {
  it("match the core components they pass through", () => {
    same<API["components"]["Panel"], typeof Panel>();
    same<API["components"]["Slider"], typeof Slider>();
    same<API["components"]["Histogram"], typeof Histogram>();
    same<API["components"]["CurveEditor"], typeof CurveEditor>();
    same<API["components"]["Thumbnail"], typeof Thumbnail>();
    same<API["components"]["PhotoListRow"], typeof LibraryListRow>();
    same<API["components"]["ContextMenu"], typeof ContextMenu>();
    same<API["components"]["ScaleStepper"], typeof ScaleStepper>();
    same<API["components"]["Slot"], typeof Slot>();
    same<API["components"]["MaskScope"], typeof MaskScopeProvider>();
    same<API["components"]["DevelopCanvas"], typeof DevelopStage>();
    same<API["components"]["SurroundControl"], typeof SurroundControl>();
    same<API["components"]["DisplayTransformControl"], typeof DisplayTransformControl>();
    same<API["components"]["ProcessingUpdateControl"], typeof ProcessingUpdateControl>();
    same<API["components"]["ProofToggle"], typeof ProofToggle>();
    same<API["components"]["AssessmentToggle"], typeof AssessmentToggle>();
    same<Omit<API["ui"], "confirmDialog" | "alertDialog">, typeof uiKit>();
    same<API["preferences"]["fields"]["Field"], typeof Field>();
    same<API["preferences"]["fields"]["ToggleField"], typeof ToggleField>();
    same<API["preferences"]["fields"]["OptionRow"], typeof OptionRow>();
    same<API["preferences"]["fields"]["useFieldVisible"], typeof useFieldVisible>();
    expect(true).toBe(true);
  });

  it("match the core stores and registry", () => {
    same<API["stores"]["useDevelopStore"], typeof useDevelopStore>();
    same<API["stores"]["useCatalogStore"], typeof useCatalogStore>();
    same<API["stores"]["useUIStore"], typeof useUIStore>();
    same<API["stores"]["useSettings"], typeof useSettings>();
    same<API["stores"]["useThemeStore"], typeof useThemeStore>();
    same<API["stores"]["useLayoutStore"], typeof useLayoutStore>();
    same<API["stores"]["usePipelineStore"], typeof usePipelineStore>();
    same<API["stores"]["useProjectStore"], typeof useProjectStore>();
    same<FirstParam<FirstParam<API["registry"]["use"]>>, RealRegistryState>();
    same<API["appSettings"]["update"], typeof updateSettings>();
    same<NonNullable<ReturnOf<API["params"]["get"]>>, RealParamDescriptor>();
    expect(true).toBe(true);
  });

  it("match the develop, export and catalog shapes", () => {
    same<ReturnOf<Dev["useMaskScope"]>, ReturnType<typeof useMaskScope>>();
    same<ReturnOf<Dev["useParamScope"]>, ReturnType<typeof useParamScope>>();
    same<Parameters<Dev["captureFloatFrame"]>[1], RealLiveFloatCaptureOptions | undefined>();
    same<Parameters<Dev["renderPhotoFloatFrame"]>[2], RealFloatCaptureOptions | undefined>();
    same<Awaited<ReturnOf<Dev["captureFloatFrame"]>>, RealFloatFrame | null>();
    same<FirstParam<Dev["setCanvasTool"]>, RealCanvasTool | null>();
    same<Awaited<ReturnOf<Dev["readDevelopedPixels"]>>, RealDevelopedPixels | null>();
    same<ReturnOf<Dev["useMaskPanels"]>, RealMaskPanelEntry[]>();
    same<Dev["autoAdjust"], typeof autoAdjust>();

    same<ReturnOf<API["export"]["getDefaultSettings"]>, RealExportSettings>();
    same<API["export"]["renderPhotos"], (
      photos: Parameters<typeof exportPhotos>[0],
      settings?: Partial<RealExportSettings>,
      onProgress?: (p: RealExportProgress) => void,
      options?: RealRenderPhotosOptions,
    ) => Promise<RealRenderedPhoto[]>>();
    same<API["export"]["exportPhotos"], typeof exportPhotos>();
    same<API["export"]["proPhotoAt8Bit"], typeof proPhotoAt8Bit>();

    same<Awaited<ReturnOf<API["catalog"]["renamePhoto"]>>, RealRenamePhotoResult>();
    same<ReturnOf<API["catalog"]["usePhotoActions"]>, RealPhotoActions>();
    same<API["catalog"]["useCullingShortcuts"], typeof useCullingShortcuts>();
    same<API["catalog"]["settleSelectedPhoto"], typeof settleSelectedPhoto>();
    same<API["catalog"]["useActivePhoto"], typeof useActivePhoto>();
    same<API["catalog"]["exportPhotoData"], typeof exportPhotoData>();
    same<API["events"]["FOCUS_KEYWORD_INPUT"], typeof FOCUS_KEYWORD_INPUT_EVENT>();

    same<API["project"]["createFolder"], typeof createFolder>();
    same<API["project"]["renameFolder"], typeof renameFolder>();
    same<API["project"]["moveFolder"], typeof moveFolder>();
    same<API["project"]["movePhotos"], typeof movePhotos>();
    same<API["project"]["deleteFolder"], typeof deleteFolder>();
    same<API["project"]["pickDirectory"], typeof pickDirectoryHandle>();
    same<API["project"]["pathOf"], typeof nativePathOf>();
    same<API["project"]["reveal"], typeof revealNativePath>();
    expect(true).toBe(true);
  });

  it("match the presets, accessibility and devtools shapes", () => {
    same<API["presets"]["useImporters"], typeof usePresetImporters>();
    same<API["presets"]["describeBag"], typeof describePresetBag>();
    same<API["presets"]["summarize"], typeof summarizePreset>();
    same<ReturnOf<API["presets"]["fields"]>, RealPresetField[]>();
    same<API["presets"]["exportFile"], typeof exportPreset>();
    same<API["presets"]["importFile"], typeof importPresetFile>();
    same<API["presets"]["pickFile"], typeof pickPresetFile>();
    same<API["presets"]["pickerAccept"], typeof presetPickerAccept>();

    same<API["accessibility"]["activate"], typeof activateAccessibility>();
    same<API["accessibility"]["deactivate"], typeof deactivateAccessibility>();
    same<API["accessibility"]["useKeyboardCanvasEditing"], typeof useKeyboardCanvasEditing>();
    same<API["titleBar"]["useOverlay"], typeof useTitleBarOverlay>();

    same<Devtools["devFolder"]["init"], typeof initDevFolder>();
    same<Devtools["devFolder"]["teardown"], typeof teardownDevFolder>();
    same<Devtools["devFolder"]["Controls"], typeof DevFolderControls>();
    same<Devtools["pipeline"]["versions"], readonly RealProcessVersion[]>();
    same<Devtools["pipeline"]["useOpenVersion"], typeof useOpenProcessVersion>();
    same<Devtools["pipeline"]["useRows"], typeof usePipelineRows>();
    same<Devtools["pipeline"]["useScreen"], typeof usePipelineScreen>();
    same<
      Devtools["variables"],
      Pick<VariableRegistry, "inspect" | "subscribeChanges" | "changeCount" | "windowName">
    >();
    same<Devtools["webglInfo"], typeof readWebGLInfo>();
    same<Devtools["appVersion"], typeof readAppVersion>();
    expect(true).toBe(true);
  });

  it("catches a shape that differs", () => {
    // @ts-expect-error -- a Panel is not a Slider
    same<API["components"]["Panel"], typeof Slider>();
    // @ts-expect-error -- assignable one way only
    same<API["stores"]["useSettings"], typeof useSettings & { extra: true }>();
    expect(true).toBe(true);
  });
});
