// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Step 2 of the welcome setup: kits as tri-state checkboxes over their
// extensions, filtered by the trust list, with installed extensions shown but
// never counted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useTrust } from "@/extensions/trust";
import { KitsStep } from "./KitsStep";
import { openSetup, resetSetupForTests, useSetupStore } from "./setup-store";
import {
  EMPTY_TRUST,
  KITS_DOC,
  manifestFor,
  ONE,
  stubBridge,
  TWO,
  trustList,
  type FakeBridge,
} from "./setup.test-support";

let bridge: FakeBridge;

beforeEach(() => {
  localStorage.clear();
  resetSetupForTests();
  bridge = stubBridge();
  useTrust.setState({ list: EMPTY_TRUST, loadedAt: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const showKits = async () => {
  act(() => openSetup("first-run", "extensions"));
  render(<KitsStep headingId="setup-heading" />);
  await screen.findByRole("checkbox", { name: "Film looks" });
};
const kitBox = (name: string) => screen.getByRole("checkbox", { name });
const checked = (name: string) => kitBox(name).getAttribute("aria-checked");
const footer = () => screen.queryByText(/extensions? selected/)?.textContent ?? "";

describe("KitsStep", () => {
  it("waits for the kits and the trust list before showing kits", async () => {
    let release!: () => void;
    bridge.kits.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(KITS_DOC))),
    );
    act(() => openSetup("first-run", "extensions"));
    render(<KitsStep headingId="setup-heading" />);
    expect(screen.getByRole("status").textContent).toBe("Loading starter kits…");
    await act(async () => release());
    expect(await screen.findByRole("checkbox", { name: "Film looks" })).toBeTruthy();
  });

  it("ticks every extension of a kit at once", async () => {
    const user = userEvent.setup();
    await showKits();
    await user.click(kitBox("Film looks"));
    expect(checked("Film looks")).toBe("true");
    expect(footer()).toBe("2 extensions selected");
  });

  it("shows a kit as mixed after one of its extensions is unticked", async () => {
    const user = userEvent.setup();
    await showKits();
    await user.click(kitBox("Film looks"));
    await user.click(
      screen.getByRole("button", { name: "Show Film looks extensions" }),
    );
    await user.click(screen.getByRole("checkbox", { name: /^One/ }));
    expect(checked("Film looks")).toBe("mixed");
    expect(footer()).toBe("1 extension selected");
  });

  it("counts an extension shared by two kits once", async () => {
    const user = userEvent.setup();
    await showKits();
    await user.click(kitBox("Film looks"));
    await user.click(kitBox("Colour work"));
    expect(footer()).toBe("3 extensions selected");
  });

  it("leaves out extensions that aren't on the verified list", async () => {
    const user = userEvent.setup();
    bridge.trustList.mockResolvedValue(trustList({ verified: [ONE, TWO] }));
    await showKits();
    await user.click(
      screen.getByRole("button", { name: "Show Colour work extensions" }),
    );
    expect(screen.queryByRole("checkbox", { name: /^Three/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /^Two/ })).toBeTruthy();
  });

  it("shows an installed extension as installed and doesn't count it", async () => {
    const user = userEvent.setup();
    bridge.list.mockResolvedValue([manifestFor(ONE, { repository: ONE })]);
    await showKits();
    await vi.waitFor(() => expect(useSetupStore.getState().installed).toEqual([ONE]));
    await user.click(
      screen.getByRole("button", { name: "Show Film looks extensions" }),
    );
    expect(screen.queryByRole("checkbox", { name: /^One/ })).toBeNull();
    expect(screen.getByText("Installed")).toBeTruthy();
    await user.click(kitBox("Film looks"));
    expect(footer()).toBe("1 extension selected");
  });

  it("marks a kit whose extensions are all installed and won't tick it", async () => {
    const user = userEvent.setup();
    bridge.list.mockResolvedValue([
      manifestFor(ONE, { repository: ONE }),
      manifestFor(TWO, { repository: TWO }),
    ]);
    await showKits();
    await screen.findByText("All installed");
    expect(checked("Film looks")).toBe("true");
    expect(kitBox("Film looks").getAttribute("aria-disabled")).toBe("true");
    await user.click(kitBox("Film looks"));
    expect(footer()).toBe("");
  });

  it("says when starter kits aren't available, and still continues", async () => {
    const user = userEvent.setup();
    bridge.kits.mockResolvedValue(null);
    act(() => openSetup("first-run", "extensions"));
    render(<KitsStep headingId="setup-heading" />);
    expect(await screen.findByText(/Starter kits aren't available right now/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(useSetupStore.getState().step).toBe("finish");
  });

  it("goes back to Workspace", async () => {
    const user = userEvent.setup();
    await showKits();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(useSetupStore.getState().step).toBe("workspace");
  });
});
