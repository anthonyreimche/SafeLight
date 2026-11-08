// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dock speed: a module switch paints with its rails, panels stay put while the
// dock changes shape, and a resize drag writes once per frame.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useLayoutEffect } from "react";
import { act, render } from "@testing-library/react";
import { DockHost, useDockStore } from "../dock";
import { registerPanel, useRegistry } from "../registry";
import { registerEssentialModules } from "@/test/essential-modules.test-support";
import { setFloatWidth, setRailHeight, setRailWidth } from "./actions";
import { startResize } from "./dnd";
import { DEFAULT_SETTINGS, useSettings } from "@/state/settings-store";

let renders = 0;
const Counted = () => {
  renders++;
  return null;
};

beforeEach(() => {
  renders = 0;
  localStorage.clear();
  useRegistry.setState({ panels: {}, modules: {}, layouts: {} });
  registerEssentialModules();
  useSettings.setState({ ...DEFAULT_SETTINGS });
  useDockStore.setState({
    module: null,
    rails: [],
    floating: {},
    zOrder: [],
    collapsed: {},
    hidden: { left: false, right: false, bottom: false, floating: false },
    open: [],
    drag: null,
    target: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("module switch", () => {
  it("loads the incoming layout in a layout effect, before the browser paints", () => {
    registerPanel("t", {
      id: "t.dev",
      title: "dev",
      component: Counted,
      defaultDock: { module: "develop", direction: "left" },
    });
    registerPanel("t", {
      id: "t.lib",
      title: "lib",
      component: Counted,
      defaultDock: { module: "library", direction: "left" },
    });
    const seen: (string | null)[] = [];
    // Sits after DockHost, so its layout effect runs after DockHost's own in
    // the same commit.
    const Probe = () => {
      useLayoutEffect(() => {
        seen.push(useDockStore.getState().module);
      });
      return null;
    };
    const tree = (module: string) => (
      <>
        <DockHost module={module}>{null}</DockHost>
        <Probe />
      </>
    );
    const view = render(tree("develop"));
    seen.length = 0;
    view.rerender(tree("library"));
    expect(seen[0]).toBe("library");
    expect(view.container.querySelector('[data-dock-panel="t.lib"]')).not.toBeNull();
    expect(view.container.querySelector('[data-dock-panel="t.dev"]')).toBeNull();
  });
});

describe("panels while the dock changes shape", () => {
  function mount() {
    registerPanel("t", {
      id: "t.side",
      title: "side",
      component: Counted,
      defaultDock: { module: "develop", direction: "left" },
    });
    registerPanel("t", {
      id: "t.strip",
      title: "strip",
      component: Counted,
      allowBottomDock: true,
      defaultDock: { module: "develop", direction: "bottom", height: 112 },
    });
    registerPanel("t", { id: "t.float", title: "float", component: Counted });
    const view = render(<DockHost module="develop">{null}</DockHost>);
    act(() => {
      const s = useDockStore.getState();
      useDockStore.setState({
        floating: { "t.float": { x: 10, y: 10, width: 300 } },
        zOrder: ["t.float"],
        open: [...s.open, "t.float"],
      });
    });
    return view;
  }

  it("does not re-render a panel on rail width, rail height or float width changes", () => {
    mount();
    const s = useDockStore.getState();
    const side = s.rails.find((r) => r.side === "left")!.id;
    const strip = s.rails.find((r) => r.side === "bottom")!.id;
    const before = renders;
    expect(before).toBeGreaterThanOrEqual(3);
    act(() => {
      for (let i = 0; i < 10; i++) {
        setRailWidth(side, 250 + i);
        setRailHeight(strip, 120 + i);
        setFloatWidth("t.float", 310 + i);
      }
    });
    expect(useDockStore.getState().rails.find((r) => r.id === side)!.width).toBe(259);
    expect(renders).toBe(before);
  });
});

describe("resize writes", () => {
  let frames: FrameRequestCallback[] = [];
  const runFrame = () => {
    const due = frames;
    frames = [];
    due.forEach((cb) => cb(0));
  };
  const down = (x: number) =>
    ({ button: 0, clientX: x, clientY: 0, preventDefault() {} }) as never;
  const fire = (type: string, x = 0) =>
    window.dispatchEvent(new MouseEvent(type, { clientX: x }));

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      frames = [];
    });
  });

  it("applies one write per frame with the latest value", () => {
    const apply = vi.fn();
    startResize(down(100), 200, 100, 600, 1, apply);
    for (let x = 101; x <= 110; x++) fire("pointermove", x);
    expect(apply).not.toHaveBeenCalled();
    runFrame();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(210);
    fire("pointerup");
  });

  it("flushes a pending value at once on pointerup", () => {
    const apply = vi.fn();
    startResize(down(100), 200, 100, 600, 1, apply);
    fire("pointermove", 130);
    fire("pointerup");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(230);
    runFrame();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it.each(["pointercancel", "lostpointercapture"])(
    "flushes a pending value on %s and stops listening",
    (type) => {
      const apply = vi.fn();
      startResize(down(100), 200, 100, 600, 1, apply);
      fire("pointermove", 120);
      fire(type);
      expect(apply).toHaveBeenLastCalledWith(220);
      fire("pointermove", 150);
      runFrame();
      expect(apply).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores events from a pointer other than the one that started it", () => {
    const apply = vi.fn();
    const firePointer = (type: string, pointerId: number, x = 0) => {
      const ev = new MouseEvent(type, { clientX: x });
      Object.defineProperty(ev, "pointerId", { value: pointerId });
      window.dispatchEvent(ev);
    };
    startResize(
      { button: 0, clientX: 100, clientY: 0, pointerId: 1, preventDefault() {} } as never,
      200, 100, 600, 1, apply);
    firePointer("pointermove", 1, 120);
    firePointer("lostpointercapture", 2);
    firePointer("pointercancel", 2);
    firePointer("pointermove", 2, 400);
    firePointer("pointerup", 2);
    expect(apply).not.toHaveBeenCalled();
    firePointer("pointermove", 1, 130);
    firePointer("pointerup", 1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(230);
  });

  it("saves the final width of a rail drag", async () => {
    registerPanel("t", {
      id: "t.side",
      title: "side",
      component: Counted,
      defaultDock: { module: "develop", direction: "left", width: 280 },
    });
    const view = render(<DockHost module="develop">{null}</DockHost>);
    const handle = view.container.querySelector(".cursor-col-resize")!;
    act(() => {
      handle.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0 }),
      );
      for (let x = 1; x <= 10; x++) fire("pointermove", x);
      fire("pointerup");
    });
    expect(useDockStore.getState().rails[0].width).toBe(290);
    vi.unstubAllGlobals();
    await act(() => new Promise((r) => setTimeout(r, 350)));
    const saved = JSON.parse(localStorage.getItem("sl_dock_layout_v4:develop") ?? "null");
    expect(saved.rails[0].width).toBe(290);
  });
});
