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
import { FALLBACK_VOCABULARY } from "@/extensions/store-categories";
import { usePins } from "@/extensions/pins";
import { useTrust } from "@/extensions/trust";
import type { ExtensionManifest, ExtensionSearchResult, TrustList } from "@/extensions/types";
import { useSettings } from "@/state/settings-store";
import { resetSetupForTests } from "@/modules/welcome/setup/setup-store";

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
    useExtStoreUI.setState({ browse: "home", railExpanded: false });
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

// Starter kits live on the Browse home now: a shelf after Featured, hiding
// kits with nothing left to install, and a kit page whose Install all goes
// through the same risk acknowledgement as any first install.
describe("ExtensionManagerPanel starter kits", () => {
  const listing = (fullName: string): ExtensionSearchResult => ({
    fullName,
    description: null,
    stars: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    source: "registry",
  });
  const kitsJson = {
    schema: 1,
    kits: [
      {
        id: "film",
        name: "Film looks",
        description: "Film stock simulation.",
        icon: "film",
        extensions: [{ repo: "acme/reviewed-tool", name: "Reviewed Tool", summary: "Does film." }],
      },
      {
        id: "done",
        name: "Already done",
        description: "",
        icon: "style",
        extensions: [{ repo: "acme/installed-tool", name: "Installed Tool", summary: "" }],
      },
    ],
  };

  beforeEach(() => {
    resetSetupForTests();
    useExtStoreUI.setState({
      browse: "home",
      railExpanded: false,
      kit: null,
      kits: null,
      kitRuns: {},
      kitRunning: null,
      view: "list",
      selected: null,
    });
    useTrust.setState({
      list: { verified: ["acme/reviewed-tool", "acme/installed-tool"], reviewed: {}, repos: [], owners: [], reason: {} },
      loadedAt: 1,
      flagged: [],
    });
    localStorage.setItem("sl_ext_sources", JSON.stringify({ "acme.installed": "acme/installed-tool" }));
    vi.stubGlobal("safelightNative", {
      plugins: {
        list: async () => [{ id: "acme.installed", name: "Installed Tool", version: "1.0.0", main: "index.js" }],
        install: installBridge,
        search: async () => [listing("acme/reviewed-tool"), listing("acme/installed-tool")],
        kits: async () => kitsJson,
      },
    });
  });

  afterEach(() => useTrust.setState({ list: { verified: [], reviewed: {}, repos: [], owners: [], reason: {} }, loadedAt: 0, flagged: [] }));

  it("shows the shelf after Featured, with no Starter kits button left", async () => {
    mountStore();
    await screen.findByRole("button", { name: /Film looks/ });
    expect(screen.queryByRole("button", { name: "Starter kits" })).toBeNull();
    const featured = screen.getByText("Featured");
    const kits = screen.getByText("Starter kits");
    const fresh = screen.getByText("New");
    expect(featured.compareDocumentPosition(kits) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(kits.compareDocumentPosition(fresh) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides a kit with nothing left to install", async () => {
    mountStore();
    await screen.findByRole("button", { name: /Film looks/ });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Already done/ })).toBeNull());
  });

  it("opens a kit page whose Install all asks for the acknowledgement, then installs", async () => {
    const user = userEvent.setup();
    mountStore();
    await user.click(await screen.findByRole("button", { name: /Film looks/ }));
    screen.getByRole("heading", { name: "Film looks" });
    await user.click(screen.getByRole("button", { name: "Install all (1)" }));
    const ack = await screen.findByRole("dialog");
    await user.click(within(ack).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(installBridge).toHaveBeenCalledWith("acme/reviewed-tool"));
    expect(localStorage.getItem(RISK_ACK_KEY)).toBe("1");
  });

  it("holds installs while a kit run started before the window reopened continues", async () => {
    localStorage.setItem(RISK_ACK_KEY, "1");
    let finish!: (m: ExtensionManifest) => void;
    const install = vi.fn(
      () =>
        new Promise<ExtensionManifest>((resolve) => {
          finish = resolve;
        }),
    );
    const listed: ExtensionManifest[] = [{ id: "acme.installed", name: "Installed Tool", version: "1.0.0", main: "index.js" }];
    vi.stubGlobal("safelightNative", {
      plugins: {
        list: async () => [...listed],
        install,
        search: async () => [listing("acme/reviewed-tool"), listing("acme/installed-tool")],
        kits: async () => kitsJson,
      },
    });
    const user = userEvent.setup();
    const first = mountStore();
    await user.click(await screen.findByRole("button", { name: /Film looks/ }));
    await user.click(screen.getByRole("button", { name: "Install all (1)" }));
    await waitFor(() => expect(install).toHaveBeenCalled());
    first.unmount();

    mountStore();
    const running = await screen.findByRole("button", { name: "Installing…" });
    expect((running as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "← Browse" }));
    const installs = await screen.findAllByRole("button", { name: "Install" });
    expect(installs.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);

    // The run ends: the reopened window re-reads what's installed.
    listed.push({ id: "acme.reviewed", name: "Reviewed Tool", version: "1.0.0", main: "index.js" });
    localStorage.setItem(
      "sl_ext_sources",
      JSON.stringify({ "acme.installed": "acme/installed-tool", "acme.reviewed": "acme/reviewed-tool" }),
    );
    finish({ id: "acme.reviewed", name: "Reviewed Tool", version: "1.0.0", main: "index.js" });
    await waitFor(() => expect(useExtStoreUI.getState().kitRunning).toBeNull());
    await waitFor(() => expect(screen.queryByText("reviewed-tool")).toBeNull());
  });

  it("leaves the kit page when a category is picked in the rail", async () => {
    const user = userEvent.setup();
    mountStore();
    await user.click(await screen.findByRole("button", { name: /Film looks/ }));
    await user.click(screen.getByRole("button", { name: "Show categories" }));
    await user.click(screen.getByRole("button", { name: "Looks" }));
    expect(screen.queryByRole("heading", { name: "Film looks" })).toBeNull();
    screen.getByRole("heading", { name: "Looks" });
  });
});

