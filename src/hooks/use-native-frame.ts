// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dynamic mode's full-size luminance of the open RAW, which detail for zoomed
// windows is cut from. It is fetched only once the photo's final source shows, so
// the open never waits on it: 800 ms later in the background, or at once when the
// view first zooms into a window. One frame per source key, held by the native-frame
// worker; the develop renderer is told only its size, and its requests for detail
// are cut there and answered here. Nothing of the pixels is kept here.

import { useEffect, useRef, useState, type RefObject } from "react";
import type { CatalogPhoto } from "@/catalog/types";
import { decodeNativeFrame, type NativeDecode, type NativeDecodeMiss } from "@/catalog/native-decode";
import { photoSourceKey } from "@/catalog/load-image";
import { isRawFile } from "@/raw/raw-preview";
import { NATIVE_FRAME_MAX_PIXELS } from "@/raw/native-frame";
import { cutNativeGain, dropNativeLuma, holdNativeLuma } from "@/raw/native-frame-bridge";
import type { DetailWant, RenderBridge } from "@/rendering/render-bridge";
import { useDevelopStore, type DevelopState } from "@/state/develop-store";
import { useSettings } from "@/state/settings-store";

const DWELL_MS = 800;
// After a decode that passed the request over or failed in passing, before asking again.
const RETRY_MS = 2000;
// A file whose decode keeps passing over or failing is not asked again past this.
const MAX_ATTEMPTS = 3;

export type NativeFrameBridge = Pick<
  RenderBridge,
  "setNativeFrame" | "clearNativeFrame" | "render" | "onDetailWanted" | "setDetailGain"
>;

/** Whether Dynamic detail can reach this photo as its source stands: a RAW whose
 *  decoded frame is larger than the source held, came from the photo's own decode
 *  (`native`: a sample is kept, which bitmaps, camera previews and display-referred
 *  sources never have), and is small enough to hold. */
export function nativeDetailCapable(
  photo: CatalogPhoto | undefined,
  size: DevelopState["sourceSize"],
): boolean {
  return (
    !!photo &&
    isRawFile({ name: photo.filename } as File) &&
    size.native &&
    size.width > 0 &&
    size.fullWidth > size.width &&
    size.fullWidth * size.fullHeight <= NATIVE_FRAME_MAX_PIXELS
  );
}

/** The fetch for one source key while it stays open. */
interface Fetch {
  key: string;
  attempts: number;
  decode: AbortController | null;
  // The dwell, or the wait before a retry (`retrying`).
  dwell: ReturnType<typeof setTimeout> | null;
  retrying: boolean;
  // The bridge asked for: the renderer's own setup lets go of its ref before this
  // hook's cleanup runs, and the frame is cleared on it then.
  bridge: NativeFrameBridge | null;
  // The size of the frame the native-frame worker holds for the key, and whether the
  // renderer has it: each load of the source and a restore take its record away.
  held: { width: number; height: number } | null;
  told: boolean;
  // This photo can never give a frame.
  never: boolean;
  // Whether anything was asked for the key, which is let go of with it.
  started: boolean;
}

/** Fetches the open photo's native luminance in Dynamic mode, holds it in the
 *  native-frame worker and answers the renderer's detail requests from it.
 *  `finalShown`: the photo's final source is on the canvas. `restores` counts the
 *  renderer coming back after a GPU reset, which took its record of the frame.
 *  Returns what the view's window is told to: whether it is zoomed into a window. */
