// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The shapes api.develop hands out and takes: param scopes, the canvas tool,
// float frames and pixel reads.

import type { ComponentType } from "react";
import type {
  DevelopParams,
  HSLAdjustments,
  MaskAdjustments,
  ToneCurves,
} from "@/catalog/types";
import type { CanvasPoint } from "@/modules/develop/pick-drag";
import type { StageSpace } from "./contributions";

/** Where a panel's extension params live: the photo's bag, or one mask's.
 *  Reads see the store as it is now, not as the render was handed it, so a
 *  drag's handler can start each step from the last one's write. */
export interface ParamScope {
  /** The mask being edited, or null for the photo's own values. */
  maskId: string | null;
  /** A param by qualified key ("{stageId}.{key}"). Reads fall back to the
   *  param's registered default when the scope stores nothing. */
  getParam(key: string): unknown;
  /** The values the scope stores, by qualified key, without defaults: the
   *  photo's paramBag or the mask's bag. */
  getParams(): Readonly<Record<string, unknown>>;
  /** Writes several params in one update; an undefined value clears its key. */
  setParams(patch: Record<string, unknown>): void;
  /** End the gesture: one undo step with this label. */
  commit(label: string): void;
}

export interface MaskParamScope extends ParamScope {
  maskId: string;
  /** Core local adjustments — relative strengths, all -100..100, 0 = none. */
  adj: MaskAdjustments;
  setAdj(patch: Partial<MaskAdjustments>): void;
  /** Structured blocks; present only while their sub-panel is added. */
  hsl: HSLAdjustments | undefined;
  setHsl(value: HSLAdjustments): void;
  toneCurve: ToneCurves | undefined;
  setToneCurve(value: ToneCurves): void;
  setParam(key: string, value: unknown): void;
}

/** The box the displayed image occupies, in the canvas's pixels. */
export interface OverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An extension's on-image tool that takes the canvas over while it is held. */
export interface CanvasTool {
  /** Drawn over the image, inside the view: `rect` is the box the frame
   *  shows. Reads the canvas mapping with api.develop.useDevelopOverlay. */
  overlay: ComponentType<{ rect: OverlayRect }>;
  /** Whether zoom and pan still reach the canvas under the overlay. */
  zoomable?: boolean;
  /** The params the live view draws while the tool is held, from the edit's
   *  (crop mode draws the whole image past the crop). View-only: the edit is
   *  untouched. */
  viewParams?(params: DevelopParams): DevelopParams;
  /** Escape was pressed: core lets the tool go after this. */
  onEscape?(): void;
  /** A shortcut's action (keybinding id, e.g. "brush.larger") pressed while
   *  the tool is held: whether the tool took it. Core acts on one it didn't. */
  onAction?(action: string): boolean;
  /** Whether the tool would take `action` now, without acting: a key another
   *  handler also binds (Delete) is left to the tool when it would. */
  wants?(action: string): boolean;
}

/** "pre-output": the signed colour every stage has finished with, as the
 *  output stage receives it. "output": what the output stage makes of it in
 *  sRGB, in [0, 1]. "scene": the scene-linear colour the display transform
 *  receives, signed, before any display tool. */
export type CapturePoint = "pre-output" | "output" | "scene";

export interface FloatCaptureOptions {
  /** Default linear Rec.709. */
  space?: StageSpace;
  /** Default "pre-output". */
  point?: CapturePoint;
  /** Merged over the photo's extension-stage params for this capture only. */
  paramBag?: Record<string, unknown>;
}

/** What a live capture (captureFloatFrame) takes: the options of any float
 *  frame, and the size it is read at. */
export type LiveFloatCaptureOptions = FloatCaptureOptions & {
  /** The frame's long edge in pixels. */
  maxEdge?: number;
};

/** A frame as floats: RGBA, top-down, in `space`. Alpha is 1. */
export interface FloatFrame {
  data: Float32Array;
  width: number;
  height: number;
  space: StageSpace;
  point: CapturePoint;
}

/** The developed frame of the whole image, untransformed and uncropped, as
 *  RGBA8 rows from the top. */
export interface DevelopedPixels {
  data: Uint8Array;
  width: number;
  height: number;
}

/** A panel that can be added to a mask (PanelContribution.mask). */
export interface MaskPanelEntry {
  /** The panel's id: what a mask's `panels` list holds. */
  id: string;
  title: string;
  /** The values the sub-panel owns on a mask (MaskPanelContribution.owns). */
  owns: readonly string[];
  component: ComponentType;
  /** Whether it owns an extension's params, which run in the mask only at
   *  the current processing. */
  extensionParams: boolean;
}

/** Core's auto adjustments (api.develop.autoAdjust). */
export interface AutoAdjust {
  whiteBalance: () => Promise<void>;
  whiteBalanceAt: (point: CanvasPoint) => Promise<void>;
  tone: () => Promise<void>;
}
