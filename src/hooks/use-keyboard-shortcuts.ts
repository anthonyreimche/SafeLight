// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Global shortcut handler. All combos come from the rebindable keybindings
// store (Preferences ▸ Shortcuts). Library-scoped culling shortcuts live in
// use-culling-shortcuts.ts, mounted by the Library module's view.

import { useEffect } from "react";
import { useUIStore } from "@/state/ui-store";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import { usesSignedOutput } from "@/catalog/types";
import { toggleDockSide, toggleDockVisibility } from "@/extensions/dock";
import { hasModule } from "@/extensions/registry";
import { guardCallback } from "@/extensions/guard";
import { getSettings, stepCanvasSurround } from "@/state/settings-store";
import { detachedModule } from "@/state/detach";
import {
  getBinding,
  inNativeDialog,
  isBareKey,
  matchAction,
  matchExtensionAction,
  shortcutsSuspended,
  typesIntoField,
} from "@/state/keybindings-store";
import { moveActivePhoto } from "@/modules/library/photo-navigation";
import { cullingShortcutsMounted } from "@/modules/library/use-culling-shortcuts";
import { viewportZoomCommands } from "@/state/viewport-zoom-commands";
import { useProjectStore } from "@/project/project-store";
import { togglePreferences } from "@/ui/preferences/preferences-store";
import { toggleExtensions } from "@/ui/components/extensions-dialog-store";
import { toggleReportIssue } from "@/ui/components/report-issue-store";
import { popEscapeHandler } from "@/ui/escape-stack";
import { usePickDragStore } from "@/modules/develop/pick-drag";
import { canvasToolAction, escapeCanvasTool } from "@/modules/develop/canvas-tool";

/** Actions only the held canvas tool acts on (canvas-tool.ts onAction). */
const CANVAS_TOOL_ACTIONS: ReadonlySet<string> = new Set([
  "brush.smaller",
  "brush.larger",
  "brush.featherDown",
  "brush.featherUp",
  "brush.opacityDown",
  "brush.opacityUp",
  "brush.flowDown",
  "brush.flowUp",
  "mask.delete",
]);

// Single-letter bindings for these are gated by the singleKeyShortcuts pref.
const GATED = new Set(["module.library", "module.develop", "view.fullscreen"]);

