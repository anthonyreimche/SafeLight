// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { create } from "zustand";
import type {
  CurvePoint,
  DevelopParams,
  EditSnapshot,
  EditState,
  Mask,
  ToneCurveChannel,
} from "@/catalog/types";
import {
  CURRENT_PROCESS_VERSION,
  DEFAULT_DEVELOP_PARAMS,
  NEUTRAL_TEMPERATURE_K,
  UPDATE_PROCESSING_LABEL,
  assignDevelopParam,
  freshParams,
  normalizeParams,
  usesOlderProcessing,
} from "@/catalog/types";

import type { HistogramData } from "@/rendering/histogram";
import { catalogStorage, type CatalogStorage } from "@/catalog/storage";
import { historyCursor } from "@/catalog/history-cursor";
import { same, sameEdit } from "@/catalog/edit-equality";
import { writeInTurn, writePending } from "@/catalog/edit-writes";
import { fsErrorText } from "@/project/fs-errors";
import { broadcast } from "./broadcast";
import { createViewSlice, type ViewSlice } from "./develop-slices/view-slice";
import { createMaskSlice, type MaskSlice } from "./develop-slices/mask-slice";
import { emitEditCommit } from "@/extensions/registry";
import { normalizeParamBag } from "@/extensions/param-registry";
import { photoById, useCatalogStore } from "./catalog-store";
import { regenerateEditedThumbnail, type LeftPhoto } from "./edited-thumbnail";
import { getRenderBridge } from "@/rendering/render-bridge";

export interface DevelopState extends ViewSlice, MaskSlice {
  photoId: string | null;
  params: DevelopParams;
  /** Transient render-only override: when set, the renderer draws these params
   *  instead of `params` without touching history (used for preset hover
   *  preview). Cleared on mouse-out, on apply, and when switching photos. */
  previewParams: DevelopParams | null;
  /** Render-only override for the extension param bag, paired with
   *  `previewParams` for the preset hover preview. Holds the preset's
   *  contributed params merged over the live bag, so a partial preset previews
   *  its extension adjustments (e.g. a film sim) without dropping untouched
   *  ones. Null when no preview is active; cleared whenever previewParams is. */
  previewParamBag: Record<string, unknown> | null;
  /** Dynamic parameter bag keyed by qualified names (e.g. "core.exposure.exposure").
   *  During migration, kept in sync with `params` via a bidirectional bridge.
   *  Will become the sole representation once all stages are extracted. */
  paramBag: Record<string, unknown>;
  history: EditSnapshot[];
  historyIndex: number;
  histogram: HistogramData | null;
  asShotTemperature: number;
  /** Size of the source the last frame was drawn from, as the renderer holds it
   *  (already upright, after the upload cap), published by every frame, the camera
   *  preview's included. Panels derive imageAspect from this, not photo.width/height,
   *  so aspect-locked crops / Upright match the pixels on screen when a decode path
   *  transposes stored metadata. `fullWidth`/`fullHeight` are the decoded frame's
   *  size before the cap, and `native` is true while a native-resolution sample is
   *  held for the source (the one api.develop.readSourceSample answers): the live
   *  float decode, or a cached preview stored with one (3.1.0 and later); false
   *  for the camera preview, a stored preview, bitmaps and cache entries written
   *  before. {0,0} and false until a frame of the photo is drawn. */
  sourceSize: { width: number; height: number; fullWidth: number; fullHeight: number; native: boolean };
  /** Why the open photo's stored edit couldn't be read, or null. While set, the
   *  photo is open with no history: its changes, undo and redo are not saved, so
   *  nothing is written over an edit that was never seen. Cleared by opening the
   *  photo again, or another one, successfully. */
  editError: string | null;

  // Canvas-view overlays and picker modes live in ViewSlice
  // (develop-slices/view-slice.ts).

  // Mask value edits live in MaskSlice
  // (develop-slices/mask-slice.ts).

