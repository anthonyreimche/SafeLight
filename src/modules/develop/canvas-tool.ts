// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { ComponentType } from "react";
import { create } from "zustand";
import type { DevelopParams } from "@/catalog/types";
import type { OverlayRect } from "@/extensions/api/develop";

// The canvas tool: an extension's on-image tool that takes the canvas over
// while it is held (Crop & Straighten's crop mode, Guided Upright's lines, the
// heal and mask tools). Its overlay is drawn over the image inside the view;
// core's own canvas gestures (the pick-drag tool, and zoom unless the tool
// allows it) stand aside, and the live view may draw different params while
// it is held. One extension holds it at a time; ephemeral, never persisted.

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

interface Held {
  owner: string;
  tool: CanvasTool;
}

export const useCanvasToolStore = create<{ held: Held | null }>(() => ({ held: null }));

/** Hand the canvas `owner`'s tool, or with null take `owner`'s tool back; a
 *  tool another extension holds stays. */
export function setCanvasTool(owner: string, tool: CanvasTool | null): void {
  if (tool) useCanvasToolStore.setState({ held: { owner, tool } });
  else if (useCanvasToolStore.getState().held?.owner === owner) useCanvasToolStore.setState({ held: null });
}

/** A shortcut's action for the held tool: whether it took it. */
export function canvasToolAction(action: string): boolean {
  return useCanvasToolStore.getState().held?.tool.onAction?.(action) ?? false;
}

/** Whether the held tool would take a shortcut's action now. */
export function canvasToolWants(action: string): boolean {
  return useCanvasToolStore.getState().held?.tool.wants?.(action) ?? false;
}

/** Escape: tell the held tool, then let it go. Whether there was one. */
export function escapeCanvasTool(): boolean {
  const held = useCanvasToolStore.getState().held;
  if (!held) return false;
  held.tool.onEscape?.();
  setCanvasTool(held.owner, null);
  return true;
}
