// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The zoom quartet routes through the central rebindable-shortcut handler to
// whichever viewport is currently registered; with no viewport mounted the
// combos must fall through untouched (no preventDefault) so nothing swallows
// keys in modules without an image on screen. The later blocks characterise
// the rest of the handler: the Esc chain, Develop's arrow keys and rotate next
// to a culling surface, the single-key preference, and tool-scoped mask.delete.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import type { CatalogPhoto } from "@/catalog/types";
import { photo } from "@/catalog/stored-edit.fixtures";
import { useKeyboardShortcuts } from "./use-keyboard-shortcuts";
import { NO_FILTER } from "@/modules/library/visible-photos";
import { useCullingShortcuts } from "@/modules/library/use-culling-shortcuts";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore, type DevelopState } from "@/state/develop-store";
import {
  KEY_ACTIONS,
  getBinding,
  resetBinding,
  setBinding,
  setShortcutsSuspended,
} from "@/state/keybindings-store";
import { useSettings } from "@/state/settings-store";
import { useUIStore } from "@/state/ui-store";
import { pushEscapeHandler } from "@/ui/escape-stack";
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
    cropping: dev().cropping,
    wbPicking: dev().wbPicking,
    guidedEditing: dev().guidedEditing,
    activeTool: dev().activeTool,
    selectedSpotId: dev().selectedSpotId,
    selectedMaskId: dev().selectedMaskId,
    selectedComponentId: dev().selectedComponentId,
  });

  beforeEach(() => {
    useUIStore.setState({ activeModule: "develop" });
    render(<Harness />);
  });
  afterEach(() => {
    unregister?.();
    unregister = null;
    setShortcutsSuspended(false);
    resetStores();
  });

  it("works down the chain: modal, crop, WB picker, guided overlay, tool, mask selection", () => {
    const modal = vi.fn();
    unregister = pushEscapeHandler(modal);
    useDevelopStore.setState({
      cropping: true,
      wbPicking: true,
      params: { ...dev().params, uprightMode: "guided" },
      guidedEditing: true,
      activeTool: "mask",
      selectedSpotId: "s1",
      selectedMaskId: "m1",
      selectedComponentId: "c1",
      hoveredMaskId: "m1",
    });

    expect(fire(window, "Escape"), "modal").toBe(true);
    expect(modal).toHaveBeenCalledTimes(1);
    expect(layers()).toEqual({
      cropping: true,
      wbPicking: true,
      guidedEditing: true,
      activeTool: "mask",
      selectedSpotId: "s1",
      selectedMaskId: "m1",
      selectedComponentId: "c1",
    });

    unregister();
    unregister = null;
    expect(fire(window, "Escape"), "crop").toBe(true);
    expect(layers()).toEqual({
      cropping: false,
      wbPicking: true,
      guidedEditing: true,
      activeTool: "mask",
      selectedSpotId: "s1",
      selectedMaskId: "m1",
      selectedComponentId: "c1",
    });

    expect(fire(window, "Escape"), "WB picker").toBe(true);
    expect(layers()).toEqual({
      cropping: false,
      wbPicking: false,
      guidedEditing: true,
      activeTool: "mask",
      selectedSpotId: "s1",
      selectedMaskId: "m1",
      selectedComponentId: "c1",
    });

    expect(fire(window, "Escape"), "guided overlay").toBe(true);
    expect(dev().params.uprightMode).toBe("guided");
    expect(layers()).toEqual({
      cropping: false,
      wbPicking: false,
      guidedEditing: false,
      activeTool: "mask",
      selectedSpotId: "s1",
      selectedMaskId: "m1",
      selectedComponentId: "c1",
    });

    expect(fire(window, "Escape"), "tool").toBe(true);
    expect(layers()).toEqual({
      cropping: false,
      wbPicking: false,
      guidedEditing: false,
      activeTool: "none",
      selectedSpotId: null,
      selectedMaskId: "m1",
      selectedComponentId: "c1",
    });

    expect(fire(window, "Escape"), "mask selection").toBe(true);
    expect(layers()).toEqual({
      cropping: false,
      wbPicking: false,
      guidedEditing: false,
      activeTool: "none",
      selectedSpotId: null,
      selectedMaskId: null,
      selectedComponentId: null,
    });
    expect(dev().hoveredMaskId).toBeNull();

    expect(fire(window, "Escape"), "nothing left").toBe(false);
  });

  it("closes the guided overlay only while guided is the upright mode", () => {
    useDevelopStore.setState({
      params: { ...dev().params, uprightMode: "auto" },
      guidedEditing: true,
    });
    expect(fire(window, "Escape")).toBe(false);
    expect(dev().guidedEditing).toBe(true);

    useDevelopStore.setState({ params: { ...dev().params, uprightMode: "guided" } });
    expect(fire(window, "Escape")).toBe(true);
    expect(dev().guidedEditing).toBe(false);
    expect(dev().params.uprightMode).toBe("guided");
  });

  it.each([
    ["only a mask", "m1", null],
    ["only a component", null, "c1"],
  ])("clears the selection when %s is selected", (_case, maskId, componentId) => {
    useDevelopStore.setState({
      selectedMaskId: maskId,
      selectedComponentId: componentId,
      hoveredMaskId: "m1",
    });
    expect(fire(window, "Escape")).toBe(true);
    expect(layers().selectedMaskId).toBeNull();
    expect(layers().selectedComponentId).toBeNull();
    expect(dev().hoveredMaskId).toBeNull();
  });

  it("does not consume Esc when there is nothing to exit", () => {
    expect(fire(window, "Escape")).toBe(false);
    expect(layers()).toEqual({
      cropping: false,
      wbPicking: false,
      guidedEditing: false,
      activeTool: "none",
      selectedSpotId: null,
      selectedMaskId: null,
      selectedComponentId: null,
    });
  });

  it("closes a modal and exits crop from a focused text field", () => {
    render(<input aria-label="Caption" />);
    const field = screen.getByLabelText("Caption");
    const modal = vi.fn();
    unregister = pushEscapeHandler(modal);
    expect(fire(field, "Escape")).toBe(true);
    expect(modal).toHaveBeenCalledTimes(1);

    unregister();
    unregister = null;
    useDevelopStore.setState({ cropping: true });
    expect(fire(field, "Escape")).toBe(true);
    expect(dev().cropping).toBe(false);
  });

  it("leaves Esc to a focused text field when there is nothing to exit", () => {
    render(<input aria-label="Caption" />);
    expect(fire(screen.getByLabelText("Caption"), "Escape")).toBe(false);
  });

  it("stands down while the shortcut editor is capturing a combo", () => {
    useDevelopStore.setState({ cropping: true });
    setShortcutsSuspended(true);
    expect(fire(window, "Escape")).toBe(false);
    expect(dev().cropping).toBe(true);
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
});