  setHistogram: (histogram: HistogramData | null) => void;
  setSourceSize: (width: number, height: number, full?: { width: number; height: number; native: boolean }) => void;
  /** Open a photo's stored edit. A change still uncommitted on the photo being
   *  left is committed to that photo first. When another photo is opened before
   *  this one's edit is read, this one is dropped; a read that fails opens the
   *  photo as one that can't be edited (`editError`). */
  loadEdit: (photoId: string, asShotTemperature?: number) => Promise<void>;
  /** Take on the open photo's edit as the catalogue now holds it, after another
   *  window changed it. A change still being made (a slider mid-drag) isn't
   *  discarded: its commit lands on top of the stored history instead. */
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
  /** Replace the live params wholesale (the caller merges a partial preset over
   *  the current params first) and merge the preset's contributed bag over the
   *  live one, committed as one undoable edit. Full params only — a partial
   *  would silently reset every omitted core adjustment to its default. The
   *  photo keeps its own process version, whatever `params` carries. */
  applyPreset: (
    params: DevelopParams,
    paramBag?: Record<string, unknown>,
  ) => Promise<void>;
  /** Set (or clear with null) the render-only preview params, optionally with a
   *  preset's contributed param bag (previewed by merging over the live bag). No
   *  history write, no broadcast — purely local to the Develop canvas. The
   *  preview is at the open photo's process version, whatever `params` carries. */
  setPreviewParams: (
    params: Partial<DevelopParams> | null,
    paramBag?: Record<string, unknown> | null,
  ) => void;
  commitEdit: (label: string) => Promise<void>;
  /** Reset just the given top-level param keys to their defaults (temperature
   *  falls back to the photo's as-shot WB), as one undoable edit. Backs the
   *  per-panel "Reset to defaults" header action. */
  resetParams: (keys: (keyof DevelopParams)[], label: string) => Promise<void>;
  undo: () => void;
  redo: () => void;
  reset: () => Promise<void>;
  /** Move the open photo from the older processing to the current one, as one
   *  undoable step that keeps every other setting. Does nothing with no photo
   *  open or on a photo that is already current. With reset(), the only store
   *  actions that change a photo's process version; the Library's bulk update
   *  (catalog/update-processing) writes the stored edit directly. */
  updateProcessing: () => Promise<void>;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

// Step the history cursor (undo = -1, redo = +1), broadcast the restored
// params, and persist the new cursor — without persisting, switching photos
// (or another window) snapped the stack back to the last commit, which made
// redo/undo positions silently vanish. Restoring a snapshot is a look change
// like a commit, so it also refreshes the grid thumbnail and re-emits the
// edit to extensions (else the Library thumbnail and any XMP sidecar stay at
// the pre-undo look while the stored cursor points elsewhere).
function moveHistory(
  get: () => DevelopState,
  set: (p: Partial<DevelopState>) => void,
  dir: -1 | 1,
): void {
  const { photoId, history, historyIndex, asShotTemperature, editError } = get();
  const newIndex = historyIndex + dir;
  if (editError || newIndex < 0 || newIndex > history.length - 1) return;
  const look = lookOf(history[newIndex], get());
  set({ historyIndex: newIndex, ...look });
  broadcast({ type: "edit-update", payload: { photoId } });
  if (!photoId) return;

  // Its writes go to the catalogue open now, or nowhere: not to one opened since.
  const storage = catalogStorage();
  const store = (editState: EditState, look = lookOf(editState.stack[editState.currentIndex])) => {
    void storage.putEditState(editState);
    const photo = photoById(useCatalogStore.getState().photos, photoId);
    if (photo) void emitEditCommit({ photo, editState });
    // Steps taken in a row (a held Ctrl+Z) draw one thumbnail, once the view rests.
    refreshThumbnailWhenQuiet(photoId, look.params, asShotTemperature, look.paramBag);
  };

  // With none of this photo's writes under way, the history held here is the
  // catalogue's: each change another window makes renews it (see reloadEdit).
  if (!writePending(photoId)) {
    store({ photoId, stack: history, currentIndex: newIndex }, look);
    return;
  }
  void writeInTurn(photoId, async (latest) => {
    const base = (await storedHistory(photoId, asShotTemperature, storage)) ?? { stack: history, index: historyIndex };
    if (catalogStorage() !== storage) return;
    const held = base.stack === history && base.index === historyIndex;
    // The catalogue holds steps this history hasn't seen: step its cursor instead.
    const index = held ? newIndex : base.index + dir;
    const steppable = index >= 0 && index <= base.stack.length - 1;
    if (!held && latest() && get().photoId === photoId) {
      // No step to take in the catalogue's history: show it as it is, rather
      // than the step taken here that was never saved.
      const look = lookOf(base.stack[steppable ? index : base.index], get());
      set({ history: base.stack, historyIndex: steppable ? index : base.index, ...look });
      broadcast({ type: "edit-update", payload: { photoId } });
    }
    if (steppable) store({ photoId, stack: base.stack, currentIndex: index });
  });
}

// Normalize on the way out, not just at load: a stack read from disk carries
// snapshots written before newer params existed, and stepping into one must
// fill today's defaults rather than hand the renderer a half-shaped object.
//
// With `live` (the look on screen, for a step on the same photo) every field and
// mask that matches it stays the live object, so the renderer sees only what the
// step changed: its sync diffs by identity, and a new masks array re-bakes them all.
function lookOf(snapshot: EditSnapshot, live?: Look): Look {
  const params = normalizeParams(snapshot.params);
  const paramBag = normalizeParamBag(snapshot.paramBag);
  if (!live) return { params, paramBag };
  const kept = keepEqual(params, live.params);
  kept.masks = keepMasks(params.masks, live.params.masks);
  return { params: kept, paramBag: keepEqual(paramBag, live.paramBag) };
}

type Look = Pick<DevelopState, "params" | "paramBag">;

/** `next` with each top-level value that `live` holds an equal one of replaced by
 *  `live`'s. */
function keepEqual<T extends object>(next: T, live: T): T {
  const out = { ...next };
  for (const key in next) if (Object.hasOwn(live, key) && same(next[key], live[key])) out[key] = live[key];
  return out;
}

/** `next` masks with each one `live` holds an equal mask of (by id) replaced by it,
 *  and the array itself kept when nothing in it or its order changed. */
function keepMasks(next: Mask[], live: Mask[]): Mask[] {
  const held = new Map(live.map((m) => [m.id, m]));
  const masks = next.map((m) => {
    const prev = held.get(m.id);
    return prev && same(m, prev) ? prev : m;
  });
  return masks.length === live.length && masks.every((m, i) => m === live[i]) ? live : masks;
}

interface OpenedHistory {
  stack: EditSnapshot[];
  index: number;
}

/** A stored edit as Develop opens it, or null for a photo never edited. */
function openedHistory(editState: EditState | undefined, asShot: number): OpenedHistory | null {
  if (!editState || editState.stack.length === 0) return null;
  // Stacks lacking the seeded "Original" snapshot (older ones, or one an
  // extension wrote) get one prepended so the first real edit is always
  // undoable. It belongs to that stack, so it takes the stack's version
  // (normalizeParams reads no version as 1), not freshParams's current one.
  const stack = editState.stack;
  // The stored cursor may be unusable; resolve it so the photo opens on a
  // real snapshot instead of throwing on an undefined one.
  const index = historyCursor(editState.currentIndex, stack.length);
  if (stack[0].label === "Original") return { stack, index };
  const original: EditSnapshot = {
    timestamp: stack[0].timestamp,
    label: "Original",
    params: normalizeParams({
      temperature: asShot,
      processVersion: stack[0].params?.processVersion,
    }),
    paramBag: {},
  };
  return { stack: [original, ...stack], index: index + 1 };
}

async function storedHistory(
  photoId: string,
  asShot: number,
  storage: CatalogStorage = catalogStorage(),
): Promise<OpenedHistory | null> {
  return openedHistory(await storage.getEditState(photoId), asShot);
}

/** True when the live params or bag differ from the history entry at the
 *  cursor: a change made but not yet committed. The raw compare matches an entry
 *  this version wrote, stored or not; right after a commit it is cheap too, as
 *  the entry still shares nested objects with the live params. A stack written
 *  by an older build only matches once normalized. */
function hasUncommittedEdit(
  s: Pick<DevelopState, "params" | "paramBag" | "history" | "historyIndex">,
): boolean {
  const entry = s.history[s.historyIndex];
  if (!entry) return true;
  const current = { params: s.params, paramBag: s.paramBag };
  return !(
    sameEdit(current, { params: entry.params, paramBag: entry.paramBag ?? {} }) ||
    sameEdit(current, {
      params: normalizeParams(entry.params),
      paramBag: normalizeParamBag(entry.paramBag),
    })
  );
}

const leaveHandlers = new Set<() => void>();

// Counts the photos opened, so a read that answers after a later open began
// is dropped instead of binding its photo's history over the later one.
let loadGen = 0;
// The photo the newest open is reading, until that read answers.
let loadTarget: string | null = null;

/** Whether Develop is still opening a photo other than the one it holds. A
 *  reload of the held photo then would cancel that open, leaving Develop bound
 *  to the photo the user has left. */
export function openingAnotherPhoto(): boolean {
  return loadTarget !== null && loadTarget !== useDevelopStore.getState().photoId;
}

/** Whether Develop already holds this photo's edit as a fresh load would set it:
 *  no read under way, none failed, and the same as-shot white balance. Opening
 *  such a photo again would only replace the objects every panel reads. */
export function holdsEdit(photoId: string, asShotTemperature?: number): boolean {
  const s = useDevelopStore.getState();
  return (
    loadTarget === null &&
    s.photoId === photoId &&
    s.editError === null &&
    s.asShotTemperature === (asShotTemperature ?? NEUTRAL_TEMPERATURE_K)
  );
}

/** Run `handler` as Develop leaves the open photo, before the change still
 *  uncommitted there is committed to it, so a run that mustn't be saved half
 *  done can put its values back first. Returns the unsubscribe. */
export function beforePhotoLeave(handler: () => void): () => void {
  leaveHandlers.add(handler);
  return () => leaveHandlers.delete(handler);
}

// How long the live view must go without a render request before a photo's grid
// thumbnail is drawn: that render shares the worker with the live view, so it
// must not land mid-drag. Under continuous rendering it is drawn anyway at the cap.
const THUMBNAIL_QUIET_MS = 300;
const THUMBNAIL_MAX_WAIT_MS = 3000;

// The commit's own re-render is requested after it returns, so the bridge's last
// request can predate the commit: the wait starts with a quiet period of its own.
function whenViewQuiet(signal: AbortSignal): Promise<void> {
  const settled = new Promise<void>((resolve) => setTimeout(resolve, THUMBNAIL_QUIET_MS));
  return settled.then(() => {
    if (signal.aborted) return undefined;
    try {
      return getRenderBridge().whenRenderQuiet(THUMBNAIL_QUIET_MS, signal);
    } catch {
      return undefined;
    }
  });
}

interface QuietThumbnail {
  cancel: () => void;
  params: DevelopParams;
  asShotTemperature: number;
  paramBag: Record<string, unknown>;
}

// The commits whose thumbnail waits, by photo: a photo left or a project closed
// draws its own at once, and one photo's wait never takes another's.
const quietThumbnails = new Map<string, QuietThumbnail>();

function refreshThumbnailWhenQuiet(
  photoId: string,
  params: DevelopParams,
  asShotTemperature: number,
  paramBag: Record<string, unknown>,
): void {
  quietThumbnails.get(photoId)?.cancel();
  let over = false;
  const polling = new AbortController();
  const cap = setTimeout(() => draw(), THUMBNAIL_MAX_WAIT_MS);
  const cancel = () => {
    over = true;
    clearTimeout(cap);
    polling.abort();
  };
  const draw = () => {
    if (over) return;
    cancel();
    void flushThumbnail(photoId);
  };
  quietThumbnails.set(photoId, { cancel, params, asShotTemperature, paramBag });
  void whenViewQuiet(polling.signal).then(draw);
}

/** A photo's stored look changed under its waiting thumbnail (another window,
 *  an extension, a bulk update): the wait goes on, and draws the newer look. */
function renewWaitingThumbnail(
  photoId: string,
  params: DevelopParams,
  asShotTemperature: number,
  paramBag: Record<string, unknown>,
): void {
  const waiting = quietThumbnails.get(photoId);
  if (waiting) Object.assign(waiting, { params, asShotTemperature, paramBag });
}

/** Draw the thumbnail a photo's last commit left waiting. Resolves with nothing
 *  waiting. */
function flushThumbnail(photoId: string, leaving?: LeftPhoto): Promise<void> {
  const waiting = quietThumbnails.get(photoId);
  if (!waiting) return Promise.resolve();
  waiting.cancel();
  quietThumbnails.delete(photoId);
  return regenerateEditedThumbnail(
    photoId,
    waiting.params,
    waiting.asShotTemperature,
    waiting.paramBag,
    leaving,
  );
}

/** Stop a photo's wait: a thumbnail drawn from a newer look takes its place. */
function dropWaitingThumbnail(photoId: string): void {
  const waiting = quietThumbnails.get(photoId);
  if (!waiting) return;
  waiting.cancel();
  quietThumbnails.delete(photoId);
}

/** Draw every thumbnail still waiting for its photo's edits to go quiet, as
 *  Develop or the window is left. */
export function flushPendingThumbnails(): void {
  for (const photoId of [...quietThumbnails.keys()]) void flushThumbnail(photoId);
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushPendingThumbnails);
}

