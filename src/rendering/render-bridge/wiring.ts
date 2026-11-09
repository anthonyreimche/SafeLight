// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { ProcessingStageContribution, StageTextureData } from "@/extensions/types";
import { usePipelineStore } from "@/extensions/pipelines";
import { onStagesReleased, useRegistry, type RegisteredProcessingStage } from "@/extensions/registry";
import { getSettings, useSettings } from "@/state/settings-store";
import { activeMonitorTransform, useDisplayProfile } from "../display-profile-store";
import { currentDisplaySpace, subscribeDisplaySpace } from "../display-space";
import type { MonitorTransform } from "../display-profile";
import type { DisplaySpace } from "../color-space";
import { forgetCrashesOf, withoutCrashed } from "../gpu-crash-guard";

/** What the app-wide state feeds into the shared bridge (RenderBridge). */
interface WiredBridge {
  render(wantHistogram?: boolean): void;
  setStageTextures(bag: Record<string, StageTextureData>): void;
  patchStageTextures(set: Record<string, StageTextureData>, remove: string[]): void;
  setCacheBudget(bytes: number): void;
  setMonitorTransform(transform: MonitorTransform | null): void;
  setDisplaySpace(space: DisplaySpace): void;
  syncStages(): void;
  syncPipeline(): void;
}

// The shared bridge (getRenderBridge), while it is wired to the stores.
let wired: WiredBridge | null = null;
let unsubscribers: (() => void)[] = [];

// Stage textures live here (not in the per-photo param bag — they're bulk static
// data tied to the stage, not the edit). Extensions push via api.setStageTexture;
// the bag is replayed when the bridge (re)initializes.
const stageTextures: Record<string, StageTextureData> = {};

// Stage and stage-texture changes don't flow through the param-driven develop
// render effect, so an extension swapping a stage or its textures (e.g. picking
// a film stock) wouldn't repaint until the next interaction. Redraw here,
// rAF-debounced so a swap (re-register + N texture uploads) coalesces into one.
let stageRenderRaf: number | null = null;
// A hidden or minimised window runs no animation frames, so the same work also runs
// from a timeout, whichever comes first.
const STAGE_SYNC_FALLBACK_MS = 50;
let stageRenderTimer: ReturnType<typeof setTimeout> | null = null;
// The stage and pipeline sets ride the same frame, so a boot that registers
// stages one extension at a time posts the set once a frame, not once each.
let stagesDirty = false;
let pipelineDirty = false;

function sameStages(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const before = Object.values(a);
  const after = Object.values(b);
  return before.length === after.length && before.every((stage, i) => stage === after[i]);
}

function cancelStageRender(): void {
  if (stageRenderRaf != null) cancelAnimationFrame(stageRenderRaf);
  if (stageRenderTimer != null) clearTimeout(stageRenderTimer);
  stageRenderRaf = null;
  stageRenderTimer = null;
}

function requestStageRender(): void {
  if (!wired || stageRenderRaf != null) return;
  const run = () => {
    // The other of the frame and the timeout, or a frame a cancelled request left.
    if (stageRenderRaf !== frame) return;
    cancelStageRender();
    flushStageSync();
    postStageTextures();
    wired?.render(false);
  };
  const frame = requestAnimationFrame(run);
  stageRenderRaf = frame;
  stageRenderTimer = setTimeout(run, STAGE_SYNC_FALLBACK_MS);
}

/** Post the stages and pipeline that changed since they last went, without waiting for
 *  the frame that batches them: the bridge calls this before it asks the worker to draw
 *  or read, which must use the current set. */
export function flushStageSync(): void {
  if (!wired) return;
  const stages = stagesDirty;
  const pipeline = pipelineDirty;
  stagesDirty = false;
  pipelineDirty = false;
  if (stages) wired.syncStages();
  if (pipeline) wired.syncPipeline();
}

// Posting clones every texture it carries, so the worker gets the bag whole when the
// bridge is wired and then, once a frame, only the keys set or cleared since.
const changedTextureKeys = new Set<string>();
let texturePostRaf: number | null = null;

function queueTexturePost(qualifiedKey: string): void {
  if (!wired) return;
  changedTextureKeys.add(qualifiedKey);
  texturePostRaf ??= requestAnimationFrame(postStageTextures);
}

function postStageTextures(): void {
  if (texturePostRaf != null) cancelAnimationFrame(texturePostRaf);
  texturePostRaf = null;
  if (!wired || changedTextureKeys.size === 0) return;
  const set: Record<string, StageTextureData> = {};
  const remove: string[] = [];
  for (const key of changedTextureKeys) {
    if (Object.hasOwn(stageTextures, key)) set[key] = stageTextures[key];
    else remove.push(key);
  }
  changedTextureKeys.clear();
  wired.patchStageTextures(set, remove);
}

