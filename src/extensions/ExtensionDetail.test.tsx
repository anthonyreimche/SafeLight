// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The detail page's update states: a version this build can't run is explained
// without an Update button; one that failed to start here is explained and can
// be retried. No bridge is stubbed, so the GitHub fetches no-op.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExtensionDetail, type DetailTarget } from "./ExtensionDetail";
import { useExtStoreUI, type ExtUpdateInfo } from "./store-ui";
import type { ExtensionRelease, RemoteManifest } from "./types";
import { usePins } from "./pins";

const ID = "acme.widget";

const target: DetailTarget = {
  repo: "acme/widget",
  id: ID,
  name: "Widget",
  installed: true,
  manifest: { id: ID, name: "Widget", version: "1.0.0", main: "index.js" },
  enabled: true,
  locked: false,
  hasSettings: false,
};

const record = (over: Partial<ExtUpdateInfo>): ExtUpdateInfo => ({
  latestTag: "2.1.0",
  hasUpdate: true,
  requiresApp: null,
  failed: null,
  checkedAt: Date.now(),
  ...over,
});

const mount = (
  update: ExtUpdateInfo | null,
  t: DetailTarget = target,
  onInstall: Mock = vi.fn(),
) => {
  useExtStoreUI.setState({ updates: update ? { [ID]: update } : {} });
  render(
    <ExtensionDetail
      target={t}
      busy={null}
      onInstall={onInstall}
      onUpdate={vi.fn()}
      onUninstall={vi.fn()}
      onToggle={vi.fn()}
      onSettings={vi.fn()}
    />,
  );
  return { onInstall };
};

const rel = (version: string, notes = `Notes for ${version}`, prerelease = false): ExtensionRelease => ({
  version,
  tag: `v${version}`,
  prerelease,
  publishedAt: "2026-10-01T00:00:00Z",
  notes,
  htmlUrl: "",
});

let releasesBridge: Mock;
let manifestAt: Mock;
const withReleases = (list: ExtensionRelease[] | Error, manifest: RemoteManifest | null = null) => {
  releasesBridge = vi.fn(async () => {
    if (list instanceof Error) throw list;
    return list;
  });
  manifestAt = vi.fn(async () => manifest);
  vi.stubGlobal("safelightNative", { plugins: { releases: releasesBridge, manifestAt } });
};

