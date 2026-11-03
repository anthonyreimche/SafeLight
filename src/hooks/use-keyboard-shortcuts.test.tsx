// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The zoom quartet routes through the central rebindable-shortcut handler to
// whichever viewport is currently registered; with no viewport mounted the
// combos must fall through untouched (no preventDefault) so nothing swallows
// keys in modules without an image on screen. The later blocks characterize
// the rest of the handler: the Esc chain, Develop's arrow keys and rotate next
// to a culling surface, the single-key preference, and tool-scoped mask.delete.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { Slider } from "@/ui/components/Slider";
import { ContextMenu } from "@/ui/components/ContextMenu";
import { normalizeParams, type CatalogPhoto } from "@/catalog/types";
import { photo } from "@/catalog/stored-edit.fixtures";
import { useKeyboardShortcuts } from "./use-keyboard-shortcuts";
import { NO_FILTER } from "@/modules/library/visible-photos";
import { useCullingShortcuts } from "@/modules/library/use-culling-shortcuts";
import { useCatalogStore } from "@/state/catalog-store";
import { useDockStore } from "@/extensions/dock";
import { registerEssentialModules, unregisterEssentialModules } from "@/test/essential-modules.test-support";
import { useDevelopStore, type DevelopState } from "@/state/develop-store";
import { setPickDrag, usePickDragStore } from "@/modules/develop/pick-drag";
import { setCanvasTool, useCanvasToolStore } from "@/modules/develop/canvas-tool";
import { CALLBACK_FAILURE_LIMIT, forgetCallbackFailures, useCallbackFailures } from "@/extensions/guard";

/** An extension's on-image tool holding the canvas, as crop mode does. */
const holdCanvas = () => setCanvasTool("acme.crop", { overlay: () => null });
const canvasHeld = () => useCanvasToolStore.getState().held !== null;
import {
  KEY_ACTIONS,
  getBinding,
  registerExtensionAction,
  unregisterExtensionActions,
  resetBinding,
  setBinding,
  resetShortcutHoldsForTests,
  suspendShortcuts,
} from "@/state/keybindings-store";
import { useSettings } from "@/state/settings-store";
import { useUIStore } from "@/state/ui-store";
import { pushEscapeHandler } from "@/ui/escape-stack";
import { closeReportIssue, useReportIssue } from "@/ui/components/report-issue-store";
import {
  registerViewportZoomCommands,
  type ViewportZoomCommands,
} from "@/state/viewport-zoom-commands";

function Harness() {
  useKeyboardShortcuts();
  return null;
}

function press(key: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, ctrlKey: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
}

let off: (() => void) | null = null;
afterEach(() => {
  off?.();
  off = null;
});

function mountInDevelop(): ViewportZoomCommands {
  useUIStore.setState({ activeModule: "develop" });
  render(<Harness />);
  const commands: ViewportZoomCommands = {
    zoomStep: vi.fn(),
    zoomFit: vi.fn(),
    zoom100: vi.fn(),
  };
  off = registerViewportZoomCommands(commands);
  return commands;
}

