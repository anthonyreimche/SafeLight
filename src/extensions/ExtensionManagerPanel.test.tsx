// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Install-flow trust prompts. Native window.confirm suspends Electron's
// renderer and can desync window focus (keystrokes stop reaching inputs until
// refocus/restart — electron#31917), so the trust gates must run through the
// in-app confirmDialog. These tests drive the custom-repo import journey and
// pin that window.confirm is never invoked along the way. The seam is the
// Electron bridge (window.safelightNative): the real loader runs, and reaching
// plugins.install is the "install proceeded" signal. The bundle activation
// that follows needs the app:// protocol and is out of jsdom's reach.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialogHost } from "@/ui/components/ConfirmDialog";
import { ExtensionManagerPanel } from "@/extensions/ExtensionManagerPanel";
import { useExtStoreUI } from "@/extensions/store-ui";
import { useTrust } from "@/extensions/trust";
import type { ExtensionSearchResult, TrustList } from "@/extensions/types";
import { useSettings } from "@/state/settings-store";

const RISK_ACK_KEY = "sl_ext_risk_ack_v1";

let installBridge: Mock;
let confirmSpy: MockInstance<Window["confirm"]>;

beforeEach(() => {
  localStorage.clear();
  // Bridge present ⇒ the panel opens on Browse, where the custom-repo importer
  // lives. No trustList ⇒ nothing is verified, so the import takes the
  // unreviewed path under test.
  installBridge = vi.fn(async () => ({
    id: "acme.widget",
    name: "Widget",
    version: "1.0.0",
    main: "index.js",
  }));
  vi.stubGlobal("safelightNative", {
    plugins: { list: async () => [], install: installBridge },
  });
  // Answering "yes" keeps the legacy native path observable rather than crashing
  // on jsdom's unimplemented confirm — the assertion is that it never runs.
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  confirmSpy.mockRestore();
});

const mountStore = () =>
  render(
    <>
      <ExtensionManagerPanel />
      <ConfirmDialogHost />
    </>,
  );

const importRepo = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(
    screen.getByLabelText("Install extension from GitHub (owner/repo, branch, or URL)"),
    "acme/widget",
  );
  await user.click(screen.getByRole("button", { name: "Import" }));
};

