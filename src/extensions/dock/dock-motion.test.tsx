// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dock motion: a module switch fades the workspace in without remounting it, and
// expanding a panel plays an enter on its body while collapsing stays instant.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { DockHost, useDockStore } from "../dock";
import { registerPanel, useRegistry } from "../registry";
import { registerEssentialModules } from "@/test/essential-modules.test-support";
import { DEFAULT_SETTINGS, useSettings } from "@/state/settings-store";

const Body = () => <div data-testid="body">body</div>;

beforeEach(() => {
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
  document.documentElement.classList.remove("sl-reduce-motion");
  Reflect.deleteProperty(Element.prototype, "animate");
  localStorage.clear();
});

describe("module switch fade", () => {
  const stubAnimate = () => {
    const animate = vi.fn();
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
    return animate;
  };
  const tree = (module: string) => (
    <DockHost module={module}>
      <div data-testid="main-child" />
    </DockHost>
  );

  it("fades once on a switch, keeping the workspace mounted, and not on first mount", () => {
    const animate = stubAnimate();
    const view = render(tree("develop"));
    expect(animate).not.toHaveBeenCalled();
    const main = view.getByTestId("main-child");
    const mainHost = main.parentElement;
    view.rerender(tree("library"));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][0]).toEqual({ opacity: [0, 1] });
    expect(view.getByTestId("main-child")).toBe(main);
    expect(main.parentElement).toBe(mainHost);
  });

  it("does not fade under Reduce motion", () => {
    const animate = stubAnimate();
    const view = render(tree("develop"));
    document.documentElement.classList.add("sl-reduce-motion");
    view.rerender(tree("library"));
    expect(animate).not.toHaveBeenCalled();
  });

  it("does nothing where Element.animate is missing", () => {
    const view = render(tree("develop"));
    expect(() => view.rerender(tree("library"))).not.toThrow();
  });
});

describe("panel expand", () => {
  function mount(extra: { fill?: boolean } = {}) {
    registerPanel("t", {
      id: "t.side",
      title: "side",
      component: Body,
      defaultDock: { module: "develop", direction: "left" },
      ...extra,
    });
    return render(<DockHost module="develop">{null}</DockHost>);
  }
  const setCollapsed = (value: boolean) =>
    act(() => {
      useDockStore.setState({ collapsed: { "t.side": value } });
    });
  const enterClass = (el: HTMLElement) =>
    el.closest(".sl-enter-expand, .sl-enter-rise");

  it("plays no enter on first render, even for an expanded panel", () => {
    const view = mount();
    expect(enterClass(view.getByTestId("body"))).toBeNull();
  });

  it("plays the expand enter when a collapsed panel is opened", () => {
    const view = mount();
    setCollapsed(true);
    expect(view.queryByTestId("body")).toBeNull();
    setCollapsed(false);
    const wrap = enterClass(view.getByTestId("body"));
    expect(wrap?.classList.contains("sl-enter-expand")).toBe(true);
  });

  it("stops clipping the body once it has folded open, keeping the same body", () => {
    const view = mount();
    setCollapsed(true);
    setCollapsed(false);
    const body = view.getByTestId("body");
    const wrap = enterClass(body) as HTMLElement;
    fireEvent.animationEnd(wrap);
    expect(enterClass(view.getByTestId("body"))).toBeNull();
    expect(view.getByTestId("body")).toBe(body);

    setCollapsed(true);
    setCollapsed(false);
    expect(enterClass(view.getByTestId("body"))?.classList.contains("sl-enter-expand")).toBe(true);
  });

  it("stops clipping when the fold is cancelled part way", () => {
    const view = mount();
    setCollapsed(true);
    setCollapsed(false);
    const wrap = enterClass(view.getByTestId("body")) as HTMLElement;
    act(() => {
      wrap.dispatchEvent(new Event("animationcancel"));
    });
    expect(enterClass(view.getByTestId("body"))).toBeNull();
  });

  it("opens without clipping under Reduce motion, where the fold never runs", () => {
    document.documentElement.classList.add("sl-reduce-motion");
    try {
      const view = mount();
      setCollapsed(true);
      setCollapsed(false);
      expect(enterClass(view.getByTestId("body"))).toBeNull();
    } finally {
      document.documentElement.classList.remove("sl-reduce-motion");
    }
  });

  it("collapses instantly", () => {
    const view = mount();
    setCollapsed(true);
    setCollapsed(false);
    setCollapsed(true);
    expect(view.queryByTestId("body")).toBeNull();
  });

  it("keeps the body mounted through unrelated re-renders after expanding", () => {
    const view = mount();
    setCollapsed(true);
    setCollapsed(false);
    const body = view.getByTestId("body");
    act(() => {
      useDockStore.setState({ zOrder: [] });
    });
    expect(view.getByTestId("body")).toBe(body);
  });

  it("rises instead of resizing for a fill panel that stretches", () => {
    const view = mount({ fill: true });
    setCollapsed(true);
    setCollapsed(false);
    const wrap = enterClass(view.getByTestId("body"));
    expect(wrap?.classList.contains("sl-enter-rise")).toBe(true);
    expect(wrap?.classList.contains("flex-1")).toBe(true);
  });
});
