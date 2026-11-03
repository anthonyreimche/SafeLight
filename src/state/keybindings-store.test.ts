// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  comboFromEvent,
  comboFromWheelEvent,
  findConflicts,
  getBinding,
  initKeybindings,
  isBareKey,
  isEditableTarget,
  KEY_ACTIONS,
  listBindings,
  matchAction,
  matchExtensionAction,
  registerExtensionAction,
  resetAllBindings,
  resetBinding,
  setBinding,
  resetShortcutHoldsForTests,
  shortcutsSuspended,
  suspendShortcuts,
  unregisterExtensionActions,
  useExtensionActions,
  useKeybindings,
} from "./keybindings-store";

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}

interface Mods {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  /** Physical key (e.code); "" when the test doesn't care where the key sits. */
  code?: string;
  /** What getModifierState("AltGraph") reports: Windows AltGr arrives as Ctrl+Alt. */
  altGraph?: boolean;
}

// Only the fields comboFromEvent reads; a real KeyboardEvent needs a DOM.
function key(k: string, mods: Mods = {}): KeyboardEvent {
  return {
    key: k,
    code: mods.code ?? "",
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
    getModifierState: (m: string) => m === "AltGraph" && !!mods.altGraph,
  } as unknown as KeyboardEvent;
}

const onPlatform = (platform: string) =>
  vi.stubGlobal("window", { safelightNative: { platform } });

const overrides = () => useKeybindings.getState().overrides;

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  useKeybindings.setState({ overrides: {} });
  useExtensionActions.setState({ actions: new Map() });
  resetShortcutHoldsForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("comboFromEvent", () => {
  it("ignores a bare modifier press", () => {
    for (const k of ["Control", "Shift", "Alt", "Meta"]) {
      expect(comboFromEvent(key(k, { ctrl: true }))).toBeNull();
    }
  });

  it("uppercases single characters and passes named keys through", () => {
    expect(comboFromEvent(key("g"))).toBe("G");
    expect(comboFromEvent(key(","))).toBe(",");
    expect(comboFromEvent(key("ArrowLeft"))).toBe("ArrowLeft");
  });

  it("emits modifiers in Ctrl+Shift+Alt order", () => {
    expect(comboFromEvent(key("z", { ctrl: true, shift: true, alt: true }))).toBe(
      "Ctrl+Shift+Alt+Z",
    );
    expect(comboFromEvent(key("[", { shift: true }))).toBe("Shift+[");
  });

  it("folds Cmd into Ctrl so macOS bindings match the stored combos", () => {
    expect(comboFromEvent(key("z", { meta: true }))).toBe("Ctrl+Z");
  });
});

