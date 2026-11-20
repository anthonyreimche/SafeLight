// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The state of the app stores api.stores hands out. Written out here, not
// taken from the stores themselves, so the public shape is its own and the
// API's types import only core's leaf type modules (scoped-api.test.ts keeps
// the two in step).

import type { StoreApi, UseBoundStore } from "zustand";
import type {
  AppModule,
  CatalogPhoto,
  ColorLabel,
  CurvePoint,
  DevelopParams,
  EditSnapshot,
  FlagStatus,
  Mask,
  MaskAdjustments,
  SortDirection,
  SortField,
  StoredPhoto,
  ToneCurveChannel,
  ViewMode,
} from "@/catalog/types";
import type { ColorSpaceId } from "@/rendering/color-space";
import type { HistogramData } from "@/rendering/histogram";
import type { FolderNode } from "@/project/folder-node";

/** A store hook: call it with a selector in a component, or use its
 *  getState / setState / subscribe anywhere. */
export type AppStore<T> = UseBoundStore<StoreApi<T>>;

// ── Develop ──────────────────────────────────────────────────────────────────

/** Clipping overlay bits: 1 shadows, 2 highlights, 4 the gamut warning, which
 *  only version 3 photos show. */
export type ClippingMask = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface DevelopState {
  photoId: string | null;
  params: DevelopParams;
  /** Transient render-only override: when set, the renderer draws these params
   *  instead of `params` without touching history (used for preset hover
   *  preview). Cleared on mouse-out, on apply, and when switching photos. */
  previewParams: DevelopParams | null;
  /** Render-only override for the extension param bag, paired with
   *  `previewParams` for the preset hover preview: the preset's contributed
   *  params merged over the live bag. Null when no preview is active. */
  previewParamBag: Record<string, unknown> | null;
  /** Extension params keyed by qualified names ("{stageId}.{key}"). */
  paramBag: Record<string, unknown>;
  history: EditSnapshot[];
  historyIndex: number;
  /** Counts jumps to a known look: an undo, redo or history step, a preset applied,
   *  a reset, the processing update. Bumped in the same update as that look, so a
   *  view can ease into it where a live write (a drag, a mask stroke) cuts. */
  discreteEdits: number;
  histogram: HistogramData | null;
  asShotTemperature: number;
  /** Size of the source the last frame was drawn from, as the renderer holds it
   *  (already upright, after the upload cap). Derive an image aspect from this,
   *  not photo.width/height. `fullWidth`/`fullHeight` are the decoded frame's
   *  size before the cap, and `native` is true while a native-resolution sample
   *  is held for the source (the one api.develop.readSourceSample answers).
   *  {0,0} and false until a frame of the photo is drawn. */
  sourceSize: { width: number; height: number; fullWidth: number; fullHeight: number; native: boolean };
  /** Why the open photo's stored edit couldn't be read, or null. While set, the
   *  photo is open with no history, and its changes, undo and redo are not saved.
   *  Cleared by opening the photo again, or another one, successfully. */
  editError: string | null;

  setHistogram: (histogram: HistogramData | null) => void;
  setSourceSize: (width: number, height: number, full?: { width: number; height: number; native: boolean }) => void;
  /** Open a photo's stored edit. A change still uncommitted on the photo being
   *  left is committed to that photo first. */
  loadEdit: (photoId: string, asShotTemperature?: number) => Promise<void>;
  /** Take on the open photo's edit as the catalogue now holds it, after another
   *  window changed it. */
  reloadEdit: () => Promise<void>;
  setParam: <K extends keyof DevelopParams>(
    key: K,
    value: DevelopParams[K],
  ) => void;
  /** Set a dynamic parameter by qualified key (e.g. "core.exposure.exposure"). */
  setDynParam: (key: string, value: unknown) => void;
  /** Set multiple dynamic parameters at once. */
  setDynParams: (patch: Record<string, unknown>) => void;
  setToneCurve: (channel: ToneCurveChannel, points: CurvePoint[]) => void;
  /** Replace the live params wholesale (merge a partial preset over the current
   *  params first) and merge the preset's bag over the live one, committed as
   *  one undoable edit. The photo keeps its own process version. */
  applyPreset: (
    params: DevelopParams,
    paramBag?: Record<string, unknown>,
  ) => Promise<void>;
  /** Set (or clear with null) the render-only preview params, optionally with a
   *  preset's bag. No history write, no broadcast. */
  setPreviewParams: (
    params: Partial<DevelopParams> | null,
    paramBag?: Record<string, unknown> | null,
  ) => void;
  commitEdit: (label: string) => Promise<void>;
  /** Reset just the given top-level param keys to their defaults (temperature
   *  falls back to the photo's as-shot WB), as one undoable edit. */
  resetParams: (keys: (keyof DevelopParams)[], label: string) => Promise<void>;
  undo: () => void;
  redo: () => void;
  /** Show the open photo's history at step `index` as one move, the way undo
   *  and redo show the step before or after: stored, and announced to other
   *  windows and extensions once. Does nothing for the step shown, an index
   *  outside `history` or not a whole number, or while `editError` is set.
   *  Safelight 3.2.5 and later. */
  goToHistory: (index: number) => void;
  /** Put the open photo's edit back to `edit` exactly, as one undoable step
   *  named `label`: its settings, the process version it was made at and only
   *  the extension values it holds. Settings an older edit lacks take their
   *  defaults. Does nothing with no photo open, while `editError` is set, or
   *  when the photo already shows `edit`. Safelight 3.2.6 and later. */
  restoreEdit: (edit: Pick<EditSnapshot, "params" | "paramBag">, label: string) => Promise<void>;
  reset: () => Promise<void>;
  /** Move the open photo from the older processing to the current one, as one
   *  undoable step that keeps every other setting. */
  updateProcessing: () => Promise<void>;
  canUndo: () => boolean;
  canRedo: () => boolean;

  /** Panels whose preview-off eye is held now, by panel id: the live view
   *  leaves a held panel's contribution out without touching the edit. Read it
   *  to leave a held-off effect out of a preview you render yourself; change it
   *  only through setPanelBypass. Never persisted. */
  readonly bypassedPanels: Readonly<Record<string, boolean>>;
  setPanelBypass: (panelId: string, on: boolean) => void;
  togglePanelBypass: (panelId: string) => void;
  showClipping: ClippingMask;
  setShowClipping: (mode: ClippingMask) => void;
  toggleClipping: () => void;
  /** Soft proof of the export colour space, on photos that have one (version 3). */
  proof: boolean;
  toggleProof: () => void;
  /** ISO 12646 colour assessment: the image framed in white on a middle-grey
   *  surround. */
  colorAssessment: boolean;
  toggleColorAssessment: () => void;

  /** Sharpening preview while Alt/Ctrl-dragging a sharpening slider: 0 off,
   *  1 masking, 2 detail, 3 luminance. */
  sharpenViz: number;
  setSharpenViz: (mode: number) => void;
  /** Mask value edits. They write params but don't commit: commitEdit ends a
   *  gesture for undo. */
  updateMask: (id: string, patch: Partial<Mask>) => void;
  updateMaskAdj: (id: string, patch: Partial<MaskAdjustments>) => void;
  /** Merge into the mask's extension-param bag; undefined values delete keys. */
  updateMaskBag: (id: string, patch: Record<string, unknown>) => void;
  /** Apply a mask sub-panel's `owns` list: seed writes each owned value's
   *  default, clear zeroes the adjustments and strips blocks and bag keys. */
  seedMaskPanelValues: (maskId: string, owns: readonly string[]) => void;
  clearMaskPanelValues: (maskId: string, owns: readonly string[]) => void;
}