export function useKeyboardShortcuts() {
  const setActiveModule = useUIStore((s) => s.setActiveModule);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (shortcutsSuspended() || inNativeDialog(e.target)) return;

      // Esc = universal "exit": close the topmost modal, else leave the active
      // develop tool mode (the panel "Done" buttons). Runs before the editable-
      // target gate so it still closes a dialog from a focused field; when there
      // is nothing to exit it doesn't consume the key (so a rename input's own
      // Esc-to-cancel still works). A field that marks itself data-own-escape
      // (the slider's value field) keeps Esc for its own revert, even when
      // something is open to exit.
      if (e.key === "Escape") {
        if (e.target instanceof Element && e.target.closest("[data-own-escape]")) return;
        if (popEscapeHandler()) {
          e.preventDefault();
          return;
        }
        if (escapeCanvasTool()) {
          // An extension's on-image tool (crop mode, Guided Upright's lines, the
          // heal and mask tools).
          e.preventDefault();
        } else if (usePickDragStore.getState().held) {
          // An extension's on-image pick tool (White Balance's eyedropper, HSL's target).
          e.preventDefault();
          usePickDragStore.setState({ held: null });
        }
        return;
      }

      // Shortcuts take priority everywhere except over typing into a text
      // field: Ctrl/Cmd combos fire even while an input has focus, and a
      // focused slider never blocks anything.
      if (typesIntoField(e)) return;

      const inDevelop =
        useUIStore.getState().activeModule === "develop" ||
        detachedModule() === "develop";

      // [ / ] rotate the active photo in Develop too (Library mounts its own
      // handler; Develop only has this global one). Bare brackets bind solely to
      // rotate, so there's no conflict with the Shift+[ ] feather shortcuts.
      if (inDevelop) {
        // Prev/next and rotate also belong to the culling handler, which a photo
        // surface docked in Develop (a Filmstrip) mounts. While one is up it owns
        // them — running both would step or rotate twice per press.
        const culling = cullingShortcutsMounted();

        // ←/→ step to the prev/next photo (same order the grid shows), so you
        // can cull through a shoot without leaving Develop. A focused slider
        // owns its own arrow keys, so leave range inputs alone.
        if (
          !culling &&
          (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          !e.shiftKey &&
          !(e.target instanceof HTMLInputElement && e.target.type === "range")
        ) {
          e.preventDefault();
          moveActivePhoto(e.key === "ArrowLeft" ? -1 : 1);
          return;
        }

        const rot = culling ? null : matchAction(e, ["Library"]);
        if (rot === "photo.rotateCCW" || rot === "photo.rotateCW") {
          const cat = useCatalogStore.getState();
          const ids =
            cat.selectedIds.size > 0
              ? [...cat.selectedIds]
              : cat.activePhotoId
                ? [cat.activePhotoId]
                : [];
          if (ids.length > 0) {
            e.preventDefault();
            void cat.rotatePhotos(ids, rot === "photo.rotateCCW" ? -90 : 90);
          }
          return;
        }
      }

      const action =
        matchAction(e, ["General"]) ??
        (inDevelop ? matchAction(e, ["Develop"]) : null);
      if (!action) {
        // Extension-registered shortcuts fire after built-ins.
        const ext = matchExtensionAction(e);
        if (ext) {
          e.preventDefault();
          guardCallback(ext.extensionId, "keyboard shortcut", ext.handler, undefined)();
        }
        return;
      }

      if (
        GATED.has(action) &&
        isBareKey(getBinding(action)) &&
        !getSettings().singleKeyShortcuts
      ) {
        return;
      }

      // The canvas tool an extension holds (the heal and mask brushes) takes the
      // actions it handles ahead of core. The brush and mask actions are only
      // ever a tool's: with none to take one, the key goes through.
      if (inDevelop && canvasToolAction(action)) {
        e.preventDefault();
        return;
      }
      if (CANVAS_TOOL_ACTIONS.has(action)) return;

      const ds = useDevelopStore.getState();
      // Tool-scoped Develop actions only fire while their mode is active; when
      // it isn't, let the key through instead of swallowing it.
      const modeActive: Record<string, boolean> = {
        // Only a photo with the version 3 output stage has a proof, as with the
        // Proof button; on any other the key stays untouched and so does the flag.
        "develop.toggleProof": usesSignedOutput(ds.params),
        // Surround steppers only act when the canvas surround is enabled in
        // Preferences; otherwise the surround follows the theme and there's
        // nothing to step, so let the key through.
        "develop.surroundDarker": getSettings().canvasSurroundOverride,
        "develop.surroundLighter": getSettings().canvasSurroundOverride,
        // The zoom quartet needs a mounted, unlocked viewport to act on; with
        // none (crop mode, no image) the combos stay with the browser/OS.
        "develop.zoomIn": !!viewportZoomCommands(),
        "develop.zoomOut": !!viewportZoomCommands(),
        "develop.zoomFit": !!viewportZoomCommands(),
        "develop.zoom100": !!viewportZoomCommands(),
      };
      if (action in modeActive && !modeActive[action]) return;

      // Matched = handled: beat the browser/OS default for the combo.
      e.preventDefault();

      switch (action) {
        case "app.preferences":
          togglePreferences();
          break;
        case "app.extensions":
          toggleExtensions();
          break;
        case "app.reportIssue":
          toggleReportIssue();
          break;
        case "app.openFolder": {
          const ps = useProjectStore.getState();
          if (!ps.opening) void ps.openProjectPicker();
          break;
        }
        case "module.library":
          if (hasModule("library")) setActiveModule("library");
          break;
        case "module.develop":
          if (hasModule("develop")) setActiveModule("develop");
          break;
        case "panels.toggle":
          // Hide/show every dock panel; positions are restored exactly.
          toggleDockVisibility();
          break;
        case "panels.toggleLeft":
          toggleDockSide("left");
          break;
        case "panels.toggleRight":
          toggleDockSide("right");
          break;
        case "panels.toggleBottom":
          toggleDockSide("bottom");
          break;
        case "view.fullscreen":
          document.documentElement.requestFullscreen?.();
          break;
        case "develop.undo":
          ds.undo();
          break;
        case "develop.redo":
          ds.redo();
          break;
        case "develop.reset":
          if (ds.photoId) void ds.reset();
          break;
        case "develop.zoomIn":
          viewportZoomCommands()?.zoomStep(1);
          break;
        case "develop.zoomOut":
          viewportZoomCommands()?.zoomStep(-1);
          break;
        case "develop.zoomFit":
          viewportZoomCommands()?.zoomFit();
          break;
        case "develop.zoom100":
          viewportZoomCommands()?.zoom100();
          break;
        case "develop.toggleClipping":
          ds.toggleClipping();
          break;
        case "develop.toggleProof":
          ds.toggleProof();
          break;
        case "develop.colorAssessment":
          ds.toggleColorAssessment();
          break;
        case "develop.surroundDarker":
          stepCanvasSurround(-1);
          break;
        case "develop.surroundLighter":
          stepCanvasSurround(1);
          break;
      }
    };

    // Capture phase: shortcuts see the event before any component can
    // stopPropagation it away.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [setActiveModule]);
}
