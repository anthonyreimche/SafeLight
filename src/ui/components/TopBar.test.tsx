// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The SAFELIGHT brand text closes the project. Closing keeps every edit, so it
// asks first only when it would cut an import short.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopBar } from "./TopBar";
import { ConfirmDialogHost } from "./ConfirmDialog";
import { useProjectStore } from "@/project/project-store";
import { registerTopBarButton, unregisterExtension } from "@/extensions/registry";

const closeProject = vi.fn();
const original = useProjectStore.getState().closeProject;

beforeEach(() => {
  closeProject.mockClear();
  window.history.replaceState({}, "", "/");
  useProjectStore.setState({ closeProject, opening: false, importDone: 0, importTotal: 0 });
});

afterEach(() => {
  useProjectStore.setState({ closeProject: original, opening: false, importDone: 0, importTotal: 0 });
});

function renderBar() {
  render(
    <>
      <TopBar />
      <ConfirmDialogHost />
    </>,
  );
}

describe("the SAFELIGHT brand text", () => {
  it("closes the project at once when nothing is being imported", async () => {
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "SAFELIGHT" }));
    expect(closeProject).toHaveBeenCalledTimes(1);
  });

  it("asks before closing a project that is still importing", async () => {
    useProjectStore.setState({ importDone: 40, importTotal: 100 });
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "SAFELIGHT" }));
    expect(closeProject).not.toHaveBeenCalled();

    await screen.findByRole("dialog", { name: "Close project" });
    await userEvent.click(await screen.findByRole("button", { name: "Close project" }));
    expect(closeProject).toHaveBeenCalledTimes(1);
  });

  it("keeps the project open when the question is declined", async () => {
    useProjectStore.setState({ opening: true });
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "SAFELIGHT" }));
    await userEvent.click(await screen.findByRole("button", { name: "Keep working" }));
    expect(closeProject).not.toHaveBeenCalled();
  });
});

// An extension's button sits with the built-in icons, its icon drawn as a mask
// in the bar's colour: the markup is never put into the page.
describe("extension top-bar buttons", () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path id="sl-planted" d="M4 4h16v16H4z"/></svg>';

  afterEach(() => {
    unregisterExtension("acme");
    vi.restoreAllMocks();
  });

  it("shows the label and calls onClick", async () => {
    const onClick = vi.fn();
    registerTopBarButton("acme", { id: "acme.store", label: "Filter store", svg: SVG, onClick });
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "Filter store" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Filter store" }).getAttribute("title")).toBe("Filter store");
  });

  it("never puts the svg markup into the page", () => {
    registerTopBarButton("acme", { id: "acme.store", label: "Filter store", svg: SVG, onClick: () => {} });
    renderBar();
    const button = screen.getByRole("button", { name: "Filter store" });
    expect(button.querySelector("svg, path")).toBeNull();
    expect(document.getElementById("sl-planted")).toBeNull();
    const icon = button.querySelector("span");
    expect(icon?.style.backgroundColor).toMatch(/^currentcolor$/i);
  });

  it("orders buttons by order, lower further left", () => {
    registerTopBarButton("acme", { id: "acme.b", label: "Second", svg: SVG, onClick: () => {}, order: 20 });
    registerTopBarButton("acme", { id: "acme.a", label: "First", svg: SVG, onClick: () => {}, order: 10 });
    renderBar();
    const labels = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(labels.indexOf("First")).toBeLessThan(labels.indexOf("Second"));
  });

  it("keeps the bar working when onClick throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerTopBarButton("acme", {
      id: "acme.broken",
      label: "Broken",
      svg: SVG,
      onClick: () => {
        throw new Error("boom");
      },
    });
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "Broken" }));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("acme"), expect.any(Error));
    await userEvent.click(screen.getByRole("button", { name: "SAFELIGHT" }));
    expect(closeProject).toHaveBeenCalledTimes(1);
  });

  it("goes when its extension stops", () => {
    registerTopBarButton("acme", { id: "acme.store", label: "Filter store", svg: SVG, onClick: () => {} });
    renderBar();
    act(() => unregisterExtension("acme"));
    expect(screen.queryByRole("button", { name: "Filter store" })).toBeNull();
  });
});