// ── Catalogue ──────────────────────────────────────────────────────────────────

/** A grid preview as a loader returns it, with the edit it shows. */
export type LoadedPreview = Blob & { readonly previewEdit?: string };

/** What a background rebuild of a photo changed (see mergeRebuiltPhoto). */
export type RebuiltChange = Partial<
  Pick<
    CatalogPhoto,
    | "thumbnailBlob"
    | "thumbnailUrl"
    | "previewEdit"
    | "width"
    | "height"
    | "rotation"
    | "exif"
    | "decodeError"
    | "fileSize"
    | "mimeType"
    | "dateCreated"
    | "metadataPending"
  >
>;

export interface CatalogState {
  photos: CatalogPhoto[];
  selectedIds: Set<string>;
  activePhotoId: string | null;
  loading: boolean;
  /** Bumped after re-granting file permission, to reload bitmaps. */
  fileAccessNonce: number;
  /** The last project needs a permission re-grant. */
  needsReconnect: boolean;
  /** A permission re-grant is in progress. */
  reconnecting: boolean;

  loadCatalog: () => Promise<void>;
  reconnectFiles: () => Promise<void>;
  /** Swap in a freshly opened project's photos. */
  replaceCatalog: (photos: CatalogPhoto[]) => void;
  /** Append photos during a progressive open. */
  appendPhotos: (photos: CatalogPhoto[]) => void;
  /** Add new photo records and durably persist them, optionally each right
   *  after a given photo (api.catalog.addPhotos). */
  addPhotos: (
    photos: CatalogPhoto[],
    opts?: { afterId?: string },
  ) => Promise<void>;
  /** Finalize a progressive open with the authoritative list. */
  finalizeCatalog: (photos: CatalogPhoto[]) => void;
  /** Attach freshly read grid previews; returns the ids that took one. */
  mergeThumbnails: (updates: { id: string; blob: LoadedPreview }[]) => string[];
  /** Replace one photo record in place (same id). Persistence is the caller's job. */
  updatePhoto: (photo: CatalogPhoto) => void;
  /** Take only the fields in `change` onto the photo as the store holds it now. */
  mergeRebuiltPhoto: (id: string, change: RebuiltChange) => void;
  /** Replace one photo's preview blob in place. */
  replaceThumbnail: (id: string, blob: LoadedPreview) => void;
  /** Let go of previews the loader read; returns the ids let go. */
  dropThumbnails: (entries: { id: string; blob: LoadedPreview }[]) => string[];
  /** Take on what another window wrote to the catalogue. */
  mergeRemoteRecords: (photos: StoredPhoto[], deletedIds: string[]) => void;
  /** Replace the skeleton catalogue with the post-scan list. */
  reconcileCatalog: (photos: CatalogPhoto[]) => void;