describe("keyboard layouts", () => {
  it("records a macOS Option combo by the physical key, not the composed character", () => {
    onPlatform("darwin");
    expect(comboFromEvent(key("“", { alt: true, code: "BracketLeft" }))).toBe("Alt+[");
    expect(comboFromEvent(key("©", { alt: true, code: "KeyG" }))).toBe("Alt+G");
  });

  it("rotates with Option+[ and Option+] on a US Mac", () => {
    onPlatform("darwin");
    expect(matchAction(key("“", { alt: true, code: "BracketLeft" }), ["Library"])).toBe("photo.rotateCCW");
    expect(matchAction(key("‘", { alt: true, code: "BracketRight" }), ["Library"])).toBe("photo.rotateCW");
  });

  it("takes German Mac Option+5 (which types [) as the bracket, not as rotate", () => {
    onPlatform("darwin");
    const optionFive = key("[", { alt: true, code: "Digit5" });
    expect(matchAction(optionFive, ["Library"])).toBeNull();
    expect(matchAction(optionFive, ["Develop"])).toBe("brush.smaller");
    expect(matchAction(key("•", { alt: true, code: "BracketLeft" }), ["Library"])).toBe("photo.rotateCCW");
  });

  it("leaves a typed Alt+[ alone off macOS", () => {
    onPlatform("win32");
    expect(matchAction(key("[", { alt: true, code: "BracketLeft" }), ["Library"])).toBe("photo.rotateCCW");
  });

  it("treats a Windows AltGr character as the bare key it types", () => {
    onPlatform("win32");
    const altGr = { ctrl: true, alt: true, altGraph: true };
    expect(matchAction(key("[", { ...altGr, code: "Digit8" }), ["Develop"])).toBe("brush.smaller");
    expect(matchAction(key("]", { ...altGr, code: "Digit9" }), ["Develop"])).toBe("brush.larger");
    expect(comboFromEvent(key("[", { ...altGr, code: "Digit8" }))).toBe("[");
  });

  it("keeps Ctrl+Alt when AltGraph is reported but the key types nothing extra", () => {
    onPlatform("win32");
    registerExtensionAction("ext.a", { id: "ext.a.run", label: "Run", defaultCombo: "Ctrl+Alt+1", handler: () => {} });
    expect(matchExtensionAction(key("1", { ctrl: true, alt: true, altGraph: true, code: "Digit1" }))?.id).toBe("ext.a.run");
  });

  it("still fires a Mac Option binding recorded as the composed character", () => {
    onPlatform("darwin");
    registerExtensionAction("ext.a", { id: "ext.a.run", label: "Run", defaultCombo: "", handler: () => {} });
    setBinding("ext.a.run", "Alt+©");
    expect(matchExtensionAction(key("©", { alt: true, code: "KeyG" }))?.id).toBe("ext.a.run");
  });

  it("takes a dead key by its physical key", () => {
    onPlatform("darwin");
    expect(comboFromEvent(key("Dead", { alt: true, code: "KeyE" }))).toBe("Alt+E");
    onPlatform("win32");
    expect(comboFromEvent(key("Dead", { code: "Quote" }))).toBe("'");
    expect(matchAction(key("Dead", { alt: true, code: "BracketLeft" }), ["Library"])).toBe("photo.rotateCCW");
  });

  it("keeps a deliberate Ctrl+Alt+letter on a layout with AltGr", () => {
    onPlatform("win32");
    const ctrlAltK = key("k", { ctrl: true, alt: true, altGraph: true, code: "KeyK" });
    expect(comboFromEvent(ctrlAltK)).toBe("Ctrl+Alt+K");
    expect(matchAction(ctrlAltK, ["General"])).toBeNull();
    registerExtensionAction("ext.a", { id: "ext.a.run", label: "Run", defaultCombo: "Ctrl+Alt+K", handler: () => {} });
    expect(matchExtensionAction(ctrlAltK)?.id).toBe("ext.a.run");
  });

  it("falls back to the digit row's position on AZERTY", () => {
    expect(matchAction(key("&", { code: "Digit1" }), ["Library"])).toBe("rate.1");
    expect(matchAction(key("à", { code: "Digit0" }), ["Library"])).toBe("rate.0");
    expect(matchAction(key("(", { code: "Digit5" }), ["Library"])).toBe("rate.5");
    expect(matchAction(key("ç", { code: "Digit9" }), ["Library"])).toBe("label.blue");
    expect(matchAction(key("&", { ctrl: true, code: "Digit1" }), ["Develop"])).toBe("develop.zoom100");
    expect(matchAction(key("à", { ctrl: true, code: "Digit0" }), ["Develop"])).toBe("develop.zoomFit");
  });

  it("matches an extension action by position too", () => {
    registerExtensionAction("ext.a", { id: "ext.a.run", label: "Run", defaultCombo: "Ctrl+Alt+1", handler: () => {} });
    expect(matchExtensionAction(key("&", { ctrl: true, alt: true, code: "Digit1" }))?.id).toBe("ext.a.run");
  });

  it("lets the typed key win over its position", () => {
    // AZERTY's 6 key types "-", which is a binding of its own.
    expect(matchAction(key("-", { code: "Digit6" }), ["Library"])).toBe("grid.smaller");
    // QWERTZ swaps Y and Z: the letters follow the label, not the position.
    expect(matchAction(key("z", { ctrl: true, code: "KeyY" }), ["Develop"])).toBe("develop.undo");
    expect(matchAction(key("y", { ctrl: true, code: "KeyZ" }), ["Develop"])).toBe("develop.redo");
  });

  it("falls back to the bracket position on QWERTZ", () => {
    expect(matchAction(key("ü", { code: "BracketLeft" }), ["Develop"])).toBe("brush.smaller");
  });

  it("falls back to letter positions only for non-Latin layouts", () => {
    expect(matchAction(key("п", { code: "KeyG" }), ["General"])).toBe("module.library");
    expect(matchAction(key("a", { code: "KeyG" }), ["General"])).toBeNull();
  });
});