const MB = 1024 * 1024;
const MAX_TEXTURE_BYTES = 64 * MB;
const MAX_EXTENSION_TEXTURE_BYTES = 256 * MB;

// What renderer.ensureStageTexture uploads each format from. Bytes may come in a
// Uint8ClampedArray too: canvas ImageData hands its pixels over in one.
type TexelArray = typeof Uint8Array | typeof Uint8ClampedArray | typeof Float32Array;
const BYTES: readonly TexelArray[] = [Uint8Array, Uint8ClampedArray];
const FLOATS: readonly TexelArray[] = [Float32Array];
const TEXEL_LAYOUTS: Record<StageTextureData["format"], { channels: number; arrays: readonly TexelArray[] }> = {
  rgba8: { channels: 4, arrays: BYTES },
  r8: { channels: 1, arrays: BYTES },
  rgba16f: { channels: 4, arrays: FLOATS },
  r16f: { channels: 1, arrays: FLOATS },
};

const inMB = (bytes: number): string => (bytes / MB).toFixed(1);

/** The extension a texture key belongs to: that of the longest stage id it
 *  extends, found by looking its prefixes up, longest first. */
function textureOwner(
  stages: Readonly<Record<string, RegisteredProcessingStage>>,
  qualifiedKey: string,
): string | undefined {
  for (let end = qualifiedKey.lastIndexOf("."); end > 0; end = qualifiedKey.lastIndexOf(".", end - 1)) {
    const stage = stages[qualifiedKey.slice(0, end)];
    if (stage) return stage.extensionId;
  }
  return undefined;
}

/** Why the renderer can't upload `tex` as it describes itself, or why the
 *  extension may not hold it besides the textures it has; null when it can. A
 *  texture that doesn't match its description uploads as a GL error, and the
 *  stage silently reads black. */
function textureProblem(
  stages: Readonly<Record<string, RegisteredProcessingStage>>,
  qualifiedKey: string,
  owner: string | undefined,
  tex: StageTextureData,
): string | null {
  const layout = Object.hasOwn(TEXEL_LAYOUTS, tex.format) ? TEXEL_LAYOUTS[tex.format] : undefined;
  if (!layout) return `has unknown format "${String(tex.format)}"`;
  const { width, height, data } = tex;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    return `needs a whole, positive width and height, not ${width}×${height}`;
  if (!layout.arrays.some((array) => data instanceof array))
    return `needs a ${layout.arrays.map((array) => array.name).join(" or ")} for ${tex.format}`;
  const values = width * height * layout.channels;
  if (data.length !== values)
    return `holds ${data.length} values where ${width}×${height} ${tex.format} takes ${values}`;
  if (data.byteLength > MAX_TEXTURE_BYTES)
    return `is ${inMB(data.byteLength)} MB, over the ${MAX_TEXTURE_BYTES / MB} MB one texture may take`;
  let held = data.byteLength;
  for (const [key, other] of Object.entries(stageTextures))
    if (key !== qualifiedKey && textureOwner(stages, key) === owner) held += other.data.byteLength;
  if (held > MAX_EXTENSION_TEXTURE_BYTES)
    return `would bring its stage textures to ${inMB(held)} MB, over the ${
      MAX_EXTENSION_TEXTURE_BYTES / MB
    } MB one extension may hold`;
  return null;
}

/** Set or clear (null) a processing stage's texture by qualified key
 *  "{stageId}.{key}". A texture the renderer can't take is refused with a
 *  warning, and the one held before stays; a clear always goes through. */
export function setStageTexture(
  qualifiedKey: string,
  tex: StageTextureData | null,
): void {
  if (tex) {
    const stages = useRegistry.getState().processingStages;
    const owner = textureOwner(stages, qualifiedKey);
    const problem = textureProblem(stages, qualifiedKey, owner, tex);
    if (problem) {
      console.warn(
        `[extensions] ${owner ?? "?"}: stage texture "${qualifiedKey}" ${problem}; setStageTexture ignored`,
      );
      return;
    }
    stageTextures[qualifiedKey] = tex;
  } else delete stageTextures[qualifiedKey];
  queueTexturePost(qualifiedKey);
  requestStageRender();
}

/** Drop the textures of the stages a swept extension owned, so turning it off
 *  frees them here and, at the next frame, in the worker. A key belongs
 *  to the longest stage id it extends: a stage whose id extends a dropped one
 *  keeps its own. */