  removePhoto: (id: string) => Promise<void>;
  removePhotos: (ids: string[]) => Promise<void>;
  /** Persist already-built photo records and show them (photos moved or
   *  renamed on disk, or metadata an extension changed). Build each from the
   *  photo as the store holds it right before the call. */
  relocatePhotos: (updated: CatalogPhoto[]) => Promise<void>;
  /** Set a virtual copy's display name. Display-only. */
  setCopyName: (id: string, copyName: string) => Promise<void>;

  /** Put the photos in one new stack, `opts.cover` as its cover. */
  setStack: (ids: string[], opts?: { cover?: string }) => Promise<void>;
  /** Take the photos out of their stacks. */
  clearStack: (ids: string[]) => Promise<void>;
  /** Store an input profile token on the photos, or with null clear it. Call
   *  api.catalog.setInputProfile instead: it checks that you hold the
   *  resolver, and draws edited thumbnails again. Needs Safelight 3.2.3. */
  setInputProfile: (ids: string[], token: string | null) => Promise<void>;

  setRating: (id: string, rating: number) => Promise<void>;
  setColorLabel: (id: string, label: ColorLabel) => Promise<void>;
  setFlag: (id: string, flag: FlagStatus) => Promise<void>;

  applyRating: (ids: string[], rating: number) => Promise<void>;
  applyColorLabel: (ids: string[], label: ColorLabel) => Promise<void>;
  applyFlag: (ids: string[], flag: FlagStatus) => Promise<void>;
  rotatePhotos: (ids: string[], deg: number) => Promise<void>;
  /** Degrees each tile is shown turned while its turned preview is still being made. */
  pendingRotation: Record<string, number>;

