// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Loads the open photo into the render worker: the stored preview while the source
// loads, then the GPU source cache if it still holds the photo, else the decode (its
// camera preview first), and the neighbours decoded ahead afterwards.

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { CatalogPhoto } from "@/catalog/types";
import { loadPhotoImage, photoSourceKey } from "@/catalog/load-image";
import {
  convertedTargetEdge,
  expectedInputProfileOwner,
  inputProfileOwner,
  inputProfileRevision,
  onInputProfilesChanged,
} from "@/catalog/input-profiles";
import { isRawFile } from "@/raw/raw-preview";
import type { RenderBridge } from "@/rendering/render-bridge";
import type { Float16Source } from "@/rendering/source-sample";
import { missingAdjustments } from "@/extensions/essential-params";
import {
  isExtensionDisabled,
  useDisabledExtensions,
  useExternalPluginsSettled,
  useInstalledPlugins,
  useRunningPlugins,
} from "@/extensions/loader";
import { holdSourceOriginals } from "@/project/library-sources";
import { useDevelopStore } from "@/state/develop-store";
import { showsEdit, standsForPhoto } from "@/state/fallback-rules";
import { getSettings } from "@/state/settings-store";
import { previewShowsEdit } from "./preview-shows-edit";
import {
  fallbackKey,
  isPreview,
  keptPreview,
  noteSource,
  prefetchNeighbors,
  previewReason,
  refreshHeldSource,
} from "./develop-sources";
import { storedPicture, type DevelopPicture } from "./use-develop-picture";

export const NO_STAGES: readonly string[] = [];

/** The longest the first frame waits for the essentials its edit needs, or a
 *  non-RAW photo for the extension that may read its input profile. */
const ESSENTIALS_WAIT_MS = 3000;

export interface PhotoLoadArgs {
  photo: CatalogPhoto | undefined;
  fileAccessNonce: number;
  bridgeRef: RefObject<RenderBridge | null>;
  picture: DevelopPicture;
  /** The photo this view draws, for listeners that outlive a render. */
  openPhotoIdRef: RefObject<string | undefined>;
  /** True from the moment a photo opens until its own source is handed to the
   *  worker. Frames and histograms that arrive meanwhile belong to the photo
   *  before, and are dropped. */
  awaitingSourceRef: RefObject<boolean>;
  /** The source number (RenderBridge.sourceGen) of the image the photo's load settled
   *  on, once it is handed over. Frames of an older number show the camera's preview.
   *  Stays null when the load settled on a preview. */
  finalGenRef: RefObject<number | null>;
  /** The source number of the last image of the photo handed over. */
  sentGenRef: RefObject<number | null>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  /** Why nothing of the photo is drawn, said in place of the label: the worker couldn't
   *  take its source, or there is no picture of it to show (holdEditedPreview). */
  setCantShow: Dispatch<SetStateAction<string | null>>;
  /** Why the load settled on a preview for good (previewReason), for the label. */
  setSettledReason: Dispatch<SetStateAction<string | null>>;
  setOverflowedStages: Dispatch<SetStateAction<readonly string[]>>;
  /** Draws the source just handed over (sent, or bound from the GPU cache) with the
   *  photo's edit. */
  drawSourceRef: RefObject<(bridge: RenderBridge, photo: CatalogPhoto) => void>;
}

