// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The store panel's version switching, driven from the detail page: which
// installs keep the extension on the version chosen, that a switch leaves a
// disabled extension disabled, and that a chosen version is judged against the
// review rather than the latest release. The real loader runs; only the bundle
// import is replaced (the app:// protocol is out of jsdom's reach), with a
// module whose activate does nothing.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialogHost } from "@/ui/components/ConfirmDialog";
import { ExtensionManagerPanel } from "./ExtensionManagerPanel";
import { importPluginModule } from "./plugin-module";
import { uninstallPlugin, useDisabledExtensions } from "./loader";
import { usePins } from "./pins";
import { useRegistry } from "./registry";
import { useExtStoreUI, type ExtUpdateInfo } from "./store-ui";
import { useTrust } from "./trust";
import type { ExtensionManifest, ExtensionRelease, TrustList } from "./types";

vi.mock("./plugin-module", () => ({ importPluginModule: vi.fn() }));

const ID = "acme.widget";
const REPO = "acme/widget";
const RISK_ACK_KEY = "sl_ext_risk_ack_v1";

const manifest = (version: string): ExtensionManifest => ({
  id: ID,
  name: "Widget",
  version,
  main: "index.js",
  repository: REPO,
});

const rel = (version: string): ExtensionRelease => ({
  version,
  tag: `v${version}`,
  prerelease: false,
  publishedAt: "",
  notes: "",
  htmlUrl: "",
});

const trustList = (reviewed: Record<string, { version?: string }> = {}): TrustList => ({
  verified: [REPO],
  reviewed,
  repos: [],
  owners: [],
  reason: {},
});

const importer = vi.mocked(importPluginModule);
let current: ExtensionManifest;
let present: boolean;
let installBridge: Mock;
let remoteManifest: Mock;

/** Boot the store on the detail page of `REPO`, waiting for the installed
 *  state (or the Install button) to show. */
const openDetail = async (releases: string[], installed: string | null) => {
  present = installed !== null;
  if (installed) current = manifest(installed);
  vi.stubGlobal("safelightNative", {
    plugins: {
      list: async () => (present ? [current] : []),
      install: installBridge,
      uninstall: vi.fn(async () => {}),
      remoteManifest,
      releases: vi.fn(async () => releases.map(rel)),
    },
  });
  render(
    <>
      <ExtensionManagerPanel />
      <ConfirmDialogHost />
    </>,
  );
  // The panel opens on its list; a row's click does exactly this.
  act(() => useExtStoreUI.getState().openDetail(REPO));
  if (installed) await screen.findByText(`v${installed}`);
  await screen.findByRole("combobox", { name: "Version" });
};

const pick = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
  await user.click(screen.getByRole("combobox", { name: "Version" }));
  await user.click(screen.getByRole("option", { name: label }));
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(RISK_ACK_KEY, "1");
  installBridge = vi.fn(async (_spec: string, version?: string) => {
    current = manifest(version ?? "2.1.0");
    present = true;
    return current;
  });
  remoteManifest = vi.fn(async () => ({ version: "2.1.0" }));
  importer.mockReset();
  importer.mockResolvedValue({ activate: () => {} });
  useRegistry.setState({ stylesheets: {}, modules: {} });
  useDisabledExtensions.setState({ ids: [] });
  useExtStoreUI.setState({ view: "list", selected: null, updates: {}, releases: {} });
  usePins.setState({ pins: {} });
  // A bare verified entry: no review pin, so installs raise no prompt.
  useTrust.setState({ list: trustList(), loadedAt: 1, flagged: [] });
});

afterEach(async () => {
  await uninstallPlugin(ID); // the loader's live-module map persists across tests
  useTrust.setState({ list: { ...trustList(), verified: [] }, loadedAt: 0, flagged: [] });
  vi.unstubAllGlobals();
});