  addKeyword: (id: string, keyword: string) => Promise<void>;
  removeKeyword: (id: string, keyword: string) => Promise<void>;
  addKeywords: (ids: string[], keywords: string[]) => Promise<void>;
  removeKeywords: (ids: string[], keywords: string[]) => Promise<void>;

  select: (id: string) => void;
  selectRange: (id: string, orderedIds?: string[]) => void;
  toggleSelect: (id: string) => void;
  /** Select the given ids, or every photo in the catalogue when none are given. */
  selectAll: (ids?: string[]) => void;
  deselectAll: () => void;
  setActivePhoto: (id: string | null, options?: { broadcast?: boolean }) => void;
}

// ── UI ───────────────────────────────────────────────────────────────────────

export type FlagFilter = "any" | "pick" | "reject";
export type LabelFilter = "any" | ColorLabel;
export type RatingOp = "lt" | "lte" | "gt" | "gte" | "eq" | "neq";
export type EditedFilter = "any" | "edited" | "unedited";

export interface LibraryFilter {
  /** Stars threshold, compared via ratingOp. */
  rating: number;
  ratingOp: RatingOp;
  flag: FlagFilter;
  label: LabelFilter;
  /** A photo must carry all of these. */
  keywords: string[];
  /** Only photos with an edit, or only those without (never edited, or every
   *  step undone). */
  edited: EditedFilter;
}

export interface UIState {
  activeModule: AppModule;
  setActiveModule: (module: AppModule) => void;

  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;

  /** A built-in SortField or an extension-contributed sort id. */
  sortField: string;
  sortDirection: SortDirection;
  setSort: (field: string, direction: SortDirection) => void;

  filter: LibraryFilter;
  setFilter: (patch: Partial<LibraryFilter>) => void;
  clearFilters: () => void;

  /** Project folder filter: relative path ("" = whole project), null = all. */
  activeFolder: string | null;
  setActiveFolder: (path: string | null) => void;

  /** The stacks shown expanded, by stackId; per session, a stack opens collapsed. */
  expandedStacks: ReadonlySet<string>;
  toggleStack: (stackId: string) => void;

  gridSize: number;
  setGridSize: (size: number) => void;
  stepGridSize: (direction: 1 | -1) => void;

  /** Live column count of the Library grid; 1 in list view. */
  gridColumns: number;
  setGridColumns: (n: number) => void;

  /** Modules popped out into their own windows (main-window view). */
  detached: Set<AppModule>;
  markDetached: (module: AppModule) => void;
  markAttached: (module: AppModule) => void;
}

// ── Preferences ──────────────────────────────────────────────────────────────

export type ExportFormatPref = "image/jpeg" | "image/png" | "image/webp" | "image/tiff";
/** How grid previews are built for RAW files on import: the embedded camera
 *  JPEG when it is big enough ("auto"), always the embedded JPEG, or always a
 *  render of the sensor. */
export type PreviewSource = "auto" | "embedded" | "rendered";
/** Per-theme custom UI colour overrides: theme id → (CSS custom property → hex). */
export type ColorOverrides = Record<string, Record<string, string>>;
/** Colour-vision simulation over the whole window. "none" = off. */
export type ColorVisionFilter =
  | "none"
  | "protanopia"
  | "deuteranopia"
  | "tritanopia";
/** Which releases the update check notifies of: full releases only, or
 *  pre-releases too. */
export type UpdateChannel = "stable" | "all";