describe("zoom shortcut dispatch", () => {
  it("routes the Photoshop quartet to the registered viewport", () => {
    const commands = mountInDevelop();
    expect(press("=").defaultPrevented).toBe(true);
    expect(commands.zoomStep).toHaveBeenLastCalledWith(1);
    press("-");
    expect(commands.zoomStep).toHaveBeenLastCalledWith(-1);
    press("0");
    expect(commands.zoomFit).toHaveBeenCalled();
    press("1");
    expect(commands.zoom100).toHaveBeenCalled();
  });

  it("lets the combos fall through when no viewport is registered", () => {
    useUIStore.setState({ activeModule: "develop" });
    render(<Harness />);
    expect(press("=").defaultPrevented).toBe(false);
    expect(press("0").defaultPrevented).toBe(false);
  });

  it("leaves the combos to an extension's open native dialog", () => {
    const commands = mountInDevelop();
    render(
      <dialog open>
        <input aria-label="Coordinates" />
      </dialog>,
    );
    const e = new KeyboardEvent("keydown", { key: "=", ctrlKey: true, cancelable: true, bubbles: true });
    act(() => {
      screen.getByLabelText("Coordinates").dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(false);
    expect(commands.zoomStep).not.toHaveBeenCalled();
  });
});

describe("an extension shortcut whose handler throws", () => {
  it("is caught, and after repeated throws is switched off and listed against the extension", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const uncaught = vi.fn();
    window.addEventListener("error", uncaught);
    const second = vi.fn();
    const broken = vi.fn(() => {
      throw new Error("broken handler");
    });
    registerExtensionAction("acme.broken", { id: "acme.broken.run", label: "Run", defaultCombo: "Ctrl+Alt+K", handler: broken });
    registerExtensionAction("acme.ok", { id: "acme.ok.run", label: "Run", defaultCombo: "Ctrl+Alt+J", handler: second });
    render(<Harness />);
    const send = (key: string) => {
      const e = new KeyboardEvent("keydown", { key, ctrlKey: true, altKey: true, cancelable: true });
      window.dispatchEvent(e);
      return e;
    };
    try {
      for (let i = 0; i <= CALLBACK_FAILURE_LIMIT; i++) send("k");
      send("j");
      expect(uncaught).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
      expect(broken).toHaveBeenCalledTimes(CALLBACK_FAILURE_LIMIT);
      expect(useCallbackFailures.getState()["acme.broken"]?.kind).toBe("keyboard shortcut");
    } finally {
      window.removeEventListener("error", uncaught);
      unregisterExtensionActions("acme.broken");
      unregisterExtensionActions("acme.ok");
      forgetCallbackFailures("acme.broken");
    }
  });
});

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const INITIAL_CATALOG = useCatalogStore.getState();
const INITIAL_UI = useUIStore.getState();
const INITIAL_DEVELOP = useDevelopStore.getState();
const INITIAL_SETTINGS = useSettings.getState();

const MODIFIERS = [
  ["Ctrl+", "ctrlKey"],
  ["Shift+", "shiftKey"],
  ["Alt+", "altKey"],
] as const;

/** The live combo of a built-in action, so a changed default fails loudly here
 *  instead of leaving a spec pressing a dead key. */
function bound(actionId: string): string {
  if (!KEY_ACTIONS.some((a) => a.id === actionId))
    throw new Error(`no key action "${actionId}"`);
  return getBinding(actionId);
}

function keyInit(combo: string): KeyboardEventInit {
  const init: KeyboardEventInit = { bubbles: true, cancelable: true };
  let key = combo;
  for (let more = true; more; ) {
    more = false;
    for (const [prefix, flag] of MODIFIERS) {
      if (key.length > prefix.length && key.startsWith(prefix)) {
        init[flag] = true;
        key = key.slice(prefix.length);
        more = true;
      }
    }
  }
  return { ...init, key };
}

/** Dispatches a keydown at `target`; true when a handler consumed it. */
function fire(target: EventTarget, combo: string): boolean {
  const event = new KeyboardEvent("keydown", keyInit(combo));
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

const dev = (): DevelopState => useDevelopStore.getState();

function resetStores(): void {
  useCatalogStore.setState(INITIAL_CATALOG, true);
  useUIStore.setState(INITIAL_UI, true);
  useDevelopStore.setState(INITIAL_DEVELOP, true);
  useSettings.setState(INITIAL_SETTINGS, true);
}

describe("Esc exits one layer at a time", () => {
  let unregister: (() => void) | null = null;

  const layers = () => ({
    canvasTool: canvasHeld(),
    picking: usePickDragStore.getState().held !== null,
  });

  beforeEach(() => {
    useUIStore.setState({ activeModule: "develop" });
    render(<Harness />);
  });
  afterEach(() => {
    unregister?.();
    unregister = null;
    resetShortcutHoldsForTests();
    usePickDragStore.setState({ held: null });
    useCanvasToolStore.setState({ held: null });
    resetStores();
  });

  it("works down the chain: modal, canvas tool, pick tool", () => {
    const modal = vi.fn();
    unregister = pushEscapeHandler(modal);
    holdCanvas();
    setPickDrag("acme", { onDown: () => {}, onMove: () => {}, onUp: () => {} });

    expect(fire(window, "Escape"), "modal").toBe(true);
    expect(modal).toHaveBeenCalledTimes(1);
    expect(layers()).toEqual({
      canvasTool: true,
      picking: true,
    });

    unregister();
    unregister = null;
    expect(fire(window, "Escape"), "canvas tool").toBe(true);
    expect(layers()).toEqual({
      canvasTool: false,
      picking: true,
    });

    expect(fire(window, "Escape"), "pick tool").toBe(true);
    expect(layers()).toEqual({
      canvasTool: false,
      picking: false,
    });

    expect(fire(window, "Escape"), "nothing left").toBe(false);
  });

  it("does not consume Esc when there is nothing to exit", () => {
    expect(fire(window, "Escape")).toBe(false);
    expect(layers()).toEqual({
      canvasTool: false,
      picking: false,
    });
  });

  it("closes a modal and lets go of the canvas tool from a focused text field", () => {
    render(<input aria-label="Caption" />);
    const field = screen.getByLabelText("Caption");
    const modal = vi.fn();
    unregister = pushEscapeHandler(modal);
    expect(fire(field, "Escape")).toBe(true);
    expect(modal).toHaveBeenCalledTimes(1);

    unregister();
    unregister = null;
    holdCanvas();
    expect(fire(field, "Escape")).toBe(true);
    expect(canvasHeld()).toBe(false);
  });

  it("leaves Esc to a focused text field when there is nothing to exit", () => {
    render(<input aria-label="Caption" />);
    expect(fire(screen.getByLabelText("Caption"), "Escape")).toBe(false);
  });

  it("leaves Esc to a Slider's value field, which reverts the value and keeps the tool", () => {
    function Held() {
      const [value, setValue] = useState(25);
      return <Slider label="Exposure" value={value} min={-100} max={100} onChange={setValue} />;
    }
    render(<Held />);
    const field = screen.getByLabelText<HTMLInputElement>("Exposure value");
    const modal = vi.fn();
    unregister = pushEscapeHandler(modal);
    holdCanvas();
    act(() => field.focus());
    fireEvent.change(field, { target: { value: "40" } });

    expect(fire(field, "Escape")).toBe(false);

    expect(field.value).toBe("+25");
    expect(canvasHeld()).toBe(true);
    expect(modal).not.toHaveBeenCalled();
  });

  it("closes an open context menu before leaving the canvas tool", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={[{ label: "Open", onClick: () => {} }]} onClose={onClose} />);
    holdCanvas();

    expect(fire(window, "Escape")).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(canvasHeld()).toBe(true);
  });

  it("leaves Esc to any editable field that opts in with data-own-escape", () => {
    render(<input aria-label="Caption" data-own-escape="" />);
    holdCanvas();
    expect(fire(screen.getByLabelText("Caption"), "Escape")).toBe(false);
    expect(canvasHeld()).toBe(true);
  });

  it("leaves Esc to an extension's open native dialog, which closes itself", () => {
    render(
      <dialog open>
        <input aria-label="Coordinates" />
        <button type="button">Cancel</button>
      </dialog>,
    );
    holdCanvas();
    expect(fire(screen.getByLabelText("Coordinates"), "Escape")).toBe(false);
    expect(fire(screen.getByRole("button", { name: "Cancel" }), "Escape")).toBe(false);
    expect(canvasHeld()).toBe(true);
  });

  it("stands down while the shortcut editor is capturing a combo", () => {
    holdCanvas();
    suspendShortcuts();
    expect(fire(window, "Escape")).toBe(false);
    expect(canvasHeld()).toBe(true);
  });
});