// Longest a project's close waits for its last photo's preview.
const LEAVING_THUMBNAIL_MS = 5000;

async function within(ms: number, work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)));
  await Promise.race([work, bound]);
  clearTimeout(timer);
}

/** Commit the live params as a history step and store them in `target`, or in the
 *  catalogue open now, when that is still the one open as the write lands. */
async function commitStoredEdit(
  get: () => DevelopState,
  set: (p: Partial<DevelopState>) => void,
  label: string,
  target?: CatalogStorage,
): Promise<void> {
  const { photoId, params, paramBag, history, historyIndex, asShotTemperature, editError } = get();
  if (!photoId || editError) return;
  // Unless told where, the write goes to the catalogue open now, or nowhere: not to
  // one opened since.
  const storage = target ?? catalogStorage();
  // A commit made as the project is left reaches the hooks with the photo as it
  // stood, though the catalogue store is emptied by the time the write lands.
  const leaving = target && photoById(useCatalogStore.getState().photos, photoId);

  // An unchanged edit costs no step and keeps the redo tail.
  if (!hasUncommittedEdit({ params, paramBag, history, historyIndex })) return;

  const snapshot: EditSnapshot = {
    timestamp: Date.now(),
    label,
    params: { ...params },
    paramBag: { ...paramBag },
  };

  // History shows the step at once; the write below builds on the catalogue.
  const newHistory = [...history.slice(0, historyIndex + 1), snapshot];
  set({ history: newHistory, historyIndex: newHistory.length - 1 });

  const committed = await writeInTurn(photoId, async (latest) => {
    const base = (await storedHistory(photoId, asShotTemperature, storage)) ?? { stack: history, index: historyIndex };
    if (!target && catalogStorage() !== storage) return null;
    const held = base.stack === history && base.index === historyIndex;
    const showStored = (stack: EditSnapshot[], index: number) => {
      if (!held && latest() && get().photoId === photoId) {
        set({ history: stack, historyIndex: index, ...lookOf(stack[index]) });
      }
    };
    // Another window may have stored this very look already.
    if (!held && !hasUncommittedEdit({ params, paramBag, history: base.stack, historyIndex: base.index })) {
      showStored(base.stack, base.index);
      return null;
    }
    const stack = held ? newHistory : [...base.stack.slice(0, base.index + 1), snapshot];
    const editState: EditState = { photoId, stack, currentIndex: stack.length - 1 };
    const saved = storage.putEditState(editState);
    showStored(stack, stack.length - 1);
    // Registered in turn, not after the hooks below: an undo or a later commit
    // that lands while they run then replaces this wait instead of being undone by it.
    if (!target) refreshThumbnailWhenQuiet(photoId, params, asShotTemperature, paramBag);
    return { editState, saved };
  });
  if (!committed) return;
  const { editState } = committed;
  await committed.saved;

  // Let extensions persist the committed edit elsewhere.
  const photo = leaving || photoById(useCatalogStore.getState().photos, photoId);
  if (photo) await emitEditCommit({ photo, editState });

  // Re-render this one photo's grid thumbnail from its committed look (cheap,
  // in-memory, single photo — not the removed folder-wide pump). Fire and
  // forget so the commit stays snappy.
  if (target && leaving) {
    // The catalogue is saved once this commit ends, so the preview is stored first,
    // within a bound a hung render can't outlast.
    dropWaitingThumbnail(photoId);
    await within(
      LEAVING_THUMBNAIL_MS,
      regenerateEditedThumbnail(photoId, params, asShotTemperature, paramBag, { photo: leaving, storage: target }),
    );
  } else if (target) {
    dropWaitingThumbnail(photoId);
    void regenerateEditedThumbnail(photoId, params, asShotTemperature, paramBag);
  }

  // Announce the committed state so the Library refreshes this photo's
  // histogram the moment it's edited — for any visible photo, in any window —
  // instead of waiting on the periodic catalogue poll.
  broadcast({ type: "edit-update", payload: { photoId } });
}

