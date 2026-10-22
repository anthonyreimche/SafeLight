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
import { ExtensionDetail, type DetailTarget, type RelatedLists } from "./ExtensionDetail";
import { useExtStoreUI, type ExtUpdateInfo } from "./store-ui";
import type { ExtensionRelease, ExtensionSearchResult, RemoteManifest } from "./types";
import { usePins } from "./pins";
import { FALLBACK_VOCABULARY } from "./store-categories";
import { useSettings } from "@/state/settings-store";
import { useTrust } from "./trust";

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

// What the store knows about an extension: its type badge and category chips,
// screenshots, the extensions it works with, and more from its author and its
// first category. Lists that offer an install follow "Only verified".
describe("ExtensionDetail store links", () => {
  const listing = (fullName: string, over: Partial<ExtensionSearchResult> = {}): ExtensionSearchResult => ({
    fullName,
    description: null,
    stars: 1,
    updatedAt: "2026-01-01T00:00:00Z",
    source: "registry",
    ...over,
  });
  const self = listing("acme/warp", {
    categories: ["detail", "tone"],
    type: "pipeline",
    screenshots: ["https://e.com/a.png"],
    worksWith: ["acme/gps", "other/map"],
  });
  const results = [
    self,
    listing("acme/gps", { categories: ["metadata"], stars: 5 }),
    listing("other/map", { categories: ["metadata"] }),
    listing("other/denoise", { categories: ["detail"], stars: 9 }),
    listing("acme/scopes", { categories: ["color"], stars: 2 }),
  ];
  const browseTarget: DetailTarget = {
    repo: "acme/warp",
    name: "warp",
    installed: false,
    enabled: false,
    locked: false,
    hasSettings: false,
    search: self,
  };
  const mountRelated = (over: Partial<RelatedLists> = {}) => {
    const related: RelatedLists = {
      results,
      isInstalled: (r) => r.fullName === "acme/gps",
      onOpen: vi.fn(),
      onInstall: vi.fn(),
      onCategory: vi.fn(),
      ...over,
    };
    render(
      <ExtensionDetail
        target={browseTarget}
        busy={null}
        onInstall={vi.fn()}
        onUpdate={vi.fn()}
        onUninstall={vi.fn()}
        onToggle={vi.fn()}
        onSettings={vi.fn()}
        related={related}
      />,
    );
    return related;
  };

  beforeEach(() => {
    useExtStoreUI.setState({ vocabulary: FALLBACK_VOCABULARY });
    useTrust.setState({
      list: { verified: ["acme/gps"], reviewed: {}, repos: [], owners: [], reason: {} },
      loadedAt: 1,
      flagged: [],
    });
  });

  afterEach(() => {
    useSettings.setState({ onlyVerifiedExtensions: false });
    useTrust.setState({ list: { verified: [], reviewed: {}, repos: [], owners: [], reason: {} }, loadedAt: 0, flagged: [] });
  });

  it("shows the type badge and category chips that open their category", async () => {
    const user = userEvent.setup();
    const related = mountRelated();
    screen.getByText("Processing");
    screen.getByRole("button", { name: "Detail and repair" });
    await user.click(screen.getByRole("button", { name: "Tone" }));
    expect(related.onCategory).toHaveBeenCalledWith("tone");
  });

  it("shows the screenshots", () => {
    mountRelated();
    screen.getByAltText("Screenshot 1");
  });

  it("lists companions, an installed one as Installed", () => {
    mountRelated();
    screen.getByText("Works with");
    screen.getByText("gps");
    screen.getByText("map");
    screen.getByText("Installed");
  });

  it("hides unverified companions under Only verified extensions", () => {
    useSettings.setState({ onlyVerifiedExtensions: true });
    mountRelated();
    screen.getByText("gps");
    expect(screen.queryByText("map")).toBeNull();
  });

  it("offers more from the author and the first category, without itself or installed ones", () => {
    mountRelated();
    screen.getByText("More from acme");
    screen.getByText("scopes");
    screen.getByText("More in Detail and repair");
    screen.getByText("denoise");
    expect(screen.getAllByText("warp")).toHaveLength(1);
    expect(screen.getAllByText("gps")).toHaveLength(1);
  });

  it("keeps the badge and screenshots but no links without related lists", () => {
    render(
      <ExtensionDetail
        target={browseTarget}
        busy={null}
        onInstall={vi.fn()}
        onUpdate={vi.fn()}
        onUninstall={vi.fn()}
        onToggle={vi.fn()}
        onSettings={vi.fn()}
      />,
    );
    screen.getByText("Processing");
    screen.getByAltText("Screenshot 1");
    expect(screen.queryByRole("button", { name: "Tone" })).toBeNull();
    expect(screen.queryByText("Works with")).toBeNull();
  });

  it("resolves an installed extension's manifest screenshots against its repo", () => {
    render(
      <ExtensionDetail
        target={{
          ...target,
          manifest: { ...target.manifest!, screenshots: ["docs/shot.png"] },
        }}
        busy={null}
        onInstall={vi.fn()}
        onUpdate={vi.fn()}
        onUninstall={vi.fn()}
        onToggle={vi.fn()}
        onSettings={vi.fn()}
      />,
    );
    expect(screen.getByAltText("Screenshot 1").getAttribute("src")).toMatch(/acme\/widget.*docs\/shot\.png$/);
  });
});