// Only the four fields comboFromWheelEvent reads; a real WheelEvent needs a DOM.
function wheel(mods: Mods = {}): WheelEvent {
  return {
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
  } as unknown as WheelEvent;
}

describe("comboFromWheelEvent", () => {
  it("maps an unmodified roll to Wheel", () => {
    expect(comboFromWheelEvent(wheel())).toBe("Wheel");
  });

  it("prefixes held modifiers in Ctrl+Shift+Alt order", () => {
    expect(comboFromWheelEvent(wheel({ alt: true }))).toBe("Alt+Wheel");
    expect(comboFromWheelEvent(wheel({ ctrl: true, shift: true }))).toBe(
      "Ctrl+Shift+Wheel",
    );
  });

  it("folds Cmd into Ctrl, matching comboFromEvent", () => {
    expect(comboFromWheelEvent(wheel({ meta: true }))).toBe("Ctrl+Wheel");
  });
});

describe("zoom actions", () => {
  it("registers the wheel-zoom gesture with a bare-wheel default", () => {
    const a = KEY_ACTIONS.find((x) => x.id === "viewport.wheelZoom");
    expect(a).toMatchObject({ category: "General", def: "Wheel", kind: "wheel" });
    expect(getBinding("viewport.wheelZoom")).toBe("Wheel");
  });

  it("registers the Photoshop zoom quartet in the Develop scope", () => {
    const combo = (id: string) =>
      KEY_ACTIONS.find((x) => x.id === id && x.category === "Develop")?.def;
    expect(combo("develop.zoomIn")).toBe("Ctrl+=");
    expect(combo("develop.zoomOut")).toBe("Ctrl+-");
    expect(combo("develop.zoomFit")).toBe("Ctrl+0");
    expect(combo("develop.zoom100")).toBe("Ctrl+1");
  });

  it("matches the quartet combos through the normal action matcher", () => {
    expect(matchAction(key("=", { ctrl: true }), ["Develop"])).toBe("develop.zoomIn");
    expect(matchAction(key("-", { ctrl: true }), ["Develop"])).toBe("develop.zoomOut");
    expect(matchAction(key("0", { ctrl: true }), ["Develop"])).toBe("develop.zoomFit");
    expect(matchAction(key("1", { ctrl: true }), ["Develop"])).toBe("develop.zoom100");
  });

  it("accepts a rebound wheel combo like any other override", () => {
    setBinding("viewport.wheelZoom", "Alt+Wheel");
    expect(getBinding("viewport.wheelZoom")).toBe("Alt+Wheel");
    resetBinding("viewport.wheelZoom");
    expect(getBinding("viewport.wheelZoom")).toBe("Wheel");
  });
});

describe("isBareKey", () => {
  it("is true for an unmodified key and for the '+' key itself", () => {
    expect(isBareKey("G")).toBe(true);
    expect(isBareKey("ArrowLeft")).toBe(true);
    expect(isBareKey("+")).toBe(true);
  });

  it("is false for any modifier combo", () => {
    expect(isBareKey("Ctrl+Z")).toBe(false);
    expect(isBareKey("Shift+[")).toBe(false);
  });
});

describe("bindings", () => {
  it("reports the default until an override is stored", () => {
    expect(getBinding("develop.undo")).toBe("Ctrl+Z");
    setBinding("develop.undo", "Ctrl+Alt+Z");
    expect(getBinding("develop.undo")).toBe("Ctrl+Alt+Z");
  });

  it("returns an empty combo for an unknown action", () => {
    expect(getBinding("no.such.action")).toBe("");
  });

  it("stores no override when the user picks the default back", () => {
    setBinding("develop.undo", "Ctrl+Alt+Z");
    setBinding("develop.undo", "Ctrl+Z");
    expect(overrides()).toEqual({});
    expect(getBinding("develop.undo")).toBe("Ctrl+Z");
  });

  it("persists overrides for the other windows to pick up", () => {
    setBinding("module.library", "L");
    expect(JSON.parse(localStorage.getItem("sl_keybindings_v1") ?? "null")).toEqual({
      "module.library": "L",
    });
  });

  it("resets one action and all actions", () => {
    setBinding("module.library", "L");
    setBinding("module.develop", "E");
    resetBinding("module.library");
    expect(overrides()).toEqual({ "module.develop": "E" });
    resetAllBindings();
    expect(overrides()).toEqual({});
    expect(localStorage.getItem("sl_keybindings_v1")).toBe("{}");
  });

  it("lists every action with its current combo", () => {
    setBinding("module.library", "L");
    const list = listBindings();
    expect(list).toHaveLength(KEY_ACTIONS.length);
    expect(list.find((b) => b.id === "module.library")).toEqual({
      id: "module.library",
      label: "Go to Library",
      category: "General",
      combo: "L",
    });
    expect(list.find((b) => b.id === "photo.deleteDisk")?.combo).toBe("");
  });
});