function releaseStageTextures(stageIds: readonly string[]): void {
  const released = new Set(stageIds);
  const stages = [...stageIds, ...Object.keys(useRegistry.getState().processingStages)];
  const ownerOf = (key: string): string => {
    let owner = "";
    for (const id of stages)
      if (key.startsWith(`${id}.`) && id.length > owner.length) owner = id;
    return owner;
  };
  const dropped = Object.keys(stageTextures).filter((key) => released.has(ownerOf(key)));
  if (dropped.length === 0) return;
  for (const key of dropped) {
    delete stageTextures[key];
    queueTexturePost(key);
  }
}
onStagesReleased(releaseStageTextures);
// Turning an extension off and on tries the stages the crash guard blamed again.
onStagesReleased(forgetCrashesOf);

/** The current stage-texture bag (qualified key → data). Returned by reference;
 *  callers must not mutate. Used by the export pipeline to seed its own renderer
 *  with the same film LUTs / spectral tables the live renderer has, so stages
 *  that depend on uploaded textures (e.g. Spektrafilm) don't render black. */
export function getStageTextures(): Record<string, StageTextureData> {
  return stageTextures;
}

/** The registered stages as the render worker takes them: without `derive`,
 *  which runs in the window (frameStageBag) and can't be posted, and without
 *  those that took the graphics driver down (gpu-crash-guard.ts). */
export function stagesForWorker(): ProcessingStageContribution[] {
  return Object.values(withoutCrashed(useRegistry.getState().processingStages)).map((stage) => {
    const { derive, ...sent } = stage;
    return derive ? sent : stage;
  });
}

/** Make `bridge` the shared one: hand it what it doesn't hold yet, and keep it
 *  following the stores. Call after its init, which posts the current stages and
 *  pipeline ahead of itself. */
export function wireBridge(bridge: WiredBridge): void {
  wired = bridge;

  // Replay any stage textures registered before the bridge existed.
  changedTextureKeys.clear();
  if (Object.keys(stageTextures).length > 0) bridge.setStageTextures(stageTextures);

  // Push the GPU source-cache budget now and whenever the preference changes.
  bridge.setCacheBudget(getSettings().gpuSourceCacheBytes);
  let prevBudget = getSettings().gpuSourceCacheBytes;
  const unsubSettings = useSettings.subscribe((s) => {
    if (s.gpuSourceCacheBytes !== prevBudget) {
      prevBudget = s.gpuSourceCacheBytes;
      wired?.setCacheBudget(prevBudget);
    }
  });

  // The display profile, now and whenever it changes; the worker starts
  // without one.
  let prevMonitor = activeMonitorTransform();
  if (prevMonitor) bridge.setMonitorTransform(prevMonitor);
  const unsubMonitor = useDisplayProfile.subscribe(() => {
    const next = activeMonitorTransform();
    if (next === prevMonitor) return;
    prevMonitor = next;
    wired?.setMonitorTransform(next);
    requestStageRender();
  });

  // The space the screen shows, likewise; the worker starts in sRGB.
  const startSpace = currentDisplaySpace();
  if (startSpace !== "srgb") bridge.setDisplaySpace(startSpace);
  const unsubDisplaySpace = subscribeDisplaySpace((space) => {
    wired?.setDisplaySpace(space);
    requestStageRender();
  });

  let prevStages = useRegistry.getState().processingStages;
  let prevPipelines = useRegistry.getState().pipelines;
  const unsubStages = useRegistry.subscribe((s) => {
    if (s.processingStages !== prevStages) {
      const changed = !sameStages(prevStages, s.processingStages);
      prevStages = s.processingStages;
      // Unregistering an extension rebuilds the map even when it held no stage; the
      // workers clear their injection memos on every set they are sent.
      if (changed) {
        stagesDirty = true;
        requestStageRender();
      }
    }
    if (s.pipelines !== prevPipelines) {
      prevPipelines = s.pipelines;
      pipelineDirty = true;
      // A pipeline (display-transform) swap is silent like a stage swap:
      // it updates renderer state but isn't param-driven, so force a redraw.
      requestStageRender();
    }
  });
  const unsubPipeline = usePipelineStore.subscribe(() => {
    pipelineDirty = true;
    // A new Preferences default changes what a photo without its own pick
    // renders with; repaint, else the canvas keeps the previous transform
    // until the next interaction.
    requestStageRender();
  });

  unsubscribers = [unsubStages, unsubPipeline, unsubSettings, unsubMonitor, unsubDisplaySpace];
}

/** Stop the shared bridge following the stores, before it is disposed. */
export function unwireBridge(): void {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  // A frame that hasn't run would hold back the next bridge's redraws until
  // it does, and one that never runs (a hidden page) would hold them for good.
  cancelStageRender();
  stagesDirty = false;
  pipelineDirty = false;
  if (texturePostRaf != null) cancelAnimationFrame(texturePostRaf);
  texturePostRaf = null;
  changedTextureKeys.clear();
  wired = null;
}