describe("ExtensionManagerPanel version switching", () => {
  it("keeps the extension on an older version and re-checks for updates", async () => {
    const user = userEvent.setup();
    await openDetail(["2.1.0", "1.0.0"], "2.1.0");
    await pick(user, "1.0.0");
    remoteManifest.mockClear();
    await user.click(await screen.findByRole("button", { name: "Switch to 1.0.0" }));

    await waitFor(() => expect(usePins.getState().pins).toEqual({ [ID]: "1.0.0" }));
    expect(installBridge).toHaveBeenCalledWith(REPO, "1.0.0");
    await waitFor(() => expect(remoteManifest).toHaveBeenCalledWith(REPO));
    expect(importer).toHaveBeenCalledWith(expect.stringContaining("v=1.0.0"));
  });

  it("updating to the latest stops keeping an older version", async () => {
    usePins.setState({ pins: { [ID]: "1.0.0" } });
    const update: ExtUpdateInfo = {
      latestTag: "2.1.0",
      hasUpdate: true,
      requiresApp: null,
      failed: null,
      checkedAt: Date.now(),
    };
    useExtStoreUI.setState({ updates: { [ID]: update } });
    const user = userEvent.setup();
    await openDetail(["2.1.0", "1.0.0"], "1.0.0");
    await user.click(await screen.findByRole("button", { name: "Update to 2.1.0" }));

    await waitFor(() => expect(installBridge).toHaveBeenCalledWith(REPO, "2.1.0"));
    await waitFor(() => expect(usePins.getState().pins).toEqual({}));
  });

  it("installing without a version leaves no pin", async () => {
    usePins.setState({ pins: { [ID]: "1.0.0" } });
    const user = userEvent.setup();
    await openDetail(["2.1.0", "1.0.0"], null);
    await user.click(await screen.findByRole("button", { name: "Install" }));

    await waitFor(() => expect(installBridge).toHaveBeenCalledWith(REPO));
    await waitFor(() => expect(usePins.getState().pins).toEqual({}));
  });

  it("keeps a disabled extension disabled when switching versions", async () => {
    useDisabledExtensions.setState({ ids: [ID] });
    const user = userEvent.setup();
    await openDetail(["2.1.0", "1.0.0"], "2.1.0");
    await pick(user, "1.0.0");
    await user.click(await screen.findByRole("button", { name: "Switch to 1.0.0" }));

    await waitFor(() => expect(usePins.getState().pins).toEqual({ [ID]: "1.0.0" }));
    expect(installBridge).toHaveBeenCalledWith(REPO, "1.0.0");
    expect(useDisabledExtensions.getState().ids).toEqual([ID]);
    expect(importer).not.toHaveBeenCalled();
  });
});

describe("ExtensionManagerPanel review of a chosen version", () => {
  it("judges the chosen version, not the latest release", async () => {
    // Reviewed up to 2.0.0 while the repo's latest is 3.0.0: going back to 1.0.0
    // is inside the review, so it installs without the unreviewed prompt.
    useTrust.setState({ list: trustList({ [REPO]: { version: "2.0.0" } }), loadedAt: 1 });
    remoteManifest.mockImplementation(async () => ({ version: "3.0.0" }));
    const user = userEvent.setup();
    await openDetail(["3.0.0", "2.0.0", "1.0.0"], "2.0.0");
    await pick(user, "1.0.0");
    await user.click(await screen.findByRole("button", { name: "Switch to 1.0.0" }));

    await waitFor(() => expect(installBridge).toHaveBeenCalledWith(REPO, "1.0.0"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names a chosen version that is past the review, and stops on Cancel", async () => {
    useTrust.setState({ list: trustList({ [REPO]: { version: "1.5.0" } }), loadedAt: 1 });
    const user = userEvent.setup();
    await openDetail(["3.0.0", "2.1.0", "1.0.0"], "1.0.0");
    await pick(user, "2.1.0");
    await user.click(await screen.findByRole("button", { name: "Switch to 2.1.0" }));

    const dialog = await screen.findByRole("dialog");
    within(dialog).getByText(/verified only up to version 1\.5\.0\. Version 2\.1\.0 is newer and has NOT been reviewed\./);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(installBridge).not.toHaveBeenCalled();
    expect(usePins.getState().pins).toEqual({});
  });
});