beforeEach(() => {
  useExtStoreUI.setState({ updates: {}, meta: {}, readme: {}, releases: {} });
  usePins.setState({ pins: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ExtensionDetail update states", () => {
  it("offers an installable update", () => {
    mount(record({}));
    screen.getByRole("button", { name: "Update to 2.1.0" });
  });

  it("explains an update this build can't run instead of offering it", () => {
    mount(record({ requiresApp: "99.0.0" }));
    screen.getByText(/Version 2\.1\.0 requires Safelight 99\.0\.0 or newer/);
    expect(screen.queryByRole("button", { name: /^Update to/ })).toBeNull();
  });

  it("explains a failed start and still allows a retry", () => {
    mount(record({ failed: { version: "2.1.0", error: "boom" } }));
    screen.getByText("Version 2.1.0 didn't start on this build; 1.0.0 was restored.");
    screen.getByRole("button", { name: "Update to 2.1.0" });
  });
});

describe("ExtensionDetail release notes", () => {
  const notInstalled: DetailTarget = { ...target, installed: false, manifest: undefined, id: undefined };

  it("shows every release between the installed version and the update", async () => {
    withReleases([rel("2.1.0"), rel("2.0.0"), rel("1.0.0")]);
    mount(record({}));
    await screen.findByText("What's new");
    screen.getByText("Notes for 2.1.0");
    screen.getByText("Notes for 2.0.0");
    expect(screen.queryByText("Notes for 1.0.0")).toBeNull();
  });

  it("shows the latest release's notes before install", async () => {
    withReleases([rel("2.1.0"), rel("2.0.0")]);
    mount(null, notInstalled);
    await screen.findByText("Notes for 2.1.0");
    expect(screen.queryByText("Notes for 2.0.0")).toBeNull();
  });

  it("leaves the section out when the releases have no notes", async () => {
    withReleases([rel("2.1.0", ""), rel("2.0.0", "")]);
    mount(record({}));
    await waitFor(() =>
      expect(useExtStoreUI.getState().releases["acme/widget"]?.status).toBe("ready"),
    );
    expect(screen.queryByText("What's new")).toBeNull();
  });
});

describe("ExtensionDetail version picker", () => {
  const pick = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
    await user.click(await screen.findByRole("combobox", { name: "Version" }));
    await user.click(screen.getByRole("option", { name: label }));
  };

  it("lists the versions and switches to an older one", async () => {
    withReleases([rel("2.1.0"), rel("2.0.0"), rel("1.0.0")]);
    const { onInstall } = mount(null);
    const user = userEvent.setup();
    await pick(user, "2.0.0");
    await user.click(await screen.findByRole("button", { name: "Switch to 2.0.0" }));
    expect(onInstall).toHaveBeenCalledWith("acme/widget", "2.0.0");
  });

  it("offers no switch to the version already installed", async () => {
    withReleases([rel("2.1.0"), rel("1.0.0")]);
    mount(null);
    const user = userEvent.setup();
    await pick(user, "1.0.0 · installed");
    expect(screen.queryByRole("button", { name: /^Switch to/ })).toBeNull();
  });

  it("blocks a version that needs a newer Safelight", async () => {
    withReleases([rel("2.1.0"), rel("2.0.0"), rel("1.0.0")], { version: "2.0.0", minAppVersion: "99.0.0" });
    mount(null);
    const user = userEvent.setup();
    await pick(user, "2.0.0");
    await screen.findByText("Needs Safelight 99.0.0 or newer");
    expect(screen.queryByRole("button", { name: "Switch to 2.0.0" })).toBeNull();
    expect(manifestAt).toHaveBeenCalledWith("acme/widget", "2.0.0");
  });

  it("blocks a release whose manifest disagrees with its tag", async () => {
    withReleases([rel("2.1.0"), rel("2.0.0"), rel("1.0.0")], { version: "1.9.0" });
    mount(null);
    const user = userEvent.setup();
    await pick(user, "2.0.0");
    await screen.findByText("This release's safelight.json says 1.9.0");
  });

  it("says a repo without releases installs from its branch", async () => {
    withReleases([]);
    mount(null);
    await screen.findByText("Installs from the main branch; this extension publishes no releases.");
    expect(screen.queryByRole("combobox", { name: "Version" })).toBeNull();
  });

  it("says why versions are unavailable", async () => {
    withReleases(
      new Error(
        "Error invoking remote method 'plugins:releases': Error: v1.3.0: safelight.json says 1.2.0",
      ),
    );
    mount(null);
    await screen.findByText("Versions unavailable: v1.3.0: safelight.json says 1.2.0");
  });

  it("shows the version an extension is kept at", () => {
    usePins.setState({ pins: { [ID]: "1.0.0" } });
    mount(null);
    screen.getByText("Kept at 1.0.0");
  });

  it("checks GitHub again on request", async () => {
    withReleases([rel("2.1.0"), rel("1.0.0")]);
    mount(null);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Refresh versions" }));
    expect(releasesBridge).toHaveBeenLastCalledWith("acme/widget", true);
  });

  // A first release is picked up by the same refresh.
  it("checks GitHub again for a repo that publishes from its branch", async () => {
    withReleases([]);
    mount(null);
    const user = userEvent.setup();
    await screen.findByText("Installs from the main branch; this extension publishes no releases.");
    await user.click(screen.getByRole("button", { name: "Refresh versions" }));
    expect(releasesBridge).toHaveBeenLastCalledWith("acme/widget", true);
  });
});

describe("ExtensionDetail Latest", () => {
  const installedAt = (version: string): DetailTarget => ({
    ...target,
    manifest: { ...target.manifest!, version },
  });

  it("switches an installed pre-release back to the latest full release", async () => {
    withReleases([rel("1.4.0-beta.1", "", true), rel("1.3.0"), rel("1.2.0")]);
    const { onInstall } = mount(null, installedAt("1.4.0-beta.1"));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Switch to 1.3.0" }));
    expect(onInstall).toHaveBeenCalledWith("acme/widget", "1.3.0");
  });

  it("offers no switch when the latest full release is installed", async () => {
    withReleases([rel("1.3.0"), rel("1.2.0")]);
    mount(null, installedAt("1.3.0"));
    await screen.findByRole("combobox", { name: "Version" });
    expect(screen.queryByRole("button", { name: /^Switch to/ })).toBeNull();
  });

  it("leaves a pending update to the Update button", async () => {
    withReleases([rel("2.1.0"), rel("1.0.0")]);
    mount(record({}));
    await screen.findByRole("combobox", { name: "Version" });
    screen.getByRole("button", { name: "Update to 2.1.0" });
    expect(screen.queryByRole("button", { name: /^Switch to/ })).toBeNull();
  });
});
