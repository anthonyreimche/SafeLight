// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { ComponentType } from "react";
import { create } from "zustand";
import type { DevelopParams } from "@/catalog/types";
import type { OverlayRect } from "@/extensions/api/develop";
import { guardCallback } from "@/extensions/guard";

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

export interface Held {
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

interface GuardedTool {
  onAction(action: string): boolean;
  wants(action: string): boolean;
  onEscape(): void;
  viewParams: ((params: DevelopParams) => DevelopParams) | null;
}

// One guarded set per tool: guardCallback counts throws per function, so a
// fresh wrapper per call would never switch a failing tool off.
const guardedTools = new WeakMap<CanvasTool, GuardedTool>();

function guarded({ owner, tool }: Held): GuardedTool {
  let g = guardedTools.get(tool);
  if (!g) {
    g = {
      onAction: guardCallback(owner, "canvas tool action", (action: string) => tool.onAction?.(action) ?? false, false),
      wants: guardCallback(owner, "canvas tool wants", (action: string) => tool.wants?.(action) ?? false, false),
      onEscape: guardCallback(owner, "canvas tool escape", () => tool.onEscape?.(), undefined),
      viewParams: null,
    };
    if (tool.viewParams) {
      const view = guardCallback(
        owner,
        "canvas tool view",
        (params: DevelopParams): DevelopParams | null => tool.viewParams?.(params) ?? null,
        null,
      );
      g.viewParams = (params) => view(params) ?? params;
    }
    guardedTools.set(tool, g);
  }
  return g;
}

/** A shortcut's action for the held tool: whether it took it. A tool that
 *  throws took nothing. */
export function canvasToolAction(action: string): boolean {
  const held = useCanvasToolStore.getState().held;
  return held ? guarded(held).onAction(action) : false;
}

/** Whether the held tool would take a shortcut's action now. */
export function canvasToolWants(action: string): boolean {
  const held = useCanvasToolStore.getState().held;
  return held ? guarded(held).wants(action) : false;
}

/** The params `held`'s tool has the live view draw (CanvasTool.viewParams), or
 *  null when it has no view. One function per tool, so a renderer memo keyed
 *  on it holds. A tool that throws has the edit drawn as it is. */
export function canvasToolView(held: Held | null): ((params: DevelopParams) => DevelopParams) | null {
  return held ? guarded(held).viewParams : null;
}

/** Escape: tell the held tool, then let it go, whatever the tool does. Whether
 *  there was one. */
export function escapeCanvasTool(): boolean {
  const held = useCanvasToolStore.getState().held;
  if (!held) return false;
  guarded(held).onEscape();
  setCanvasTool(held.owner, null);
  return true;
}