export interface ExportPreset {
  name: string;
  format: ExportFormatPref;
  quality: number;
  longEdge: number | null;
  colorSpace: ColorSpaceId;
  sharpenAmount: number;
  sharpenRadius: number;
  /** Bits per sample for TIFF export (8 or 16); absent on older presets. */
  tiffBitDepth?: 8 | 16;
  /** Bits per sample for PNG export (8 or 16); absent on older presets. */
  pngBitDepth?: 8 | 16;
}

/** The app's Preferences. Read them with useSettings, write them with
 *  api.appSettings.update. */
export interface AppSettings {
  // Interface
  /** Whole-UI zoom (0.8–2.0). */
  uiScale: number;
  reduceMotion: boolean;
  /** UI font as a CSS font-family; "" = the built-in stack. */
  uiFont: string;
  /** Use the fixed `canvasSurround` shade behind the image in Develop, not the
   *  theme's surface. */
  canvasSurroundOverride: boolean;
  canvasSurround: string;
  /** Width of the colour-assessment mat, as a percentage of the smaller
   *  viewport dimension. */
  assessBorderPct: number;
  /** How much the app behind a window-style pop-up is dimmed, 0–0.8. */
  windowDim: number;
  /** Clicking a slider jumps its value to the cursor. */
  sliderJumpToCursor: boolean;
  /** The plain wheel over a closed dropdown picks the previous or next option;
   *  off, only Shift+wheel does. */
  dropdownWheelSelect: boolean;
  /** Collapsing a dock panel writes into the picked saved layout. */
  autoSaveCollapsedPanels: boolean;

  // Accessibility
  highContrast: boolean;
  strongFocus: boolean;
  colorVisionFilter: ColorVisionFilter;
  largerText: boolean;
  largerControls: boolean;
  lowercaseHeadings: boolean;
  reduceTransparency: boolean;
  /** Also follow the OS's own accessibility preferences. */
  syncOSAccessibility: boolean;
  /** On-canvas keyboard editing for direct-manipulation tools. */
  keyboardCanvasEditing: boolean;
  colorOverrides: ColorOverrides;
  /** Draw the selection and focus rings in the canvas editors. */
  editingHighlights: boolean;

  // Startup
  restoreLastProject: boolean;

  // Library
  /** Pixels, 120–360. */
  defaultGridSize: number;
  defaultSortField: SortField;
  defaultSortDirection: SortDirection;
  confirmRemovePhotos: boolean;
  showSubfolderPhotos: boolean;
  /** Show each photo's file type (NEF, JPG) on its grid and Filmstrip thumbnail. */
  thumbnailFileType: boolean;
  /** Mark the grid and Filmstrip thumbnails of photos with an edit. */
  thumbnailEdited: boolean;

  // Previews
  previewSource: PreviewSource;
  thumbMaxEdge: 320 | 640 | 960;
  persistPreviews: boolean;
  /** Each format's decoders in the order they're tried, by format id ("jpeg",
   *  "heif", a RAW format's extension such as "nef"): Preferences ▸ File
   *  formats. A format left out tries Safelight's own decoder first. Since
   *  3.2.6. */
  decoderOrder: Record<string, string[]>;
  /** Where a project's .safelight working folder lives: beside the photos, or
   *  under externalCatalogDir. */
  catalogLocation: "in-folder" | "external";
  /** "" = the app's own data directory. */
  externalCatalogDir: string;

  // Develop cache
  rawCacheEnabled: boolean;
  rawCachePrefetch: boolean;
  rawCacheMaxEdge: 2048 | 3072 | 4096;

  // Render pipeline
  developMaxEdge: 2560 | 3072 | 4096 | 6144 | 8192;
  /** Sharpen the visible area from the original when zoomed past the render buffer. */
  developDynamicDetail: boolean;
  /** GPU memory budget (bytes) for resident decoded RAW sources. */
  gpuSourceCacheBytes: number;
  developPrefetchNeighbors: boolean;
  highBitDepth: boolean;
  liveHistogram: boolean;
  developOpenZoom: "fit" | "100";
  /** The monitor's ICC profile the Develop view converts to (Linux); "" = none. */
  displayProfilePath: string;

