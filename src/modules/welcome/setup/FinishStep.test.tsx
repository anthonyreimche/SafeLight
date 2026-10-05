// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Step 3 of the welcome setup, through the real loader: the Electron bridge
// is stubbed, and the bundle import (an app:// URL jsdom can't load) is the
// one leaf module mocked, so installs activate exactly as they do in the app.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RISK_ACK_KEY } from "@/extensions/install-gate";
import { uninstallPlugin, useDisabledExtensions } from "@/extensions/loader";
import { readSources } from "@/extensions/sources";
import { useTrust } from "@/extensions/trust";
import { useProjectStore } from "@/project/project-store";
import { SETUP_RECORD_KEY } from "./first-run";
import { FinishStep, joinNames } from "./FinishStep";
import {
  openSetup,
  resetSetupForTests,
  toggleSetupExtension,
  useSetupStore,
  type SetupMode,
} from "./setup-store";
import {
  EMPTY_TRUST,
  manifestFor,
  ONE,
  stubBridge,
  TWO,
  trustList,
  type FakeBridge,
} from "./setup.test-support";

vi.mock("../../../extensions/plugin-module", () => ({
  importPluginModule: vi.fn(async () => ({ activate() {} })),
}));

let bridge: FakeBridge;
let openProjectPicker: Mock<() => Promise<void>>;

beforeEach(() => {
  localStorage.clear();
  resetSetupForTests();
  bridge = stubBridge();
  useTrust.setState({ list: EMPTY_TRUST, loadedAt: 0 });
  useDisabledExtensions.setState({ ids: [] });
  openProjectPicker = vi.fn<() => Promise<void>>(async () => {});
  useProjectStore.setState({ openProjectPicker });
});

afterEach(async () => {
  for (const id of ["acme.one", "acme.two"]) await uninstallPlugin(id);
  vi.unstubAllGlobals();
});

const record = () => JSON.parse(localStorage.getItem(SETUP_RECORD_KEY) ?? "null");

const showFinish = async (mode: SetupMode, picks: string[] = []) => {
  act(() => openSetup(mode, "finish"));
  await vi.waitFor(() => expect(useSetupStore.getState().kits.status).toBe("ready"));
  act(() => picks.forEach(toggleSetupExtension));
  render(<FinishStep headingId="setup-heading" />);
};

describe("FinishStep with nothing picked", () => {
  it("finishes a first run by recording it and opening the folder picker", async () => {
    const user = userEvent.setup();
    await showFinish("first-run");
    expect(screen.getByRole("heading", { name: "Your darkroom is ready" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open Folder…" }));
    expect(useSetupStore.getState().phase).toBe("closed");
    expect(record()).toMatchObject({ outcome: "finished" });
    expect(openProjectPicker).toHaveBeenCalledTimes(1);
  });

  it("points to Preferences for both the look and the workspace", async () => {
    await showFinish("first-run");
    expect(
      screen.getByText(
        "Add extensions any time from the Extensions store, and change your look and workspace in Preferences.",
      ),
    ).toBeTruthy();
  });

  it("finishes a rerun with Done and leaves the record alone", async () => {
    const user = userEvent.setup();
    await showFinish("rerun");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(useSetupStore.getState().phase).toBe("closed");
    expect(record()).toBeNull();
    expect(openProjectPicker).not.toHaveBeenCalled();
  });

  it("goes back to the kits", async () => {
    const user = userEvent.setup();
    await showFinish("first-run");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(useSetupStore.getState().step).toBe("extensions");
  });
});

describe("FinishStep installing", () => {
  it("lists the picks beside the third-party notice", async () => {
    await showFinish("first-run", [ONE, TWO]);
    expect(screen.getByRole("heading", { name: "Install 2 extensions" })).toBeTruthy();
    expect(screen.getByText(/third-party software/)).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "One",
      "Two",
    ]);
  });

  it("records the acknowledgement and installs each pick in order", async () => {
    const user = userEvent.setup();
    await showFinish("first-run", [ONE, TWO]);
    await user.click(screen.getByRole("button", { name: "Install 2 extensions" }));
    expect(await screen.findByText("Installed 2 of 2.")).toBeTruthy();
    expect(bridge.install.mock.calls.map(([spec]) => spec)).toEqual([ONE, TWO]);
    expect(localStorage.getItem(RISK_ACK_KEY)).toBe("1");
    expect(readSources()).toMatchObject({ "acme.one": ONE, "acme.two": TWO });
  });

  it("offers no way out until every install has settled", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    bridge.install.mockImplementationOnce(
      (spec) => new Promise((resolve) => (release = () => resolve(manifestFor(spec)))),
    );
    await showFinish("first-run", [ONE]);
    await user.click(screen.getByRole("button", { name: "Install 1 extension" }));
    await screen.findByText("Installing…");
    expect(screen.queryByRole("button", { name: "Open Folder…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    await act(async () => release());
    expect(await screen.findByRole("button", { name: "Open Folder…" })).toBeTruthy();
  });

  it("shows why an install failed and retries it", async () => {
    const user = userEvent.setup();
    bridge.install.mockRejectedValueOnce(new Error("GitHub download failed (502)"));
    await showFinish("first-run", [ONE, TWO]);
    await user.click(screen.getByRole("button", { name: "Install 2 extensions" }));
    expect(await screen.findByText("GitHub download failed (502)")).toBeTruthy();
    expect(screen.getByText("Installed 1 of 2.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry One" }));
    expect(await screen.findByText("Installed 2 of 2.")).toBeTruthy();
  });

  it("says nothing was installed when every install failed", async () => {
    const user = userEvent.setup();
    bridge.install.mockRejectedValue(new Error("GitHub download failed (502)"));
    await showFinish("first-run", [ONE, TWO]);
    await user.click(screen.getByRole("button", { name: "Install 2 extensions" }));
    expect(
      await screen.findByRole("heading", { name: "Nothing was installed" }),
    ).toBeTruthy();
    expect(screen.getByText("Installed 0 of 2.")).toBeTruthy();
  });

  it("skips an extension whose newest version hasn't been reviewed", async () => {
    const user = userEvent.setup();
    bridge.trustList.mockResolvedValue(
      trustList({ reviewed: { [ONE]: { version: "1.0.0" } } }),
    );
    bridge.remoteManifest.mockImplementation(async (repo) => ({
      version: repo === ONE ? "1.1.0" : "1.0.0",
    }));
    await showFinish("first-run", [ONE, TWO]);
    await user.click(screen.getByRole("button", { name: "Install 2 extensions" }));
    expect(await screen.findByText(/reviewed up to 1\.0\.0/)).toBeTruthy();
    expect(bridge.install.mock.calls.map(([spec]) => spec)).toEqual([TWO]);
  });

  it("asks for a restart when an installed extension needs network access", async () => {
    const user = userEvent.setup();
    bridge.install.mockImplementation(async (spec) =>
      manifestFor(spec, spec === ONE ? { permissions: { network: ["https://tiles.example"] } } : {}),
    );
    await showFinish("first-run", [ONE]);
    await user.click(screen.getByRole("button", { name: "Install 1 extension" }));
    expect(
      await screen.findByText("Restart Safelight so One can reach the internet."),
    ).toBeTruthy();
  });
});

describe("joinNames", () => {
  it.each([
    [["One"], "One"],
    [["One", "Two"], "One and Two"],
    [["One", "Two", "Three"], "One, Two and Three"],
  ])("joins %j as %s", (names, joined) => {
    expect(joinNames(names)).toBe(joined);
  });
});
