// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The culling keys are a capture-phase window listener, so unlike the native
// confirm they replaced, an open in-app dialog does not stop them: the first
// block pins that the shortcuts stand down while one is showing. The later
// blocks characterise the rest of the handler: which photos a key acts on, the
// grid-row stride, text-field and mask-tool deference, and the ref-counted
// listener shared by every mounted photo surface.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CatalogPhoto, ColorLabel, FlagStatus } from "@/catalog/types";
import { photo } from "@/catalog/stored-edit.fixtures";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore, type DevelopState } from "@/state/develop-store";
import { KEY_ACTIONS, getBinding } from "@/state/keybindings-store";
import { useSettings } from "@/state/settings-store";
import { useUIStore } from "@/state/ui-store";
import { popEscapeHandler } from "@/ui/escape-stack";
import { alertDialog, ConfirmDialogHost } from "@/ui/components/ConfirmDialog";
import { NO_FILTER } from "./visible-photos";
import { cullingShortcutsMounted, useCullingShortcuts } from "./use-culling-shortcuts";

const removePhotos = vi.fn(async (_ids: string[]): Promise<void> => {});
const applyRating = vi.fn(
  async (_ids: string[], _rating: number): Promise<void> => {},
);

// Keys go to whatever holds focus, as in the app: the dialog's confirm button
// while a card is open, the body otherwise.
function press(key: string, init: KeyboardEventInit = {}): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
}

beforeEach(() => {
  removePhotos.mockClear();
  applyRating.mockClear();
  useCatalogStore.setState({
    photos: [photo("a"), photo("b")],
    selectedIds: new Set(["a"]),
    activePhotoId: "a",
    removePhotos,
    applyRating,
  });
  render(<ConfirmDialogHost />);
  renderHook(() => useCullingShortcuts());
});

// The dialog queue is module state: close whatever a spec left open (several
// end with a card showing) so it can't surface in the next one. Each close can
// mount the next queued card, so the escape stack is popped a few times.
afterEach(() => {
  for (let i = 0; i < 4; i++) act(() => void popEscapeHandler());
});