export function useNativeFrame(
  bridgeRef: RefObject<NativeFrameBridge | null>,
  photo: CatalogPhoto | undefined,
  finalShown: boolean,
  restores: number,
): (windowed: boolean) => void {
  const dynamic = useSettings((s) => s.developDynamicDetail);
  const capable = useDevelopStore((s) => nativeDetailCapable(photo, s.sourceSize));
  const key = dynamic && photo && isRawFile({ name: photo.filename } as File) ? photoSourceKey(photo) : null;
  const eligible = key !== null && finalShown && capable;

  const photoRef = useRef(photo);
  photoRef.current = photo;
  const eligibleRef = useRef(eligible);
  eligibleRef.current = eligible;
  const windowedRef = useRef(false);
  const fetchRef = useRef<Fetch | null>(null);

  const [actions] = useState(() => {
    const open = (f: Fetch | null): f is Fetch =>
      !!f && !f.decode && !f.retrying && !f.held && !f.never && f.attempts < MAX_ATTEMPTS;

    const start = (background: boolean) => {
      const f = fetchRef.current;
      const p = photoRef.current;
      if (!open(f) || !p || !eligibleRef.current) return;
      if (f.dwell !== null) {
        clearTimeout(f.dwell);
        f.dwell = null;
      }
      f.attempts++;
      f.started = true;
      f.bridge = bridgeRef.current ?? f.bridge;
      const decode = new AbortController();
      f.decode = decode;
      const settle = (result: NativeDecode | NativeDecodeMiss | null) => {
        if (decode.signal.aborted || fetchRef.current !== f) return;
        f.decode = null;
        if (result && !("miss" in result)) {
          holdNativeLuma(f.key, result);
          f.held = { width: result.width, height: result.height };
          f.told = false;
          // Come while the source is loaded again, the renderer is told once it shows.
          if (eligibleRef.current) tell(f);
        } else if (result && "miss" in result && result.miss === "never") {
          f.never = true;
        } else if (f.attempts < MAX_ATTEMPTS) {
          f.retrying = true;
          f.dwell = setTimeout(() => {
            f.dwell = null;
            f.retrying = false;
            start(!windowedRef.current);
          }, RETRY_MS);
        }
      };
      decodeNativeFrame(p, { signal: decode.signal, background }).then(settle, () => settle(null));
    };

    const dwell = () => {
      const f = fetchRef.current;
      if (!open(f) || f.dwell !== null || !eligibleRef.current) return;
      f.dwell = setTimeout(() => {
        f.dwell = null;
        start(true);
      }, DWELL_MS);
    };

    const tell = (f: Fetch) => {
      const bridge = bridgeRef.current;
      if (!f.held || !bridge) return;
      f.bridge = bridge;
      bridge.setNativeFrame(f.key, f.held);
      f.told = true;
      bridge.render(false);
    };

    const trigger = () => {
      const f = fetchRef.current;
      if (f?.held) {
        if (!f.told) tell(f);
      } else if (windowedRef.current) start(false);
      else dwell();
    };

    // Every load of the photo clears the renderer's source, and its record of the
    // frame with it; a frame held stays, and only its size is told again.
    const reload = () => {
      const f = fetchRef.current;
      if (!f) return;
      if (f.dwell !== null) clearTimeout(f.dwell);
      f.dwell = null;
      f.retrying = false;
      f.told = false;
      if (!f.held) f.attempts = 0;
    };

    // Each request is answered, on the bridge it came from: one left unanswered
    // keeps that view from asking again until it moves.
    const answer = (bridge: NativeFrameBridge, want: DetailWant) => {
      const f = fetchRef.current;
      if (!f || f.key !== want.key || !f.held) {
        bridge.setDetailGain(want.request, null);
        return;
      }
      cutNativeGain(want).then(
        (gain) => bridge.setDetailGain(want.request, gain),
        () => bridge.setDetailGain(want.request, null),
      );
    };

    const noteWindowed = (windowed: boolean) => {
      const was = windowedRef.current;
      windowedRef.current = windowed;
      if (windowed && !was) start(false);
    };

    return { trigger, reload, answer, noteWindowed };
  });

  useEffect(() => {
    if (key === null) return;
    const f: Fetch = {
      key,
      attempts: 0,
      decode: null,
      dwell: null,
      retrying: false,
      bridge: null,
      held: null,
      told: false,
      never: false,
      started: false,
    };
    fetchRef.current = f;
    return () => {
      f.decode?.abort();
      if (f.dwell !== null) clearTimeout(f.dwell);
      if (fetchRef.current === f) fetchRef.current = null;
      if (!f.started) return;
      dropNativeLuma(f.key);
      (f.bridge ?? bridgeRef.current)?.clearNativeFrame();
    };
  }, [key, bridgeRef]);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!dynamic || !bridge) return;
    bridge.onDetailWanted((want) => actions.answer(bridge, want));
    return () => bridge.onDetailWanted(null);
  }, [dynamic, bridgeRef, actions]);

  const restoresSeenRef = useRef(restores);
  useEffect(() => {
    if (restoresSeenRef.current === restores) return;
    restoresSeenRef.current = restores;
    const f = fetchRef.current;
    if (f) f.told = false;
  }, [restores]);

  // The final source going is a load of the photo (a new photo, a re-granted
  // permission, a restore): nothing else takes the tier back down.
  useEffect(() => {
    if (eligible) actions.trigger();
    else actions.reload();
  }, [eligible, key, restores, actions]);

  return actions.noteWindowed;
}