describe("the single-key shortcuts preference", () => {
  const requestFullscreen = vi.fn(async (): Promise<void> => {});

  beforeEach(() => {
    requestFullscreen.mockClear();
    document.documentElement.requestFullscreen = requestFullscreen;
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
    expect(dev().showClipping).toBe(3);
  });
});

describe("mask.delete in Develop", () => {
  type MaskSelection = Pick<
    DevelopState,
    "activeTool" | "selectedMaskId" | "selectedComponentId"
  >;
  const removeComponent = vi.fn((_maskId: string, _componentId: string): void => {});
  const commitEdit = vi.fn(async (_label: string): Promise<void> => {});

  beforeEach(() => {
    removeComponent.mockClear();
    commitEdit.mockClear();
    useUIStore.setState({ activeModule: "develop" });
    useDevelopStore.setState({ removeComponent, commitEdit });
    render(<Harness />);
  });
  afterEach(resetStores);

  it("removes the selected component and commits once the mask tool has both", () => {
    useDevelopStore.setState({
      activeTool: "mask",
      selectedMaskId: "m1",
      selectedComponentId: "c1",
    });
    expect(fire(window, bound("mask.delete"))).toBe(true);
    expect(removeComponent).toHaveBeenCalledTimes(1);
    expect(removeComponent).toHaveBeenCalledWith("m1", "c1");
    expect(commitEdit).toHaveBeenCalledTimes(1);
    expect(commitEdit).toHaveBeenCalledWith("Delete Component");
  });

  it("answers the Backspace alias too", () => {
    useDevelopStore.setState({
      activeTool: "mask",
      selectedMaskId: "m1",
      selectedComponentId: "c1",
    });
    expect(fire(window, "Backspace")).toBe(true);
    expect(removeComponent).toHaveBeenCalledWith("m1", "c1");
  });

  it.each<[string, MaskSelection]>([
    [
      "the mask tool has no component selected",
      { activeTool: "mask", selectedMaskId: "m1", selectedComponentId: null },
    ],
    [
      "the mask tool has no mask selected",
      { activeTool: "mask", selectedMaskId: null, selectedComponentId: "c1" },
    ],
    [
      "a component is selected but the tool is not the mask tool",
      { activeTool: "none", selectedMaskId: "m1", selectedComponentId: "c1" },
    ],
  ])("lets the key through untouched when %s", (_case, selection) => {
    useDevelopStore.setState(selection);
    expect(fire(window, bound("mask.delete"))).toBe(false);
    expect(removeComponent).not.toHaveBeenCalled();
    expect(commitEdit).not.toHaveBeenCalled();
  });
});
