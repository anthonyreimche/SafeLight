// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Develop bottom-bar dropdown picks the display transform for the open
// photo, as one undoable step, and never touches the Preferences default.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The store's commits broadcast to sibling windows; not under test here.
vi.mock("@/state/broadcast", () => ({
  broadcast: () => {},
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { normalizeParams } from "@/catalog/types";
import { registerPipeline, useRegistry } from "@/extensions/registry";
import { DEFAULT_PIPELINE, usePipelineStore } from "@/extensions/pipelines";
import { useDevelopStore } from "@/state/develop-store";
import { DisplayTransformControl } from "./DisplayTransformControl";

function seedPhoto(displayTransform: string | null = null) {
  const params = normalizeParams({ displayTransform });
  useDevelopStore.setState({
    photoId: "photo-1",
    params,
    paramBag: {},
    history: [{ timestamp: 0, label: "Original", params, paramBag: {} }],
    historyIndex: 0,
  });
}

const pick = () => useDevelopStore.getState().params.displayTransform;
const topLabel = () => {
  const { history, historyIndex } = useDevelopStore.getState();
  return history[historyIndex].label;
};
const trigger = () => screen.getByRole("button", { name: "Choose display transform" });

beforeEach(() => {
  useRegistry.setState({ pipelines: {} });
  registerPipeline("core", { id: DEFAULT_PIPELINE, name: "Built-in" });
  registerPipeline("test", { id: "test.agx", name: "AgX" });
  usePipelineStore.setState({ activeId: DEFAULT_PIPELINE });
  seedPhoto();
});

afterEach(() => useRegistry.setState({ pipelines: {} }));

describe("DisplayTransformControl", () => {
  it("shows that a photo without a pick follows the default", () => {
    usePipelineStore.setState({ activeId: "test.agx" });
    render(<DisplayTransformControl />);
    expect(trigger().textContent).toContain("Default (AgX)");
  });

  it("picks a transform for this photo as one undoable step", async () => {
    const user = userEvent.setup();
    render(<DisplayTransformControl />);
    await user.click(trigger());
    await user.click(screen.getByRole("menuitemradio", { name: "AgX" }));
    expect(pick()).toBe("test.agx");
    expect(topLabel()).toBe("Display transform");
    expect(usePipelineStore.getState().activeId).toBe(DEFAULT_PIPELINE);
  });

  it("marks the photo's own pick", async () => {
    seedPhoto("test.agx");
    const user = userEvent.setup();
    render(<DisplayTransformControl />);
    await user.click(trigger());
    const agx = screen.getByRole("menuitemradio", { name: "AgX" });
    const fallback = screen.getByRole("menuitemradio", { name: "Default (Built-in)" });
    expect(agx.getAttribute("aria-checked")).toBe("true");
    expect(fallback.getAttribute("aria-checked")).toBe("false");
  });

  it("goes back to following the default", async () => {
    seedPhoto("test.agx");
    const user = userEvent.setup();
    render(<DisplayTransformControl />);
    await user.click(trigger());
    await user.click(screen.getByRole("menuitemradio", { name: "Default (Built-in)" }));
    expect(pick()).toBeNull();
    expect(topLabel()).toBe("Display transform");
  });

  it("names a pick whose extension is missing", () => {
    seedPhoto("gone.film");
    render(<DisplayTransformControl />);
    expect(trigger().textContent).toContain("gone.film (missing)");
  });

  it("stays hidden with only the built-in transform", () => {
    useRegistry.setState({ pipelines: {} });
    registerPipeline("core", { id: DEFAULT_PIPELINE, name: "Built-in" });
    const { container } = render(<DisplayTransformControl />);
    expect(container.firstChild).toBeNull();
  });
});