describe("ExtensionManagerPanel kept versions and release notes", () => {
  const installed = {
    id: "acme.widget",
    name: "Widget",
    version: "1.0.0",
    main: "index.js",
    repository: "acme/widget",
  };
  let releases: Mock;

  beforeEach(() => {
    useExtStoreUI.setState({ updates: {}, releases: {} });
    usePins.setState({ pins: {} });
    releases = vi.fn(async () => [
      { version: "2.1.0", tag: "v2.1.0", prerelease: false, publishedAt: "", notes: "Faster grain.", htmlUrl: "" },
    ]);
    vi.stubGlobal("safelightNative", {
      plugins: {
        list: async () => [installed],
        install: installBridge,
        remoteManifest: async () => ({ version: "2.1.0" }),
        releases,
      },
    });
  });

  afterEach(() => usePins.setState({ pins: {} }));

  it("lists a kept extension without counting it in the badge", async () => {
    usePins.setState({ pins: { "acme.widget": "1.0.0" } });
    const user = userEvent.setup();
    mountStore();
    await user.click(screen.getByRole("button", { name: "Updates" }));
    await screen.findByText("Kept at 1.0.0 · 2.1.0 is available");
    expect(screen.getByRole("button", { name: /^Updates/ }).textContent).toBe("Updates");
  });

  it("counts an update that isn't kept", async () => {
    mountStore();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Updates/ }).textContent).toBe("Updates1"),
    );
  });

  it("shows the update's release notes on request", async () => {
    const user = userEvent.setup();
    mountStore();
    await user.click(screen.getByRole("button", { name: /^Updates/ }));
    await user.click(await screen.findByRole("button", { name: /What's new/ }));
    await screen.findByText("Faster grain.");
    expect(releases).toHaveBeenCalledWith("acme/widget", false);
  });

  it("updates to the version the check offered", async () => {
    const user = userEvent.setup();
    mountStore();
    await user.click(screen.getByRole("button", { name: /^Updates/ }));
    await user.click(await screen.findByRole("button", { name: "Update" }));
    await waitFor(() => expect(installBridge).toHaveBeenCalledWith("acme/widget", "2.1.0"));
  });
});

// Browse by category: the chips row is gone; the rail lists the registry's
// categories on request, and a category page shows its header and members.
describe("ExtensionManagerPanel categories", () => {
  const r = (fullName: string, over: Partial<ExtensionSearchResult> = {}): ExtensionSearchResult => ({
    fullName,
    description: null,
    stars: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    source: "registry",
    ...over,
  });
  const catalog = [
    r("acme/warp", { categories: ["detail"], type: "pipeline" }),
    r("acme/denoise", { categories: ["detail"] }),
    r("acme/grade", { categories: ["color"] }),
    r("acme/mystery", { categories: [] }),
  ];
  let list: () => Promise<{ id: string; name: string; version: string; main: string }[]>;

  beforeEach(() => {
    useExtStoreUI.setState({
      browse: "home",
      railExpanded: false,
      vocabulary: FALLBACK_VOCABULARY,
      view: "list",
      selected: null,
    });
    list = async () => [];
    vi.stubGlobal("safelightNative", {
      plugins: {
        list: () => list(),
        install: installBridge,
        search: async (q: string) => (q ? catalog.filter((x) => x.fullName.includes(q)) : catalog),
        vocabulary: async () => FALLBACK_VOCABULARY,
      },
    });
  });

  const openCategory = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await screen.findAllByText("warp");
    await user.click(screen.getByRole("button", { name: "Show categories" }));
    await user.click(screen.getByRole("button", { name }));
  };

  it("has no chips row; the rail lists the categories and Other on request", async () => {
    const user = userEvent.setup();
    mountStore();
    await screen.findAllByText("warp");
    expect(screen.queryByRole("button", { name: "All" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show categories" }));
    screen.getByRole("button", { name: "Detail and repair" });
    screen.getByRole("button", { name: "Other" });
  });

  it("shows a category's header, description, sort and members only", async () => {
    const user = userEvent.setup();
    mountStore();
    await openCategory(user, "Detail and repair");
    screen.getByRole("heading", { name: "Detail and repair" });
    screen.getByText(/Noise, lens faults/);
    screen.getByTitle("Sort");
    screen.getByText("warp");
    screen.getByText("denoise");
    expect(screen.queryByText("grade")).toBeNull();
    screen.getByText("Detail and repair · Processing");
  });

  it("lists uncategorised extensions under Other", async () => {
    const user = userEvent.setup();
    mountStore();
    await openCategory(user, "Other");
    screen.getByText("mystery");
    expect(screen.queryByText("warp")).toBeNull();
  });

  it("says when a category has nothing yet", async () => {
    const user = userEvent.setup();
    mountStore();
    await openCategory(user, "Tone");
    await screen.findByText("No Tone extensions yet.");
  });

  it("says when every extension in a category is installed", async () => {
    localStorage.setItem("sl_ext_sources", JSON.stringify({ "acme.grade": "acme/grade" }));
    list = async () => [{ id: "acme.grade", name: "Grade", version: "1.0.0", main: "index.js" }];
    const user = userEvent.setup();
    mountStore();
    await openCategory(user, "Colour");
    await screen.findByText("You have every Colour extension installed.");
  });

  it("searches within the open category", async () => {
    const user = userEvent.setup();
    mountStore();
    await openCategory(user, "Detail and repair");
    await user.type(screen.getByLabelText("Search official extensions"), "grade");
    await screen.findByText(/No new extensions found for “grade” in Detail and repair/);
  });

  it("falls back to the home page when the open category is no longer in the vocabulary", async () => {
    useExtStoreUI.setState({ browse: "retired" });
    mountStore();
    await screen.findAllByText("warp");
    await waitFor(() => expect(useExtStoreUI.getState().browse).toBe("home"));
    screen.getAllByText("Popular");
  });

  it("keeps the Other row while a search on Other matches nothing uncategorised", async () => {
    const user = userEvent.setup();
    mountStore();
    await openCategory(user, "Other");
    await user.type(screen.getByLabelText("Search official extensions"), "warp");
    await screen.findByText(/No new extensions found for “warp” in Other/);
    screen.getByRole("button", { name: "Other" });
  });
});

// The detail page's chips, Works with and More shelves draw on the whole
// catalog, not on whatever the Browse search last matched.
describe("ExtensionManagerPanel detail page store sections", () => {
  const r = (fullName: string, over: Partial<ExtensionSearchResult> = {}): ExtensionSearchResult => ({
    fullName,
    description: null,
    stars: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    source: "registry",
    ...over,
  });
  const catalog = [
    r("acme/warp", { categories: ["detail"], type: "pipeline", worksWith: ["other/map"] }),
    r("acme/denoise", { categories: ["detail"], stars: 3 }),
    r("other/map", { categories: ["metadata"] }),
    r("other/fix", { categories: ["detail"], stars: 2 }),
  ];
  let list: () => Promise<{ id: string; name: string; version: string; main: string }[]>;

  beforeEach(() => {
    useExtStoreUI.setState({
      browse: "home",
      railExpanded: false,
      vocabulary: FALLBACK_VOCABULARY,
      view: "list",
      selected: null,
      kit: null,
      kits: null,
    });
    list = async () => [];
    vi.stubGlobal("safelightNative", {
      plugins: {
        list: () => list(),
        install: installBridge,
        search: async (q: string) => (q ? catalog.filter((x) => x.fullName.includes(q)) : catalog),
        vocabulary: async () => FALLBACK_VOCABULARY,
      },
    });
  });

  const installWarp = () => {
    localStorage.setItem("sl_ext_sources", JSON.stringify({ "acme.warp": "acme/warp" }));
    list = async () => [{ id: "acme.warp", name: "Warp", version: "1.0.0", main: "index.js" }];
  };

  it("lists Works with and More shelves from the catalog after a search narrowed Browse", async () => {
    const user = userEvent.setup();
    mountStore();
    await screen.findAllByText("denoise");
    await user.type(screen.getByLabelText("Search official extensions"), "warp");
    await waitFor(() => expect(screen.queryByText("denoise")).toBeNull());
    await user.click(screen.getByText("warp"));
    screen.getByRole("button", { name: "← Back" });
    screen.getByText("Works with");
    screen.getByText("map");
    screen.getByText("More from acme");
    screen.getByText("More in Detail and repair");
    screen.getByText("fix");
    expect(screen.getAllByText("denoise").length).toBeGreaterThan(0);
  });

  it("opens a Works with card at the top of its own page", async () => {
    const user = userEvent.setup();
    mountStore();
    await user.click((await screen.findAllByText("warp"))[0]);
    const first =screen.getByText("Works with").closest(".overflow-y-auto") as HTMLElement;
    first.scrollTop = 200;
    await user.click(screen.getByText("map"));
    const next = screen.getByText("More from other").closest(".overflow-y-auto") as HTMLElement;
    expect(next.scrollTop).toBe(0);
  });

  it("re-reads the catalog when ↻ is pressed with a search set", async () => {
    let served = catalog;
    vi.stubGlobal("safelightNative", {
      plugins: {
        list: () => list(),
        install: installBridge,
        search: async (q: string) => (q ? served.filter((x) => x.fullName.includes(q)) : served),
        vocabulary: async () => FALLBACK_VOCABULARY,
      },
    });
    const user = userEvent.setup();
    mountStore();
    await screen.findAllByText("denoise");
    await user.type(screen.getByLabelText("Search official extensions"), "warp");
    await waitFor(() => expect(screen.queryByText("denoise")).toBeNull());
    served = [...catalog, r("acme/fresh", { categories: ["tone"] })];
    await user.click(screen.getByTitle("Reload the extension list and search results"));
    await waitFor(() =>
      expect(
        (screen.getByTitle("Reload the extension list and search results") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByText("warp"));
    await screen.findByText("fresh");
  });

  it("keeps an installed extension's badge and chips when Browse holds a search that misses it", async () => {
    installWarp();
    const user = userEvent.setup();
    mountStore();
    await screen.findAllByText("denoise");
    await user.type(screen.getByLabelText("Search official extensions"), "map");
    await waitFor(() => expect(screen.queryByText("denoise")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Installed" }));
    await user.click(await screen.findByRole("button", { name: /Warp v1\.0\.0/ }));
    screen.getByText("Processing");
    screen.getByRole("button", { name: "Detail and repair" });
    screen.getByText("Works with");
  });

  it("opens a chip's category in Browse", async () => {
    installWarp();
    const user = userEvent.setup();
    mountStore();
    await screen.findAllByText("denoise");
    await user.click(screen.getByRole("button", { name: "Installed" }));
    await user.click(await screen.findByRole("button", { name: /Warp v1\.0\.0/ }));
    await user.click(screen.getByRole("button", { name: "Detail and repair" }));
    expect(screen.queryByRole("button", { name: "← Back" })).toBeNull();
    screen.getByRole("heading", { name: "Detail and repair" });
    expect(screen.getByRole("button", { name: "Browse" }).getAttribute("aria-current")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Detail and repair" }).getAttribute("aria-current"),
    ).toBe("page");
    screen.getByText("denoise");
  });
});