describe("matchAction", () => {
  it("matches a default combo only inside the requested scopes", () => {
    expect(matchAction(key("j"), ["Develop"])).toBe("develop.toggleClipping");
    expect(matchAction(key("j"), ["Library"])).toBeNull();
    expect(matchAction(key("j"), ["Library", "Develop"])).toBe("develop.toggleClipping");
  });

  it("binds S to the soft proof in Develop only", () => {
    expect(matchAction(key("s"), ["Develop"])).toBe("develop.toggleProof");
    expect(matchAction(key("s"), ["Library"])).toBeNull();
    expect(matchAction(key("s"), ["General"])).toBeNull();
  });

  it("resolves the same combo to a different action per module", () => {
    // Delete is mask-component removal in Develop and catalog removal in Library.
    expect(matchAction(key("Delete"), ["Develop"])).toBe("mask.delete");
    expect(matchAction(key("Delete"), ["Library"])).toBe("photo.remove");
  });

  it("follows an override and stops matching the old combo", () => {
    setBinding("develop.toggleClipping", "Ctrl+Alt+J");
    expect(matchAction(key("j"), ["Develop"])).toBeNull();
    expect(matchAction(key("j", { ctrl: true, alt: true }), ["Develop"])).toBe(
      "develop.toggleClipping",
    );
  });

  it("honours a built-in alias while the action is unbound", () => {
    expect(matchAction(key("y", { ctrl: true }), ["Develop"])).toBe("develop.redo");
    expect(matchAction(key("Backspace"), ["Library"])).toBe("photo.remove");
  });

  it("drops the alias once the user rebinds the action", () => {
    setBinding("develop.redo", "Ctrl+Alt+R");
    expect(matchAction(key("y", { ctrl: true }), ["Develop"])).toBeNull();
  });

  it("binds the app commands", () => {
    expect(matchAction(key("o", { ctrl: true }), ["General"])).toBe("app.openFolder");
    expect(matchAction(key("F2"), ["Library"])).toBe("photo.rename");
    expect(matchAction(key("r", { ctrl: true }), ["Library"])).toBe("photo.reveal");
  });

  it("steps the thumbnail size from the Library scope", () => {
    expect(matchAction(key("-"), ["Library"])).toBe("grid.smaller");
    expect(matchAction(key("="), ["Library"])).toBe("grid.larger");
    // Numpad plus arrives as a bare "+", covered by the built-in alias.
    expect(matchAction(key("+"), ["Library"])).toBe("grid.larger");
    expect(matchAction(key("-"), ["Develop"])).toBeNull();
  });

  it("ignores a bare modifier and an unbound action", () => {
    expect(matchAction(key("Shift", { shift: true }), ["Develop"])).toBeNull();
    // photo.deleteDisk ships unbound (combo ""), which no keypress can produce.
    expect(matchAction(key(""), ["Develop"])).toBeNull();
  });
});