describe("culling shortcuts while an in-app dialog is open", () => {
  it("rates the selection when no dialog is open", () => {
    press("3");
    expect(applyRating).toHaveBeenCalledWith(["a"], 3);
  });

  it("pressing Delete twice opens one confirmation, not two", async () => {
    const user = userEvent.setup();
    press("Delete");
    screen.getByRole("dialog", { name: "Remove from catalog" });
    press("Delete");
    press("Delete", { repeat: true });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(removePhotos).not.toHaveBeenCalled();
  });

  it("still holds when focus has left the dialog", () => {
    press("Delete");
    screen.getByRole("dialog", { name: "Remove from catalog" });
    act(() => {
      (document.activeElement as HTMLElement).blur();
    });
    fireEvent.keyDown(document.body, { key: "Delete" });
    fireEvent.keyDown(document.body, { key: "3" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(applyRating).not.toHaveBeenCalled();
  });

  it("ignores a rating key while a confirmation is open", () => {
    press("Delete");
    screen.getByRole("dialog", { name: "Remove from catalog" });
    press("3");
    expect(applyRating).not.toHaveBeenCalled();
  });

  it("ignores a rating key while an alert is open", () => {
    act(() => {
      void alertDialog({ title: "Export data", message: "Done." });
    });
    screen.getByRole("alertdialog", { name: "Export data" });
    press("3");
    expect(applyRating).not.toHaveBeenCalled();
  });

  it("works again once the dialog is answered", async () => {
    const user = userEvent.setup();
    press("Delete");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(removePhotos).not.toHaveBeenCalled();

    press("3");
    expect(applyRating).toHaveBeenCalledWith(["a"], 3);

    press("Delete");
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(removePhotos).toHaveBeenCalledTimes(1);
    expect(removePhotos).toHaveBeenCalledWith(["a"]);
    expect(screen.queryByRole("dialog")).toBeNull();
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

function seed(
  photos: CatalogPhoto[],
  selected: string[],
  active: string | null,
): void {
  useCatalogStore.setState({
    photos,
    selectedIds: new Set(selected),
    activePhotoId: active,
  });
}

function labelled(id: string, colorLabel: ColorLabel): CatalogPhoto {
  return { ...photo(id), colorLabel };
}

describe("culling shortcuts: which photos a key acts on", () => {
  const applyColorLabel = vi.fn(
    async (_ids: string[], _label: ColorLabel): Promise<void> => {},
  );
  const applyFlag = vi.fn(
    async (_ids: string[], _flag: FlagStatus): Promise<void> => {},
  );

  beforeEach(() => {
    applyColorLabel.mockClear();
    applyFlag.mockClear();
    useCatalogStore.setState({ applyColorLabel, applyFlag });
  });
  afterEach(() => {
    useCatalogStore.setState(INITIAL_CATALOG, true);
  });

  it("rates the whole selection, ahead of the active photo", () => {
    seed([photo("a"), photo("b"), photo("c")], ["a", "b"], "c");
    expect(fire(document.body, bound("rate.3"))).toBe(true);
    expect(applyRating).toHaveBeenCalledTimes(1);
    expect(applyRating).toHaveBeenCalledWith(["a", "b"], 3);
  });

  it("rates the active photo when nothing is selected", () => {
    seed([photo("a"), photo("b"), photo("c")], [], "c");
    expect(fire(document.body, bound("rate.3"))).toBe(true);
    expect(applyRating).toHaveBeenCalledTimes(1);
    expect(applyRating).toHaveBeenCalledWith(["c"], 3);
  });

  it("does nothing, and leaves the key alone, with no selection and no active photo", () => {
    seed([photo("a"), photo("b")], [], null);
    expect(fire(document.body, bound("rate.3"))).toBe(false);
    expect(applyRating).not.toHaveBeenCalled();
  });

  it.each([
    ["rate.0", 0],
    ["rate.5", 5],
  ])("%s applies rating %i", (action, rating) => {
    seed([photo("a"), photo("b")], ["a"], "a");
    fire(document.body, bound(action));
    expect(applyRating).toHaveBeenCalledWith(["a"], rating);
  });

  it("clears the red label when every target already has it", () => {
    seed([labelled("a", "red"), labelled("b", "red"), photo("c")], ["a", "b"], "a");
    expect(fire(document.body, bound("label.red"))).toBe(true);
    expect(applyColorLabel).toHaveBeenCalledTimes(1);
    expect(applyColorLabel).toHaveBeenCalledWith(["a", "b"], "none");
  });

  it("sets the red label when the targets are mixed", () => {
    seed([labelled("a", "red"), photo("b")], ["a", "b"], "a");
    fire(document.body, bound("label.red"));
    expect(applyColorLabel).toHaveBeenCalledTimes(1);
    expect(applyColorLabel).toHaveBeenCalledWith(["a", "b"], "red");
  });

  it("sets the red label over a different label", () => {
    seed([labelled("a", "blue")], ["a"], "a");
    fire(document.body, bound("label.red"));
    expect(applyColorLabel).toHaveBeenCalledWith(["a"], "red");
  });

  it.each([
    ["flag.pick", "pick"],
    ["flag.reject", "reject"],
    ["flag.unflag", "none"],
  ] as const)("%s sets the flag %s on the selection", (action, flag) => {
    seed([photo("a"), photo("b")], ["a", "b"], "a");
    expect(fire(document.body, bound(action))).toBe(true);
    expect(applyFlag).toHaveBeenCalledWith(["a", "b"], flag);
  });
});

describe("culling shortcuts: removing from the catalog", () => {
  type MaskSelection = Pick<
    DevelopState,
    "activeTool" | "selectedMaskId" | "selectedComponentId"
  >;

  beforeEach(() => {
    useSettings.setState({ confirmRemovePhotos: true });
    useCatalogStore.setState({ selectedIds: new Set(["a", "b"]) });
  });
  afterEach(() => {
    useSettings.setState(INITIAL_SETTINGS, true);
    useDevelopStore.setState(INITIAL_DEVELOP, true);
  });

  it("leaves Delete to the mask tool while a mask component is selected", () => {
    useDevelopStore.setState({
      activeTool: "mask",
      selectedMaskId: "m1",
      selectedComponentId: "c1",
    });
    expect(fire(document.body, bound("photo.remove"))).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(removePhotos).not.toHaveBeenCalled();
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
  ])("still asks to remove when %s", (_case, selection) => {
    useDevelopStore.setState(selection);
    expect(fire(document.body, bound("photo.remove"))).toBe(true);
    screen.getByRole("dialog", { name: "Remove from catalog" });
    expect(removePhotos).not.toHaveBeenCalled();
  });

  it("removes nothing when the confirmation is cancelled, and asks again next time", async () => {
    const user = userEvent.setup();
    expect(fire(document.body, bound("photo.remove"))).toBe(true);
    screen.getByRole("dialog", { name: "Remove from catalog" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(removePhotos).not.toHaveBeenCalled();

    fire(document.body, bound("photo.remove"));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(removePhotos).toHaveBeenCalledTimes(1);
    expect(removePhotos).toHaveBeenCalledWith(["a", "b"]);
  });

  it("removes at once, with no dialog, when confirmation is switched off", () => {
    useSettings.setState({ confirmRemovePhotos: false });
    expect(fire(document.body, bound("photo.remove"))).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(removePhotos).toHaveBeenCalledTimes(1);
    expect(removePhotos).toHaveBeenCalledWith(["a", "b"]);
  });

  it("treats a bare Backspace as the same remove key", () => {
    expect(fire(document.body, "Backspace")).toBe(true);
    screen.getByRole("dialog", { name: "Remove from catalog" });
  });
});

describe("culling shortcuts: arrow keys", () => {
  const letters = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const active = (): string | null => useCatalogStore.getState().activePhotoId;

  beforeEach(() => {
    vi.stubGlobal("BroadcastChannel", SilentChannel);
    useUIStore.setState({
      sortField: "filename",
      sortDirection: "asc",
      activeFolder: null,
      filter: NO_FILTER,
    });
    seed(letters.map((id) => photo(id)), ["a"], "a");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useUIStore.setState(INITIAL_UI, true);
    useCatalogStore.setState(INITIAL_CATALOG, true);
  });

  it("ArrowDown moves a whole row at the grid's column count", () => {
    useUIStore.setState({ gridColumns: 4 });
    expect(fire(document.body, "ArrowDown")).toBe(true);
    expect(active()).toBe("e");
  });

  it("ArrowDown moves one photo when the grid has a single column", () => {
    useUIStore.setState({ gridColumns: 1 });
    fire(document.body, "ArrowDown");
    expect(active()).toBe("b");
  });

  it("ArrowDown stops at the last photo instead of overshooting", () => {
    useUIStore.setState({ gridColumns: 4 });
    seed(letters.map((id) => photo(id)), ["i"], "i");
    fire(document.body, "ArrowDown");
    expect(active()).toBe("j");
  });

  it("ArrowUp moves a row back, then stops at the first photo", () => {
    useUIStore.setState({ gridColumns: 4 });
    seed(letters.map((id) => photo(id)), ["f"], "f");
    fire(document.body, "ArrowUp");
    expect(active()).toBe("b");
    fire(document.body, "ArrowUp");
    expect(active()).toBe("a");
  });

  it("the next-photo key moves one photo whatever the column count", () => {
    useUIStore.setState({ gridColumns: 4 });
    expect(fire(document.body, bound("photo.next"))).toBe(true);
    expect(active()).toBe("b");
  });

  it("leaves the arrow keys to a focused slider", () => {
    render(<input type="range" aria-label="Exposure" />);
    expect(fire(screen.getByLabelText("Exposure"), bound("photo.next"))).toBe(false);
    expect(active()).toBe("a");
  });
});

describe("culling shortcuts: focus and select-all", () => {
  const rotatePhotos = vi.fn(
    async (_ids: string[], _deg: number): Promise<void> => {},
  );

  beforeEach(() => {
    rotatePhotos.mockClear();
    useCatalogStore.setState({ rotatePhotos });
  });
  afterEach(() => {
    useUIStore.setState(INITIAL_UI, true);
    useCatalogStore.setState(INITIAL_CATALOG, true);
  });

  it("ignores a bare key typed into a text field", () => {
    render(<input aria-label="Caption" />);
    expect(fire(screen.getByLabelText("Caption"), bound("rate.3"))).toBe(false);
    expect(applyRating).not.toHaveBeenCalled();
  });

  it("does not let a focused slider block a key", () => {
    render(<input type="range" aria-label="Exposure" />);
    expect(fire(screen.getByLabelText("Exposure"), bound("rate.3"))).toBe(true);
    expect(applyRating).toHaveBeenCalledWith(["a"], 3);
  });

  it("still runs a modifier combo typed into a text field", () => {
    render(<input aria-label="Caption" />);
    expect(fire(screen.getByLabelText("Caption"), bound("photo.rotateCW"))).toBe(true);
    expect(rotatePhotos).toHaveBeenCalledWith(["a"], 90);
  });

  it("leaves Ctrl+A to a text field's own select-all", () => {
    render(<input aria-label="Caption" />);
    expect(fire(screen.getByLabelText("Caption"), "Ctrl+a")).toBe(false);
    expect([...useCatalogStore.getState().selectedIds]).toEqual(["a"]);
  });

  it("selects only the visible photos on Ctrl+A over the grid", () => {
    useUIStore.setState({
      activeFolder: null,
      filter: { ...NO_FILTER, rating: 1, ratingOp: "gte" },
    });
    seed(
      [
        { ...photo("a"), rating: 3 },
        { ...photo("b"), rating: 0 },
        { ...photo("c"), rating: 5 },
      ],
      [],
      null,
    );
    expect(fire(document.body, "Ctrl+a")).toBe(true);
    expect([...useCatalogStore.getState().selectedIds].sort()).toEqual(["a", "c"]);
  });
});

describe("culling shortcuts: shared listener across surfaces", () => {
  it("applies one rating per key press with two surfaces mounted", () => {
    cleanup();
    renderHook(() => useCullingShortcuts());
    renderHook(() => useCullingShortcuts());
    fire(document.body, bound("rate.3"));
    expect(applyRating).toHaveBeenCalledTimes(1);
  });

  it("stays live while any surface is mounted and goes quiet with the last", () => {
    cleanup();
    const first = renderHook(() => useCullingShortcuts());
    const second = renderHook(() => useCullingShortcuts());
    expect(cullingShortcutsMounted()).toBe(true);

    first.unmount();
    expect(cullingShortcutsMounted()).toBe(true);
    expect(fire(document.body, bound("rate.3"))).toBe(true);
    expect(applyRating).toHaveBeenCalledTimes(1);

    second.unmount();
    expect(cullingShortcutsMounted()).toBe(false);
    expect(fire(document.body, bound("rate.3"))).toBe(false);
    expect(applyRating).toHaveBeenCalledTimes(1);
  });
});
