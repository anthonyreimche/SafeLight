// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The welcome setup as a modal layer: labelled by its step heading, focus on
// that heading, app shortcuts suspended, Tab kept inside, and a first run that
// a stray Escape can't skip.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useTrust } from "@/extensions/trust";
import { shortcutsSuspended } from "@/state/keybindings-store";
import { SETUP_RECORD_KEY } from "./first-run";
import { waitingRow } from "./install-queue";
import { SetupFlow } from "./SetupFlow";
import {
  closeSetup,
  openSetup,
  resetSetupForTests,
  useSetupStore,
  type SetupMode,
} from "./setup-store";
import { EMPTY_TRUST, stubBridge } from "./setup.test-support";

const record = () => JSON.parse(localStorage.getItem(SETUP_RECORD_KEY) ?? "null");
const layOutEverything = () =>
  vi
    .spyOn(Element.prototype, "getClientRects")
    .mockReturnValue([{} as DOMRect] as unknown as DOMRectList);

beforeEach(() => {
  localStorage.clear();
  resetSetupForTests();
  stubBridge().kits.mockResolvedValue(null);
  useTrust.setState({ list: EMPTY_TRUST, loadedAt: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const show = async (mode: SetupMode = "first-run") => {
  act(() => openSetup(mode));
  render(<SetupFlow />);
  await act(async () => {});
};

describe("SetupFlow", () => {
  it("renders nothing until setup is open", () => {
    const { container } = render(<SetupFlow />);
    expect(container.firstChild).toBeNull();
    act(() => useSetupStore.setState({ phase: "closed" }));
    expect(container.firstChild).toBeNull();
  });

  it("is a modal dialog named by the step heading, with focus on it", async () => {
    await show();
    const dialog = screen.getByRole("dialog", { name: "Pick a look" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Pick a look" }),
    );
  });

  it("moves focus to the new heading on each step", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Your workspace, your rules" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Your workspace, your rules" }),
    ).toBeTruthy();
  });

  it("puts focus back on the heading when installs start and settle", async () => {
    await show("rerun");
    act(() => useSetupStore.setState({ step: "finish" }));
    const row = waitingRow({ repo: "acme/one", name: "One", summary: "" });
    act(() => useSetupStore.setState({ installs: [row], installing: true }));
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Installing extensions" }),
    );
    act(() =>
      useSetupStore.setState({
        installs: [{ ...row, status: "installed" }],
        installing: false,
      }),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Your darkroom is ready" }),
    );
  });

  it("marks the current step of four", async () => {
    await show();
    const steps = within(
      screen.getByRole("list", { name: "Setup steps" }),
    ).getAllByRole("listitem");
    expect(steps.map((s) => s.textContent)).toEqual([
      "1. Look",
      "2. Workspace",
      "3. Extensions",
      "4. Finish",
    ]);
    expect(steps.map((s) => s.getAttribute("aria-current"))).toEqual([
      "step",
      null,
      null,
      null,
    ]);
  });

  it("suspends app shortcuts while open and restores them on close", async () => {
    await show();
    expect(shortcutsSuspended()).toBe(true);
    act(() => closeSetup("skipped"));
    expect(shortcutsSuspended()).toBe(false);
  });

  it("skips a first run from the header and records it", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(screen.getByRole("button", { name: "Skip setup" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(record()).toMatchObject({ outcome: "skipped" });
  });

  it("ignores Escape on a first run", async () => {
    const user = userEvent.setup();
    await show();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes a rerun with Close or Escape and leaves the record alone", async () => {
    const user = userEvent.setup();
    await show("rerun");
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(record()).toBeNull();
  });

  it("hides the header button and ignores Escape once installs have started", async () => {
    const user = userEvent.setup();
    await show("rerun");
    act(() =>
      useSetupStore.setState({
        step: "finish",
        installs: [waitingRow({ repo: "acme/one", name: "One", summary: "" })],
        installing: true,
      }),
    );
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("keeps the keyboard inside after a click on blank space", async () => {
    const user = userEvent.setup();
    await show("rerun");
    await user.click(screen.getByText("1. Look"));
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Tab inside while installs run and nothing in it takes focus", async () => {
    const user = userEvent.setup();
    layOutEverything();
    act(() => openSetup("rerun"));
    render(
      <>
        <button type="button">Welcome setup</button>
        <SetupFlow />
      </>,
    );
    await act(async () => {});
    act(() =>
      useSetupStore.setState({
        step: "finish",
        installs: [waitingRow({ repo: "acme/one", name: "One", summary: "" })],
        installing: true,
      }),
    );
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Installing extensions" }),
    );
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("keeps Tab inside the setup", async () => {
    const user = userEvent.setup();
    layOutEverything();
    await show();
    screen.getByRole("button", { name: "Continue" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Skip setup" }),
    );
  });
});
