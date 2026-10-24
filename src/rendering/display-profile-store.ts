// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The monitor profile the live Develop view converts to (Linux only; see
// display-profile.ts). The path lives in settings; the file is read again at
// boot, whenever the path changes (in any window) and on reload, so a profile
// recalibrated in place is picked up by choosing it again.

import { create } from "zustand";
import { privilegedFs } from "@/native/privileged";
import { getSettings, useSettings } from "@/state/settings-store";
import {
  PROFILE_ERROR,
  parseDisplayProfile,
  type MonitorTransform,
  type ParsedDisplayProfile,
} from "./display-profile";

export type DisplayProfileState =
  | { status: "off" }
  | { status: "loading"; path: string }
  | { status: "active"; path: string; description: string; transform: MonitorTransform }
  | { status: "error"; path: string; error: string };

export const READ_ERROR = "Couldn't read the profile file.";

export const useDisplayProfile = create<DisplayProfileState>(() => ({ status: "off" }));

/** Chromium converts the window to the display everywhere but Linux, where
 *  Wayland leaves it unconverted unless the desktop converts it. */
export function displayProfileSupported(): boolean {
  return window.safelightNative?.platform === "linux";
}

export function activeMonitorTransform(): MonitorTransform | null {
  const state = useDisplayProfile.getState();
  return state.status === "active" ? state.transform : null;
}

type ReadFile = (path: string) => Promise<Uint8Array>;

async function readNative(path: string): Promise<Uint8Array> {
  const fs = privilegedFs();
  if (!fs) throw new Error("no native filesystem");
  return (await fs.read(path)).data;
}

let readFile: ReadFile = readNative;
// Each load's number; a read that finishes after a newer load began is dropped.
let generation = 0;

async function load(path: string): Promise<void> {
  const current = ++generation;
  if (!path || !displayProfileSupported()) {
    useDisplayProfile.setState({ status: "off" }, true);
    return;
  }
  useDisplayProfile.setState({ status: "loading", path }, true);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (err) {
    if (current !== generation) return;
    console.warn(`[display-profile] can't read ${path}:`, err);
    useDisplayProfile.setState({ status: "error", path, error: READ_ERROR }, true);
    return;
  }
  if (current !== generation) return;
  let parsed: ParsedDisplayProfile;
  try {
    parsed = parseDisplayProfile(bytes);
  } catch (err) {
    // Whatever the file holds, the status must not stay "loading".
    console.warn(`[display-profile] can't parse ${path}:`, err);
    parsed = { ok: false, error: PROFILE_ERROR.notIcc };
  }
  if (!parsed.ok) {
    console.warn(`[display-profile] can't use ${path}: ${parsed.error}`);
    useDisplayProfile.setState({ status: "error", path, error: parsed.error }, true);
    return;
  }
  const { description, transform } = parsed.profile;
  useDisplayProfile.setState({ status: "active", path, description, transform }, true);
}

/** Load the profile in settings and follow the path. Call once at boot;
 *  returns the unsubscribe. */
export function initDisplayProfile(read: ReadFile = readNative): () => void {
  readFile = read;
  let path = getSettings().displayProfilePath;
  void load(path);
  return useSettings.subscribe((s) => {
    if (s.displayProfilePath === path) return;
    path = s.displayProfilePath;
    void load(path);
  });
}

/** Read the profile at the current path again. */
export function reloadDisplayProfile(): Promise<void> {
  return load(getSettings().displayProfilePath);
}