/** Close the open photo as its project is left: the change still uncommitted is
 *  committed to `storage`, the catalogue being left, and Develop is left with no
 *  photo, so nothing of this photo is written to the next project. Null with no
 *  photo open, else the commit's end. */
export function closeOpenPhoto(storage: CatalogStorage): Promise<void> | null {
  const { photoId } = useDevelopStore.getState();
  if (!photoId) return null;
  for (const handler of [...leaveHandlers]) handler();
  // The commit takes the photo's values as this call starts; the reset below
  // follows at once, so a run still going finds no photo to commit to.
  const { getState, setState } = useDevelopStore;
  const left = photoById(useCatalogStore.getState().photos, photoId);
  const rendersOnCommit = !getState().editError && hasUncommittedEdit(getState());
  const committing = commitStoredEdit(getState, setState, "Edit", storage);
  // A thumbnail still waiting for quiet is drawn now, into the catalogue being
  // left, unless the commit draws a newer one.
  let waiting: Promise<void> | undefined;
  if (left && !rendersOnCommit) {
    waiting = within(LEAVING_THUMBNAIL_MS, flushThumbnail(photoId, { photo: left, storage }));
  } else {
    dropWaitingThumbnail(photoId);
  }
  loadGen++;
  loadTarget = null;
  setState({
    photoId: null,
    params: freshParams(),
    paramBag: {},
    previewParams: null,
    previewParamBag: null,
    history: [],
    historyIndex: -1,
    editError: null,
  });
  return waiting ? Promise.all([committing, waiting]).then(() => {}) : committing;
}