export function useDevelopPhotoLoad({
  photo,
  fileAccessNonce,
  bridgeRef,
  picture,
  openPhotoIdRef,
  awaitingSourceRef,
  finalGenRef,
  sentGenRef,
  setLoading,
  setCantShow,
  setSettledReason,
  setOverflowedStages,
  drawSourceRef,
}: PhotoLoadArgs): {
  /** Checks an edited stored preview standing in for the photo; `bitmap` is a fresh draw
   *  of it, null to check only. */
  holdEditedPreview: (bitmap: ImageBitmap | null) => void;
} {
  const { present, clearPicture, isShowing, beginPhoto } = picture;
  // A non-RAW photo's source key follows the input profile resolver's revision,
  // so the view renders, and loads the photo again, as it moves.
  useSyncExternalStore(onInputProfilesChanged, inputProfileRevision);
  const sourceKey = photo ? photoSourceKey(photo) : undefined;

  // A library source's photo keeps its kept original while it is open here.
  const fileHandle = photo?.fileHandle;
  useEffect(() => holdSourceOriginals([fileHandle]), [fileHandle]);

  // An edited photo's stored preview, its original out of reach (Fallback
  // "stored-edited"), shows the edit it was rendered with, so it is never a source: an
  // edit rendered over it would apply twice. It shows as it is while that is the edit
  // open, checked when the load settles on it and on every edit after (an undo back to
  // it shows it again), and nothing shows otherwise. Edits are saved all the same.
  const editedPreviewRef = useRef<{ photo: CatalogPhoto; offline: boolean } | null>(null);
  const holdEditedPreview = useCallback(
    (bitmap: ImageBitmap | null) => {
      const held = editedPreviewRef.current;
      const shows = !!held && previewShowsEdit(held.photo, useDevelopStore.getState());
      if (!held || !shows) {
        bitmap?.close();
        if (!held) return;
        if (isShowing()) clearPicture();
        setCantShow(held.offline ? "The original isn't available." : "Can't show this photo.");
        return;
      }
      setCantShow(null);
      if (bitmap) {
        present(storedPicture(bitmap));
        return;
      }
      const blob = held.photo.thumbnailBlob;
      if (isShowing() || !blob) return;
      createImageBitmap(blob).then(
        (bm) => {
          const still =
            editedPreviewRef.current === held &&
            !isShowing() &&
            previewShowsEdit(held.photo, useDevelopStore.getState());
          if (still) present(storedPicture(bm));
          else bm.close();
        },
        () => {},
      );
    },
    [clearPicture, present, isShowing, setCantShow],
  );

  // Load the active photo into the worker.
  useEffect(() => {
    let cancelled = false;
    const bridge = bridgeRef.current;
    if (!photo || !bridge) return;
    // Once the photo is left, a decode this run asked for that still waits for a
    // decoder gives up its place. One already running finishes and fills the cache.
    const abort = new AbortController();

    setLoading(true);
    // The worker's bound source and the histogram still describe the photo
    // before; neither shows until this photo's source is handed over.
    awaitingSourceRef.current = true;
    finalGenRef.current = null;
    sentGenRef.current = null;
    setCantShow(null);
    setSettledReason(null);
    setOverflowedStages(NO_STAGES);
    editedPreviewRef.current = null;
    bridge.clearSource();
    useDevelopStore.getState().setHistogram(null);
    beginPhoto(bridge, photo.id);

    // DevelopStage loads this photo's edit as it mounts, after this effect has
    // run. Until it lands the store holds the previous photo's edit, so this
    // photo's source isn't rendered before it. Leaving the photo ends the wait too,
    // so whatever waited on it can let go.
    let stopWaiting: (() => void) | null = null;
    let endWait = () => {};
    const editLoaded = new Promise<void>((resolve) => {
      endWait = resolve;
      if (useDevelopStore.getState().photoId === photo.id) return resolve();
      stopWaiting = useDevelopStore.subscribe((s) => {
        if (s.photoId !== photo.id) return;
        stopWaiting?.();
        resolve();
      });
    });

    // The essentials are external extensions that register while the app boots, so a
    // photo opened before they do would draw its first frame without its white
    // balance or Basic. It waits for the stages its edit uses, or for the loading
    // to end, and the stored preview shows meanwhile. One turned off or not installed
    // never comes, and a slow one holds the frame no longer than ESSENTIALS_WAIT_MS.
    const essentialsPending = () => {
      if (useExternalPluginsSettled.getState().settled) return false;
      const st = useDevelopStore.getState();
      const running = useRunningPlugins.getState().ids;
      const installed = useInstalledPlugins.getState().ids;
      const awaited = (id: string) =>
        !running.includes(id) && !isExtensionDisabled(id) && (installed === null || installed.includes(id));
      // Read before its input profile resolver registers, a non-RAW photo would
      // open as sRGB and be kept on the GPU under the key it had before. Only the
      // extension that held the resolver last is waited for, so a photo never
      // waits when none is installed; once one has registered none is to come.
      const expected = expectedInputProfileOwner();
      if (!isRawFile({ name: photo.filename } as File) && inputProfileOwner() === null && expected && awaited(expected)) {
        return true;
      }
      const asShot = photo.exif.colorTemperature ?? st.asShotTemperature;
      return missingAdjustments(st.params, (id) => !awaited(id), asShot).length > 0;
    };
    let stopEssentials = () => {};
    const essentialsReady = () =>
      new Promise<void>((resolve) => {
        if (cancelled || !essentialsPending()) return resolve();
        const check = () => {
          if (!essentialsPending()) stopEssentials();
        };
        const offs = [
          useExternalPluginsSettled.subscribe(check),
          useRunningPlugins.subscribe(check),
          useDisabledExtensions.subscribe(check),
          useInstalledPlugins.subscribe(check),
          onInputProfilesChanged(check),
        ];
        const cap = setTimeout(() => stopEssentials(), ESSENTIALS_WAIT_MS);
        stopEssentials = () => {
          clearTimeout(cap);
          for (const off of offs) off();
          resolve();
        };
      });

    // The stored preview, drawn as it is while the source loads, once the photo's
    // edit has loaded and only if the preview shows it (previewShowsEdit).
    // An edited photo's preview is re-rendered on every Develop commit, see
    // edited-thumbnail.ts, so rendering the edit into it again would apply the
    // edit twice. Nor is its size the source's: an edited preview is cropped.
    const showStoredPreview = async () => {
      if (!photo.thumbnailBlob) return;
      let bm: ImageBitmap;
      try {
        [bm] = await Promise.all([createImageBitmap(photo.thumbnailBlob), editLoaded]);
      } catch {
        return; // the stored preview is optional
      }
      const shows = previewShowsEdit(photo, useDevelopStore.getState());
      if (!cancelled && awaitingSourceRef.current && shows) {
        present(storedPicture(bm));
      } else {
        bm.close();
      }
    };

    // `settled` is set for the image the load settled on: it is uploaded into the GPU
    // source cache under the photo's key when it may stand for the photo (standsForPhoto),
    // so a later re-open is a zero-decode bindSource, and under fallbackKey otherwise.
    // Without it the image is a transient setImage: the camera's preview frames while the
    // decode runs, which no neighbour is ever uploaded over (see fallbackKey).
    const sendImage = (
      image:
        | ImageBitmap
        | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
        | Float16Source,
      isFallback = false,
      settled?: { key: string; preview: boolean },
    ) => {
      if (cancelled) return;
      const maxEdge = getSettings().developMaxEdge;
      const src = image instanceof ImageBitmap ? { kind: "bitmap" as const, bitmap: image } : image;
      if (settled) {
        bridge.uploadSource("main", settled.key, src, maxEdge, isFallback);
        finalGenRef.current = settled.preview ? null : bridge.sourceGen;
      } else {
        bridge.setImage(src, maxEdge, isFallback);
      }
      drawSourceRef.current(bridge, photo);
    };

    // Mirror the photo's as-shot WB into the develop store (same logic on a cache
    // hit and after a fresh decode).
    const syncAsShotTemp = () => {
      if (!photo?.exif.colorTemperature) return;
      const st = useDevelopStore.getState();
      if (st.photoId === photo.id && st.asShotTemperature !== photo.exif.colorTemperature) {
        const asShot = photo.exif.colorTemperature;
        const wasUninitialised = st.asShotTemperature === 6500;
        const needsTempUpdate = wasUninitialised && st.params.temperature === 6500;
        useDevelopStore.setState({
          asShotTemperature: asShot,
          ...(needsTempUpdate ? { params: { ...st.params, temperature: asShot } } : {}),
        });
      }
    };

    const prefetch = () => prefetchNeighbors(bridge, photo, () => cancelled, abort.signal);

    const run = async () => {
      void showStoredPreview();
      await bridge.ready;
      await editLoaded;
      await essentialsReady();
      if (cancelled) return;
      // No renderer to hand the photo to: the stored preview stays, and the view
      // says why (availability).
      if (bridge.availability === "failed") {
        setLoading(false);
        return;
      }

      // Clear any zoom window left over from the previously open photo so the
      // first frame renders the whole image (ViewportImage re-emits an ROI if the
      // new photo ends up zoomed).
      bridge.setViewport(null);

      const key = photoSourceKey(photo);

      // Fast path: the decoded source is already resident on the GPU from a prior
      // open/thumbnail render — bind and render without decoding (instant re-entry).
      if (await bridge.bindSource(key)) {
        if (cancelled) return;
        const kept = keptPreview(bridge, key);
        finalGenRef.current = kept === undefined ? bridge.sourceGen : null;
        setSettledReason(previewReason(kept));
        syncAsShotTemp();
        drawSourceRef.current(bridge, photo);
        refreshHeldSource(bridge, photo, key, openPhotoIdRef);
        setLoading(false);
        void prefetch();
        return;
      }
      if (cancelled) return;

      const image = await loadPhotoImage(photo, {
        onPreview: (preview) => {
          if (cancelled) {
            if (preview.kind === "bitmap") preview.bitmap.close();
            return;
          }
          if (preview.kind === "bitmap") {
            sendImage(preview.bitmap);
          } else {
            sendImage(preview);
          }
        },
        signal: abort.signal,
        // For api.develop.readSourceSample on a photo served from the RAW cache.
        sample: true,
        // The renderer caps a converted non-RAW source to the develop edge: it
        // is averaged down in the frame worker instead of crossing at full size.
        ...convertedTargetEdge(photo, getSettings().developMaxEdge),
      });
      if (cancelled) {
        if (image?.kind === "bitmap") image.bitmap.close();
        return;
      }
      if (!image) {
        setCantShow(
          photo.decodeError
            ? `Can't show this photo: ${photo.decodeError}`
            : photo.fileHandle
              ? "Can't read this file."
              : "The original isn't available.",
        );
        setLoading(false);
        return;
      }

      syncAsShotTemp();

      const fallback = image.kind === "bitmap" ? image.fallback : undefined;
      setSettledReason(previewReason(fallback));
      if (image.kind === "bitmap" && fallback && showsEdit(image)) {
        editedPreviewRef.current = { photo, offline: fallback.offline };
        holdEditedPreview(image.bitmap);
        setLoading(false);
        void prefetch();
        return;
      }
      const isFallback = image.kind === "float" ? (image.isFallbackPreview ?? false) : false;
      const stands = standsForPhoto(image);
      const settled = stands
        ? { key, preview: isPreview(image) }
        : { key: fallbackKey(key), preview: true };
      if (stands) noteSource(bridge, key, image);
      if (image.kind === "bitmap") {
        sendImage(image.bitmap, isFallback, settled);
      } else {
        sendImage(image, isFallback, settled);
      }
      setLoading(false);
      void prefetch();
    };

    run().catch((e) => {
      if (cancelled) return;
      console.error("[develop] couldn't show photo", photo.id, e);
      setCantShow("Can't show this photo.");
      setLoading(false);
    });
    return () => {
      cancelled = true;
      abort.abort();
      stopWaiting?.();
      endWait();
      stopEssentials();
    };
    // A turn moves the key too, so it loads once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo?.id, sourceKey, fileAccessNonce]);

  return { holdEditedPreview };
}