describe("ExtensionManagerPanel install trust prompts", () => {
  it("runs both trust gates through the in-app dialog, never window.confirm", async () => {
    const user = userEvent.setup();
    mountStore();
    await importRepo(user);

    const ack = await screen.findByRole("dialog");
    within(ack).getByText(/third-party software/);
    await user.click(within(ack).getByRole("button", { name: "Continue" }));

    const unreviewed = await screen.findByRole("dialog");
    within(unreviewed).getByText(/hasn't been reviewed/);
    await user.click(within(unreviewed).getByRole("button", { name: "Install anyway" }));

    await waitFor(() => expect(installBridge).toHaveBeenCalledWith("acme/widget"));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(RISK_ACK_KEY)).toBe("1");
  });

  it("cancelling the risk acknowledgment aborts the install", async () => {
    const user = userEvent.setup();
    mountStore();
    await importRepo(user);

    const ack = await screen.findByRole("dialog");
    await user.click(within(ack).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(installBridge).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(RISK_ACK_KEY)).toBeNull();
  });

  it("a recorded risk acknowledgment goes straight to the unreviewed prompt", async () => {
    localStorage.setItem(RISK_ACK_KEY, "1");
    const user = userEvent.setup();
    mountStore();
    await importRepo(user);

    const unreviewed = await screen.findByRole("dialog");
    within(unreviewed).getByText(/hasn't been reviewed/);
    await user.click(within(unreviewed).getByRole("button", { name: "Install anyway" }));

    await waitFor(() => expect(installBridge).toHaveBeenCalledWith("acme/widget"));
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

// The Updates tab must tell the user about a newer version this build can't run
// without offering a doomed Update button or a badge they cannot clear.
describe("ExtensionManagerPanel Updates tab", () => {
  const installed = {
    id: "acme.widget",
    name: "Widget",
    version: "1.0.0",
    main: "index.js",
    repository: "acme/widget",
  };

  beforeEach(() => {
    useExtStoreUI.setState({ updates: {} });
    vi.stubGlobal("safelightNative", {
      plugins: {
        list: async () => [installed],
        install: installBridge,
        remoteManifest: async () => ({ version: "2.1.0", minAppVersion: "99.0.0" }),
      },
    });
  });

  it("lists an update this build can't run without offering to install it", async () => {
    const user = userEvent.setup();
    mountStore();
    await user.click(screen.getByRole("button", { name: "Updates" }));

    await screen.findByText(/Version 2\.1\.0 requires Safelight 99\.0\.0 or newer/);
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    expect(screen.getByRole("button", { name: "Updates" }).textContent).toBe("Updates");
  });
});

// "Only verified extensions" restricts the store to the allowlist: unverified
// results are hidden from Browse (shelves and the flat grid alike), not merely
// refused at install. On a first launch the trust list can land after the search
// results, so the filter has to follow the trust store rather than read it once.
describe("ExtensionManagerPanel verified-only browse", () => {
  const result = (fullName: string): ExtensionSearchResult => ({
    fullName,
    description: null,
    stars: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    source: "registry",
  });
  const results = [result("acme/reviewed-tool"), result("acme/random-tool")];
  const allowlist = (verified: string[]): TrustList => ({
    verified,
    reviewed: {},
    repos: [],
    owners: [],
    reason: {},
  });

  beforeEach(() => {
    useExtStoreUI.setState({ category: "All" });
    useTrust.setState({
      list: allowlist(["acme/reviewed-tool"]),
      loadedAt: 1,
      flagged: [],
    });
    vi.stubGlobal("safelightNative", {
      plugins: {
        list: async () => [],
        install: installBridge,
        search: async () => results,
      },
    });
  });

  afterEach(() => {
    useSettings.setState({ onlyVerifiedExtensions: false });
    useTrust.setState({ list: allowlist([]), loadedAt: 0, flagged: [] });
  });

  it("shows every result while the setting is off", async () => {
    mountStore();
    await screen.findAllByText("random-tool");
    screen.getAllByText("reviewed-tool");
    expect(screen.queryByText(/unverified extension/)).toBeNull();
  });

  it("hides unverified results from the shelves", async () => {
    useSettings.setState({ onlyVerifiedExtensions: true });
    mountStore();
    await screen.findAllByText("reviewed-tool");
    expect(screen.queryByText("random-tool")).toBeNull();
    // Every shelf is the verified set now, so Featured would only repeat Popular.
    expect(screen.queryByText("Featured")).toBeNull();
    screen.getByText("New");
    screen.getByText("Popular");
    screen.getByText("Recently updated");
    screen.getByText(/1 unverified extension hidden/);
  });

  it("hides unverified results from the search grid", async () => {
    useSettings.setState({ onlyVerifiedExtensions: true });
    const user = userEvent.setup();
    mountStore();
    await user.type(screen.getByLabelText("Search official extensions"), "tool");
    await screen.findByText("reviewed-tool");
    expect(screen.queryByText("random-tool")).toBeNull();
    screen.getByText(/1 unverified extension hidden/);
  });

  it("re-filters once the trust list lands after the results", async () => {
    useSettings.setState({ onlyVerifiedExtensions: true });
    useTrust.setState({ list: allowlist([]), loadedAt: 0, flagged: [] });
    let deliver!: (list: TrustList) => void;
    vi.stubGlobal("safelightNative", {
      plugins: {
        list: async () => [],
        install: installBridge,
        search: async () => results,
        trustList: () =>
          new Promise<TrustList>((resolve) => {
            deliver = resolve;
          }),
      },
    });
    mountStore();
    await screen.findByText(/2 unverified extensions hidden/);
    expect(screen.queryByText("reviewed-tool")).toBeNull();

    deliver(allowlist(["acme/reviewed-tool"]));
    await screen.findAllByText("reviewed-tool");
    expect(screen.queryByText("random-tool")).toBeNull();
    screen.getByText(/1 unverified extension hidden/);
  });
});