export const useDevelopStore = create<DevelopState>()((set, get, store) => ({
  photoId: null,
  params: freshParams(),
  previewParams: null,
  previewParamBag: null,
  paramBag: {},
  history: [],
  historyIndex: -1,
  histogram: null,
  asShotTemperature: NEUTRAL_TEMPERATURE_K,
  sourceSize: { width: 0, height: 0, fullWidth: 0, fullHeight: 0, native: false },
  editError: null,

  ...createViewSlice(set, get, store),

  ...createMaskSlice(set, get, store),

  setHistogram: (histogram) => set({ histogram }),

  setSourceSize: (width, height, full) =>
    set((s) => {
      const next = {
        width,
        height,
        fullWidth: full?.width ?? width,
        fullHeight: full?.height ?? height,
        native: full?.native ?? false,
      };
      const cur = s.sourceSize;
      const same =
        cur.width === next.width &&
        cur.height === next.height &&
        cur.fullWidth === next.fullWidth &&
        cur.fullHeight === next.fullHeight &&
        cur.native === next.native;
      return same ? s : { sourceSize: next };
    }),

  async loadEdit(photoId: string, asShotTemperature?: number) {
    const asShot = asShotTemperature ?? NEUTRAL_TEMPERATURE_K;
    // The commit takes the leaving photo's values now, before the set below.
    const leaving = get().photoId !== photoId;
    if (leaving) for (const handler of [...leaveHandlers]) handler();
    const outgoingId = get().photoId;
    // The photo left draws its thumbnail now, not once its edits go quiet.
    const outgoing = leaving
      ? get()
          .commitEdit("Edit")
          .finally(() => {
            if (outgoingId) void flushThumbnail(outgoingId);
          })
      : undefined;
    const gen = ++loadGen;
    loadTarget = photoId;
    let opened: OpenedHistory | null;
    try {
      opened = await storedHistory(photoId, asShot);
    } catch (error) {
      console.error(`[develop] couldn't read the edit of ${photoId}:`, error);
      if (gen === loadGen) {
        loadTarget = null;
        set({
          photoId,
          asShotTemperature: asShot,
          params: freshParams(asShot),
          paramBag: {},
          previewParams: null,
          previewParamBag: null,
          history: [],
          historyIndex: -1,
          editError: fsErrorText(error, { op: "read", target: "file" }),
        });
      }
      await outgoing;
      return;
    }
    if (gen !== loadGen) {
      await outgoing;
      return;
    }
    loadTarget = null;
    if (opened) {
      const { stack, index } = opened;
      const look = lookOf(stack[index]);
      renewWaitingThumbnail(photoId, look.params, asShot, look.paramBag);
      set({
        photoId,
        asShotTemperature: asShot,
        editError: null,
        ...lookOf(stack[index]),
        previewParams: null,
        previewParamBag: null,
        history: stack,
        historyIndex: index,
      });
    } else {
      // Seed history with the untouched state so undo can return to it.
      // Use the camera's as-shot WB as the default temperature.
      const initial = freshParams(asShot);
      renewWaitingThumbnail(photoId, initial, asShot, {});
      set({
        photoId,
        asShotTemperature: asShot,
        editError: null,
        params: initial,
        paramBag: {},
        previewParams: null,
        previewParamBag: null,
        history: [
          {
            timestamp: Date.now(),
            label: "Original",
            params: initial,
            paramBag: {},
          },
        ],
        historyIndex: 0,
      });
    }
    await outgoing;
  },

  async reloadEdit() {
    const { photoId, asShotTemperature, editError } = get();
    if (!photoId || openingAnotherPhoto()) return;
    if (editError || !hasUncommittedEdit(get())) {
      await get().loadEdit(photoId, asShotTemperature);
      return;
    }
    // The change being made stays; only the history behind it is renewed. A
    // read that fails leaves the history as it is: the next commit reads again.
    const gen = loadGen;
    const opened = await storedHistory(photoId, asShotTemperature).catch(() => null);
    if (opened && gen === loadGen && get().photoId === photoId) {
      const look = lookOf(opened.stack[opened.index]);
      renewWaitingThumbnail(photoId, look.params, asShotTemperature, look.paramBag);
      set({ history: opened.stack, historyIndex: opened.index });
    }
  },

  setParam(key, value) {
    set((s) => ({
      params: { ...s.params, [key]: value },
    }));
  },

  setDynParam(key, value) {
    set((s) => ({
      paramBag: { ...s.paramBag, [key]: value },
    }));
  },

  setDynParams(patch) {
    set((s) => ({
      paramBag: { ...s.paramBag, ...patch },
    }));
  },

  setToneCurve(channel, points) {
    set((s) => ({
      params: {
        ...s.params,
        toneCurve: { ...s.params.toneCurve, [channel]: points },
      },
    }));
  },


  async applyPreset(params, paramBag) {
    set((s) => ({
      previewParams: null,
      previewParamBag: null,
      params: normalizeParams({ ...params, processVersion: s.params.processVersion }),
      // Merge the preset's contributed params over the current bag (a partial
      // preset leaves untouched extension settings in place).
      paramBag: paramBag
        ? { ...s.paramBag, ...normalizeParamBag(paramBag) }
        : s.paramBag,
    }));
    await get().commitEdit("Preset");
  },

  setPreviewParams(params, paramBag) {
    set((s) => ({
      previewParams: params
        ? normalizeParams({ ...params, processVersion: s.params.processVersion })
        : null,
      // Pair the bag with the param preview: merge the preset's contributed
      // params over the live bag (so untouched extension settings stay), and
      // clear it whenever the param preview clears.
      previewParamBag:
        params && paramBag
          ? { ...s.paramBag, ...normalizeParamBag(paramBag) }
          : null,
    }));
  },

  commitEdit: (label) => commitStoredEdit(get, set, label),

  undo() {
    moveHistory(get, set, -1);
  },

  redo() {
    moveHistory(get, set, +1);
  },

  async resetParams(keys, label) {
    const { asShotTemperature } = get();
    if (keys.length === 0) return;
    set((s) => {
      const next = { ...s.params };
      for (const k of keys) {
        // Not an adjustment: only reset() starts a photo over at the current version.
        if (k === "processVersion") continue;
        assignDevelopParam(
          next,
          k,
          k === "temperature" ? asShotTemperature : structuredClone(DEFAULT_DEVELOP_PARAMS[k]),
        );
      }
      return { params: next };
    });
    await get().commitEdit(label);
  },

  async reset() {
    const fresh = freshParams(get().asShotTemperature);
    set({ params: fresh, paramBag: {} });
    // Persist as an undoable history step so the reset survives navigation.
    await get().commitEdit("Reset");
  },

  async updateProcessing() {
    const { photoId, params } = get();
    if (!photoId || !usesOlderProcessing(params)) return;
    set({ params: { ...params, processVersion: CURRENT_PROCESS_VERSION } });
    await get().commitEdit(UPDATE_PROCESSING_LABEL);
  },

  canUndo: () => get().historyIndex > 0,
  canRedo: () => get().historyIndex < get().history.length - 1,
}));
