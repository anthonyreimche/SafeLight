// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Types for app.js, which stays plain JavaScript because the browser gets it as is.

export interface Size { width: number; height: number }
export interface Point { x: number; y: number }
/** `scale` is CSS pixels per photo pixel; `x`,`y` is the photo's top-left corner in the stage. */
export interface View { scale: number; x: number; y: number }
/** A part of the photo in 0…1 photo coordinates. */
export interface Region { x: number; y: number; zw: number; zh: number }

export interface LiveValue {
  tool: string;
  key: string;
  label: string;
  value: unknown;
  display: string;
  min: number | null;
  max: number | null;
  default: unknown;
  changed: boolean;
}

export interface LivePhoto {
  name: string;
  relPath: string;
  width: number;
  height: number;
  step: { at: number; of: number };
  rating: number;
  flag: string | null;
  label: string | null;
}

/** GET /state, per the live-view contract. */
export interface LiveState {
  slu: 1;
  rev: number;
  photo: LivePhoto | null;
  project: { name: string } | null;
  values: LiveValue[];
  history: { index: number; label: string; current: boolean }[];
  working: { at: number; of: number; names: string[] } | null;
  engine: "warming" | "ready" | "failed";
  before: boolean;
}

export interface LiveEnv {
  /** What the endpoints resolve against; the page's own address by default. */
  base: string;
  dpr: () => number;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  EventSource: new (url: string) => EventTarget & { close(): void };
  loadImage: (blob: Blob) => Promise<HTMLImageElement>;
}

export interface LiveView {
  view(): View;
  state(): LiveState | null;
  fit(): void;
  actual(point?: Point): void;
  zoomBy(factor: number, point?: Point): void;
  destroy(): void;
}

export type KeyAction = "before" | "fit" | "actual" | "zoomIn" | "zoomOut" | "prev" | "next";
export type StatusTone = "live" | "waiting" | "stopped";

export const FIT_MARGIN: number;
export const MAX_ZOOM: number;
export const SETTLE_MS: number;
export const LAMP_MS: number;

export function fitScale(photo: Size, viewport: Size): number;
export function scaleBounds(photo: Size, viewport: Size, dpr: number): { fit: number; actual: number; min: number; max: number };
export function clampView(view: View, photo: Size, viewport: Size): View;
export function fitView(photo: Size, viewport: Size): View;
export function zoomAt(view: View, scale: number, point: Point, photo: Size, viewport: Size, dpr: number): View;
export function visibleRegion(view: View, photo: Size, viewport: Size): Region;
export function frameRequest(request: { rev: number; view: View; photo: Size; viewport: Size; dpr: number; before: boolean }): { query: string; region: Region };
export function sliderGeometry(value: { value: unknown; min: number | null; max: number | null; default: unknown }): { at: number; tick: number | null } | null;
export function backoffDelay(attempt: number): number;
export function statusOf(status: { connected: boolean; lost: boolean; engine: LiveState["engine"] | null; renderFailed: boolean }): { tone: StatusTone; text: string };
export function keyAction(event: KeyboardEvent, hasWorkingSet: boolean): KeyAction | null;
export function createLiveView(doc: Document, overrides?: Partial<LiveEnv>): LiveView;