describe("extension actions", () => {
  const noop = () => {};

  it("matches a registered action regardless of module scope", () => {
    registerExtensionAction("ext.a", {
      id: "ext.a.run",
      label: "Run",
      defaultCombo: "Ctrl+Alt+1",
      handler: noop,
    });
    expect(matchExtensionAction(key("1", { ctrl: true, alt: true }))?.id).toBe("ext.a.run");
    expect(matchExtensionAction(key("2", { ctrl: true, alt: true }))).toBeNull();
  });

  it("defaults to the General category and keeps the handler", () => {
    const handler = vi.fn();
    registerExtensionAction("ext.a", {
      id: "ext.a.run",
      label: "Run",
      defaultCombo: "Ctrl+Alt+1",
      handler,
    });
    const match = matchExtensionAction(key("1", { ctrl: true, alt: true }));
    expect(match?.category).toBe("General");
    match?.handler();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("is rebindable through the same override map", () => {
    registerExtensionAction("ext.a", {
      id: "ext.a.run",
      label: "Run",
      category: "Develop",
      defaultCombo: "Ctrl+Alt+1",
      handler: noop,
    });
    setBinding("ext.a.run", "Ctrl+Alt+9");
    expect(matchExtensionAction(key("1", { ctrl: true, alt: true }))).toBeNull();
    expect(matchExtensionAction(key("9", { ctrl: true, alt: true }))?.id).toBe("ext.a.run");
  });

  it("unregisters only the unloading extension's actions", () => {
    registerExtensionAction("ext.a", {
      id: "ext.a.run",
      label: "A",
      defaultCombo: "Ctrl+Alt+1",
      handler: noop,
    });
    registerExtensionAction("ext.b", {
      id: "ext.b.run",
      label: "B",
      defaultCombo: "Ctrl+Alt+2",
      handler: noop,
    });
    unregisterExtensionActions("ext.a");
    expect([...useExtensionActions.getState().actions.keys()]).toEqual(["ext.b.run"]);
  });

  it("keeps the first extension's action against another extension, and names both", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mine = { id: "shared.run", label: "A", defaultCombo: "Ctrl+Alt+1", handler: noop };
    registerExtensionAction("ext.a", mine);
    registerExtensionAction("ext.b", { ...mine, label: "B", defaultCombo: "Ctrl+Alt+2" });
    const held = useExtensionActions.getState().actions.get("shared.run");
    expect(held).toMatchObject({ extensionId: "ext.a", label: "A" });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ext\.b.*"shared\.run".*ext\.a.*registerKeybinding ignored/));
    unregisterExtensionActions("ext.a");
    warn.mockRestore();
  });

  it("refuses an id that names one of Safelight's own actions", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerExtensionAction("ext.a", { id: "photo.deleteDisk", label: "Hijack", defaultCombo: "Ctrl+Alt+1", handler: noop });
    expect(useExtensionActions.getState().actions.has("photo.deleteDisk")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("replaces an action re-registered under the same id (extension reload)", () => {
    registerExtensionAction("ext.a", {
      id: "ext.a.run",
      label: "Old",
      defaultCombo: "Ctrl+Alt+1",
      handler: noop,
    });
    registerExtensionAction("ext.a", {
      id: "ext.a.run",
      label: "New",
      defaultCombo: "Ctrl+Alt+1",
      handler: noop,
    });
    const { actions } = useExtensionActions.getState();
    expect(actions.size).toBe(1);
    expect(actions.get("ext.a.run")?.label).toBe("New");
  });
});

describe("findConflicts", () => {
  it("ships a clean default map", () => {
    expect(findConflicts({})).toEqual(new Set());
  });

  it("flags two actions in the same module sharing a combo", () => {
    expect(findConflicts({ "develop.toggleClipping": "S" })).toEqual(
      new Set(["develop.toggleClipping", "develop.toggleProof"]),
    );
  });

  it("flags a General action colliding with any module", () => {
    expect(findConflicts({ "view.fullscreen": "J" })).toEqual(
      new Set(["view.fullscreen", "develop.toggleClipping"]),
    );
  });

  it("allows the same combo in Develop and Library (scopes never overlap)", () => {
    expect(findConflicts({ "develop.toggleProof": "P" })).toEqual(new Set());
  });

  it("never flags the unbound actions against each other", () => {
    // photo.deleteDisk ships with "" and must stay quiet.
    expect(findConflicts({}).has("photo.deleteDisk")).toBe(false);
  });

  it("counts a built-in alias that is still live", () => {
    expect(findConflicts({ "develop.reset": "Ctrl+Y" })).toEqual(
      new Set(["develop.reset", "develop.redo"]),
    );
  });

  it("stops counting the alias once its action is rebound", () => {
    expect(
      findConflicts({ "develop.reset": "Ctrl+Y", "develop.redo": "Ctrl+Shift+Z" }),
    ).toEqual(new Set());
  });

  it("treats an extension action as global, so it collides across modules", () => {
    registerExtensionAction("ext.a", {
      id: "ext.a.run",
      label: "Run",
      category: "Library",
      defaultCombo: "J", // develop.toggleClipping's key, a different module
      handler: () => {},
    });
    expect(findConflicts({})).toEqual(new Set(["ext.a.run", "develop.toggleClipping"]));
  });
});

describe("shortcut suspension", () => {
  it("stays suspended until every hold is released, in any order", () => {
    const outer = suspendShortcuts();
    const inner = suspendShortcuts();
    outer();
    expect(shortcutsSuspended()).toBe(true);
    inner();
    expect(shortcutsSuspended()).toBe(false);
  });

  it("counts a release only once", () => {
    const first = suspendShortcuts();
    const second = suspendShortcuts();
    first();
    first();
    expect(shortcutsSuspended()).toBe(true);
    second();
    expect(shortcutsSuspended()).toBe(false);
  });

  it("a release left over from before a test reset doesn't lift a later hold", () => {
    const stale = suspendShortcuts();
    resetShortcutHoldsForTests();
    expect(shortcutsSuspended()).toBe(false);
    const live = suspendShortcuts();
    stale();
    expect(shortcutsSuspended()).toBe(true);
    live();
    expect(shortcutsSuspended()).toBe(false);
  });
});

describe("initKeybindings", () => {
  type Listener = (e: StorageEvent) => void;

  function storageEvent(key: string, newValue: string | null): StorageEvent {
    return { key, newValue } as unknown as StorageEvent;
  }

  it("adopts rebinds made in another window", () => {
    const listeners: Listener[] = [];
    vi.stubGlobal("window", {
      addEventListener: (_type: string, fn: Listener) => void listeners.push(fn),
    });
    initKeybindings();

    listeners[0](storageEvent("sl_keybindings_v1", '{"module.library":"L"}'));
    expect(getBinding("module.library")).toBe("L");

    // Unrelated keys, clears and malformed payloads must leave bindings alone.
    listeners[0](storageEvent("sl_theme", '{"module.library":"Q"}'));
    listeners[0](storageEvent("sl_keybindings_v1", null));
    listeners[0](storageEvent("sl_keybindings_v1", "{not json"));
    expect(getBinding("module.library")).toBe("L");
  });
});

describe("isEditableTarget", () => {
  // The real check is `instanceof`, so the element hierarchy has to exist as
  // globals; these stand-ins carry only the fields the check reads.
  class StubElement {
    dataset: Record<string, string> = {};
    isContentEditable = false;
  }
  class StubInput extends StubElement {
    type = "text";
  }
  class StubTextArea extends StubElement {}
  class StubSelect extends StubElement {}

  const target = (el: StubElement) => el as unknown as EventTarget;

  beforeEach(() => {
    vi.stubGlobal("HTMLElement", StubElement);
    vi.stubGlobal("HTMLInputElement", StubInput);
    vi.stubGlobal("HTMLTextAreaElement", StubTextArea);
    vi.stubGlobal("HTMLSelectElement", StubSelect);
  });

  it("is false for a non-element target", () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({} as EventTarget)).toBe(false);
  });

  it("is false for controls that only look focusable", () => {
    // A slider keeps focus after a drag; Ctrl+Z must still reach the editor.
    for (const type of ["range", "checkbox", "radio", "button", "color", "file"]) {
      const input = new StubInput();
      input.type = type;
      expect(isEditableTarget(target(input))).toBe(false);
    }
  });

  it("is true for inputs that accept typing", () => {
    for (const type of ["text", "number", "search"]) {
      const input = new StubInput();
      input.type = type;
      expect(isEditableTarget(target(input))).toBe(true);
    }
    expect(isEditableTarget(target(new StubTextArea()))).toBe(true);
    expect(isEditableTarget(target(new StubSelect()))).toBe(true);
  });

  it("is true for contenteditable and for canvas editors that opt in", () => {
    const plain = new StubElement();
    expect(isEditableTarget(target(plain))).toBe(false);

    const editable = new StubElement();
    editable.isContentEditable = true;
    expect(isEditableTarget(target(editable))).toBe(true);

    const curve = new StubElement();
    curve.dataset.keyboardCapture = "";
    expect(isEditableTarget(target(curve))).toBe(true);
  });
});