describe("Develop arrow keys and rotate next to a culling surface", () => {
  const rotatePhotos = vi.fn(
    async (_ids: string[], _deg: number): Promise<void> => {},
  );
  const photos: CatalogPhoto[] = ["a", "b", "c"].map((id) => photo(id));
  const active = (): string | null => useCatalogStore.getState().activePhotoId;

  beforeEach(() => {
    vi.stubGlobal("BroadcastChannel", SilentChannel);
    rotatePhotos.mockClear();
    useUIStore.setState({
      activeModule: "develop",
      sortField: "filename",
      sortDirection: "asc",
      activeFolder: null,
      filter: NO_FILTER,
    });
    useCatalogStore.setState({
      photos,
      selectedIds: new Set(["a"]),
      activePhotoId: "a",
      rotatePhotos,
    });
    render(<Harness />);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetStores();
  });

  it("steps to the next photo on its own when no culling surface is mounted", () => {
    expect(fire(window, bound("photo.next"))).toBe(true);
    expect(active()).toBe("b");
  });

  it("steps to the previous photo on its own when no culling surface is mounted", () => {
    useCatalogStore.setState({ activePhotoId: "c", selectedIds: new Set(["c"]) });
    expect(fire(window, bound("photo.prev"))).toBe(true);
    expect(active()).toBe("b");
  });

  it("leaves the step to the culling handler while a surface is mounted", () => {
    renderHook(() => useCullingShortcuts());
    expect(fire(window, bound("photo.next"))).toBe(true);
    expect(active()).toBe("b");
  });

  it("rotates the selection once with no culling surface", () => {
    expect(fire(window, bound("photo.rotateCW"))).toBe(true);
    expect(rotatePhotos).toHaveBeenCalledTimes(1);
    expect(rotatePhotos).toHaveBeenCalledWith(["a"], 90);
  });

  it("leaves rotate to the culling handler while a surface is mounted", () => {
    renderHook(() => useCullingShortcuts());
    expect(fire(window, bound("photo.rotateCCW"))).toBe(true);
    expect(rotatePhotos).toHaveBeenCalledTimes(1);
    expect(rotatePhotos).toHaveBeenCalledWith(["a"], -90);
  });

  it("does not step photos outside Develop", () => {
    useUIStore.setState({ activeModule: "library" });
    expect(fire(window, bound("photo.next"))).toBe(false);
    expect(active()).toBe("a");
  });

  it("leaves the arrow keys to a focused slider", () => {
    render(<input type="range" aria-label="Exposure" />);
    expect(fire(screen.getByLabelText("Exposure"), bound("photo.next"))).toBe(false);
    expect(active()).toBe("a");
  });

  it("leaves Option+[ to a text field on a Mac, where it types a quote", () => {
    Object.defineProperty(window, "safelightNative", { value: { platform: "darwin" }, configurable: true });
    try {
      render(<input aria-label="Keywords" />);
      const e = new KeyboardEvent("keydown", { key: "“", code: "BracketLeft", altKey: true, bubbles: true, cancelable: true });
      act(() => {
        screen.getByLabelText("Keywords").dispatchEvent(e);
      });
      expect(e.defaultPrevented).toBe(false);
      expect(rotatePhotos).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window, "safelightNative");
    }
  });
});