  // Export defaults
  exportFormat: ExportFormatPref;
  /** 1–100. */
  exportQuality: number;
  /** null = original size. */
  exportLongEdge: number | null;
  exportBundle: boolean;
  exportColorSpace: ColorSpaceId;
  exportTiffBitDepth: 8 | 16;
  exportPngBitDepth: 8 | 16;
  exportIncludeMetadata: boolean;
  exportIncludeLocation: boolean;
  exportIfExists: "number" | "replace";
  exportPresets: ExportPreset[];

  // Shortcuts
  singleKeyShortcuts: boolean;

  // Extensions
  extensionTopic: string;
  checkExtensionUpdates: boolean;
  autoUpdateExtensions: boolean;
  onlyVerifiedExtensions: boolean;
  extensionsMaximized: boolean;
  preferencesMaximized: boolean;

  // Updates
  checkForUpdates: boolean;
  updateChannel: UpdateChannel;
}

// ── Project ──────────────────────────────────────────────────────────────────

/** A folder the OS asked Safelight to open (a file manager's "Open with", a
 *  folder dropped on the app), and the photo in it to select. */
export interface NativeOpenTarget {
  /** Absolute path of the folder to open as the project. */
  folder: string;
  /** File name of the photo to select in it; null when a folder was given. */
  file: string | null;
}

export interface RecentProject {
  /** Stable key: absolute path (desktop) or folder name (browser). */
  id: string;
  name: string;
  /** Absolute path on the desktop, null in the browser. */
  path: string | null;
  /** Directory handle in the browser, null on the desktop. */
  handle: FileSystemDirectoryHandle | null;
  openedAt: number;
  /** The welcome card's cover. */
  cover: Blob | null;
}

export interface ProjectState {
  root: FileSystemDirectoryHandle | null;
  name: string;
  tree: FolderNode | null;
  opening: boolean;
  /** The folder being opened, while `opening`. */
  openingName: string;
  /** New-file import progress; importTotal is 0 when not importing. */
  importDone: number;
  importTotal: number;

  /** Blocking message shown when opening a folder failed; null = no error. */
  openError: string | null;
  /** Whether openError is about a folder Safelight can't write to. */
  openErrorReadOnly: boolean;
  /** The recent project whose folder openError says is unavailable; null otherwise. */
  openErrorRecentId: string | null;
  /** Bumped when the recent projects list changes, so a view can re-read it. */
  recentsRevision: number;
  /** Removes openErrorRecentId from the recent projects and dismisses openError. */
  removeFailedRecent: () => Promise<void>;
  /** Notice that a read-only folder's catalogue was redirected elsewhere. */
  storageNotice: string | null;
  /** Why the last catalogue save failed, while saves keep failing; null = saved. */
  saveError: string | null;
  dismissOpenError: () => void;
  dismissStorageNotice: () => void;

  /** Folder picker → open as project. Must run within a user gesture. */
  openProjectPicker: () => Promise<void>;
  openProject: (handle: FileSystemDirectoryHandle) => Promise<void>;
  openRecent: (entry: RecentProject) => Promise<void>;
  openLast: () => Promise<void>;
  openFromOs: (target: NativeOpenTarget) => Promise<void>;
  reconnectLast: () => Promise<boolean>;
  /** Cancel an in-progress import; imported photos are kept. */
  stopImport: () => void;
  /** Close the project and return to the welcome screen. */
  closeProject: () => void;
  /** Re-walk the open folder's directories and refresh the tree. */
  refreshTree: () => Promise<void>;
}

/** The id of the active theme, layout or display transform. */
export interface ActiveIdState {
  activeId: string;
}