describe("modifier combos in a text field", () => {
  const undo = vi.fn();
  const onAction = vi.fn(() => true);

  beforeEach(() => {
    undo.mockClear();
    onAction.mockClear();
    useUIStore.setState({ activeModule: "develop" });
    useDevelopStore.setState({ undo });
    render(<Harness />);
    render(<input aria-label="Caption" />);
  });
  afterEach(() => {
    useCanvasToolStore.setState({ held: null });
    resetStores();
  });

  it("leave Ctrl+Z and Cmd+Z to the field's own undo", () => {
    const field = screen.getByLabelText("Caption");
    expect(fire(field, "Ctrl+z")).toBe(false);
    const cmdZ = new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      field.dispatchEvent(cmdZ);
    });
    expect(cmdZ.defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();
  });

  it("still undo with Ctrl+Z outside a field", () => {
    expect(fire(document.body, "Ctrl+z")).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("leave Ctrl+Z to the field on a non-Latin layout, where the key is not a Latin letter", () => {
    const russianCtrlZ = (): KeyboardEvent =>
      new KeyboardEvent("keydown", { key: "я", code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true });
    const inField = russianCtrlZ();
    act(() => {
      screen.getByLabelText("Caption").dispatchEvent(inField);
    });
    expect(inField.defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();

    const outside = russianCtrlZ();
    act(() => {
      document.body.dispatchEvent(outside);
    });
    expect(outside.defaultPrevented).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("leave a Windows AltGr character to the field rather than its bare binding", () => {
    setCanvasTool("acme.heal", { overlay: () => null, onAction });
    const altGr = new KeyboardEvent("keydown", { key: "[", code: "Digit8", ctrlKey: true, altKey: true, modifierAltGraph: true, bubbles: true, cancelable: true });
    act(() => {
      screen.getByLabelText("Caption").dispatchEvent(altGr);
    });
    expect(altGr.defaultPrevented).toBe(false);
    expect(onAction).not.toHaveBeenCalled();
  });

  describe("an extension's Ctrl+Alt+letter", () => {
    const run = vi.fn();
    beforeEach(() => {
      run.mockClear();
      registerExtensionAction("acme.tool", { id: "acme.tool.run", label: "Run", defaultCombo: "Ctrl+Alt+K", handler: run });
    });
    afterEach(() => unregisterExtensionActions("acme.tool"));

    const inField = (init: KeyboardEventInit): KeyboardEvent => {
      const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      act(() => {
        screen.getByLabelText("Caption").dispatchEvent(e);
      });
      return e;
    };

    it("fires on Windows, also on a layout that reports AltGr for Ctrl+Alt", () => {
      expect(inField({ key: "k", code: "KeyK", ctrlKey: true, altKey: true }).defaultPrevented).toBe(true);
      expect(inField({ key: "k", code: "KeyK", ctrlKey: true, altKey: true, modifierAltGraph: true }).defaultPrevented).toBe(true);
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("fires on Linux, where AltGr is a key of its own", () => {
      expect(inField({ key: "k", code: "KeyK", ctrlKey: true, altKey: true }).defaultPrevented).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("leaves a letter typed with Windows AltGr (Polish ą) to the field", () => {
      const e = inField({ key: "ą", code: "KeyA", ctrlKey: true, altKey: true, modifierAltGraph: true });
      expect(e.defaultPrevented).toBe(false);
    });

    it("leaves a letter typed with Linux AltGr (Polish ł) to the field", () => {
      const e = inField({ key: "ł", code: "KeyL", modifierAltGraph: true });
      expect(e.defaultPrevented).toBe(false);
      expect(run).not.toHaveBeenCalled();
    });
  });
});

describe("the single-key shortcuts preference", () => {
  const requestFullscreen = vi.fn(async (): Promise<void> => {});

  beforeEach(() => {
    requestFullscreen.mockClear();
    document.documentElement.requestFullscreen = requestFullscreen;
    registerEssentialModules();
    useUIStore.setState({ activeModule: "develop" });
    useDevelopStore.setState({ showClipping: 0 });
    render(<Harness />);
  });
  afterEach(() => {
    Reflect.deleteProperty(document.documentElement, "requestFullscreen");
    resetBinding("module.library");
    resetStores();
  });

  it("switches module and goes fullscreen on bare keys while it is on", () => {
    useSettings.setState({ singleKeyShortcuts: true });
    expect(fire(window, bound("module.library"))).toBe(true);
    expect(useUIStore.getState().activeModule).toBe("library");
    expect(fire(window, bound("module.develop"))).toBe(true);
    expect(useUIStore.getState().activeModule).toBe("develop");
    expect(fire(window, bound("view.fullscreen"))).toBe(true);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("leaves the module as it is when the one a key names isn't there", () => {
    useSettings.setState({ singleKeyShortcuts: true });
    unregisterEssentialModules();
    useUIStore.setState({ activeModule: "map" });
    fire(window, bound("module.library"));
    fire(window, bound("module.develop"));
    expect(useUIStore.getState().activeModule).toBe("map");
  });

  it("ignores the Library key while it is off", () => {
    useSettings.setState({ singleKeyShortcuts: false });
    expect(fire(window, bound("module.library"))).toBe(false);
    expect(useUIStore.getState().activeModule).toBe("develop");
  });

  it("ignores the Develop key while it is off", () => {
    useSettings.setState({ singleKeyShortcuts: false });
    useUIStore.setState({ activeModule: "library" });
    expect(fire(window, bound("module.develop"))).toBe(false);
    expect(useUIStore.getState().activeModule).toBe("library");
  });

  it("ignores the fullscreen key while it is off", () => {
    useSettings.setState({ singleKeyShortcuts: false });
    expect(fire(window, bound("view.fullscreen"))).toBe(false);
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it("still honours a module key rebound to a modifier combo while it is off", () => {
    useSettings.setState({ singleKeyShortcuts: false });
    setBinding("module.library", "Ctrl+G");
    expect(fire(window, "Ctrl+G")).toBe(true);
    expect(useUIStore.getState().activeModule).toBe("library");
  });

  it("does not gate other bare keys", () => {
    useSettings.setState({ singleKeyShortcuts: false });
    expect(fire(window, bound("develop.toggleClipping"))).toBe(true);
    expect(dev().showClipping).toBe(7);
  });
});

// Soft proofing is a version 3 feature: on a photo without it the key does nothing,
// as the Proof button isn't there, so the flag can't flip out of sight.
describe("develop.toggleProof", () => {
  const openPhotoAs = (processVersion: number) =>
    useDevelopStore.setState({ params: normalizeParams({ processVersion }) });

  beforeEach(() => {
    useUIStore.setState({ activeModule: "develop" });
    openPhotoAs(3);
    render(<Harness />);
  });
  afterEach(resetStores);

  it("toggles the soft proof on a version 3 photo", () => {
    expect(fire(window, bound("develop.toggleProof"))).toBe(true);
    expect(dev().proof).toBe(true);
    expect(fire(window, bound("develop.toggleProof"))).toBe(true);
    expect(dev().proof).toBe(false);
  });

  it.each([1, 2])("leaves the flag and the key alone on a version %i photo", (version) => {
    openPhotoAs(version);
    expect(fire(window, bound("develop.toggleProof"))).toBe(false);
    expect(dev().proof).toBe(false);
  });

  it("is a bare key the single-key preference doesn't gate", () => {
    useSettings.setState({ singleKeyShortcuts: false });
    expect(fire(window, bound("develop.toggleProof"))).toBe(true);
    expect(dev().proof).toBe(true);
  });

  it("lets the key through outside Develop", () => {
    useUIStore.setState({ activeModule: "library" });
    expect(fire(window, bound("develop.toggleProof"))).toBe(false);
    expect(dev().proof).toBe(false);
  });
});

describe("a held canvas tool's shortcut actions", () => {
  beforeEach(() => {
    useUIStore.setState({ activeModule: "develop" });
    render(<Harness />);
  });
  afterEach(() => {
    useCanvasToolStore.setState({ held: null });
    resetStores();
  });

  it("go to the tool", () => {
    const onAction = vi.fn(() => true);
    setCanvasTool("acme.heal", { overlay: () => null, onAction });
    expect(fire(window, bound("brush.larger"))).toBe(true);
    expect(fire(window, bound("mask.delete"))).toBe(true);
    expect(onAction.mock.calls).toEqual([["brush.larger"], ["mask.delete"]]);
  });

  it("let the key through when the tool doesn't take them, or none is held", () => {
    expect(fire(window, bound("brush.larger"))).toBe(false);
    expect(fire(window, "Backspace")).toBe(false);
    setCanvasTool("acme.crop", { overlay: () => null, onAction: () => false });
    expect(fire(window, bound("mask.delete"))).toBe(false);
  });
});

describe("hiding one side of panels", () => {
  const SIDES = [
    ["panels.toggleLeft", "left"],
    ["panels.toggleRight", "right"],
    ["panels.toggleBottom", "bottom"],
  ] as const;

  beforeEach(() => {
    useDockStore.setState({
      hidden: { left: false, right: false, bottom: false, floating: false },
    });
  });
  afterEach(() => {
    for (const [id] of SIDES) resetBinding(id);
  });

  it.each(SIDES)("%s ships unbound", (id) => {
    expect(bound(id)).toBe("");
  });

  it.each(SIDES)("%s hides and shows the %s side once bound", (id, side) => {
    setBinding(id, "F7");
    render(<Harness />);
    expect(fire(window, "F7")).toBe(true);
    expect(useDockStore.getState().hidden).toEqual({
      left: false,
      right: false,
      bottom: false,
      floating: false,
      [side]: true,
    });
    expect(fire(window, "F7")).toBe(true);
    expect(useDockStore.getState().hidden[side]).toBe(false);
  });

  it("leaves Tab hiding every panel", () => {
    render(<Harness />);
    expect(fire(window, bound("panels.toggle"))).toBe(true);
    expect(useDockStore.getState().hidden).toEqual({
      left: true,
      right: true,
      bottom: true,
      floating: true,
    });
  });
});

describe("app.reportIssue", () => {
  afterEach(() => {
    resetBinding("app.reportIssue");
    act(() => closeReportIssue());
  });

  it("ships unbound", () => {
    expect(bound("app.reportIssue")).toBe("");
  });

  it("opens Report an issue once the user binds it", async () => {
    setBinding("app.reportIssue", "Ctrl+Alt+R");
    render(<Harness />);
    expect(fire(window, "Ctrl+Alt+R")).toBe(true);
    await act(async () => {});
    expect(useReportIssue.getState().open).toBe(true);
  });
});
