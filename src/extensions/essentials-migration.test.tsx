// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Moving an existing profile from the built-ins to the official extensions
// that replace them. Most tests name the rows they treat as extracted; installs
// go through injected deps.

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { EssentialsNotice } from "@/ui/components/EssentialsNotice";
import type { ExtensionManifest } from "./types";
import {
  OFFICIAL_EXTENSIONS,
  officialExtension,
  type OfficialExtension,
} from "./official-extensions";
import { InstallSupersededError, useDisabledExtensions } from "./loader";
import { useUserLayouts, type UserLayout } from "./dock";
import {
  MIGRATION_KEY,
  classifyProfile,
  ensureCoreModules,
  extractedEssentials,
  installEssentials,
  installMissingEssentials,
  prepareEssentialsMigration,
  retryEssentials,
  startEssentialsMigration,
  useEssentialsMigration,
  type EssentialsInstallDeps,
} from "./essentials-migration";

const row = (id: string): OfficialExtension => {
  const r = officialExtension(id);
  if (!r) throw new Error(`no official row ${id}`);
  return r;
};

const HSL = row("safelight.hsl");
const BASIC = row("safelight.basic");
const CURVE = row("safelight.tone-curve");
const DEVTOOLS = row("safelight.devtools");
const LIBRARY = row("safelight.library");

const json = (key: string): unknown => JSON.parse(localStorage.getItem(key) ?? "null");
const put = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));
const snapshot = (): Record<string, string | null> =>
  Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "").map((k) => [
      k,
      localStorage.getItem(k),
    ]),
  );
const done = (): unknown => (json(MIGRATION_KEY) as { done: string[] } | null)?.done;

const manifestFor = (r: OfficialExtension): ExtensionManifest => ({
  id: r.id,
  name: r.id,
  version: "1.0.0",
  main: "index.js",
  repository: r.repo,
});

const byRepo = (repo: string): OfficialExtension => {
  const r = [HSL, CURVE, DEVTOOLS, LIBRARY].find((x) => x.repo === repo);
  if (!r) throw new Error(`unknown repo ${repo}`);
  return r;
};

const rowByRepo = (repo: string): OfficialExtension => {
  const r = OFFICIAL_EXTENSIONS.find((x) => x.repo === repo);
  if (!r) throw new Error(`unknown repo ${repo}`);
  return r;
};

let install: Mock<(repo: string, enable: boolean) => Promise<ExtensionManifest>>;
let installed: string[];

const deps = (over: Partial<EssentialsInstallDeps> = {}): EssentialsInstallDeps => ({
  storage: localStorage,
  installedIds: async () => installed,
  install,
  bannedReason: () => null,
  rememberSource: () => {},
  timeoutMs: 1_000,
  ...over,
});

/** A profile that has run a build with the built-ins. */
const existing = () => put("sl_ext_default_seeded", ["core.devtools"]);

beforeEach(() => {
  localStorage.clear();
  installed = [];
  install = vi.fn(async (repo: string) => manifestFor(byRepo(repo)));
  useEssentialsMigration.setState({ status: "idle", missing: [] });
});

/** The built-ins core no longer ships, by their new ids. */
const EXTRACTED = [
  "safelight.library",
  "safelight.develop",
  "safelight.edit",
  "safelight.histogram",
  "safelight.transform",
  "safelight.crop",
  "safelight.white-balance",
  "safelight.basic",
  "safelight.tone-curve",
  "safelight.color-grading",
  "safelight.detail",
  "safelight.effects",
  "safelight.hsl",
  "safelight.masks",
  "safelight.heal",
  "safelight.presets",
  "safelight.folders",
  "safelight.filters",
  "safelight.keywords",
  "safelight.info",
  "safelight.export",
  "safelight.accessibility",
  "safelight.devtools",
];

const ids = (rows: readonly OfficialExtension[]): string[] => rows.map((r) => r.id);

describe("extractedEssentials", () => {
  it("lists the modules, panels and extras that left core", () => {
    expect(ids(extractedEssentials())).toEqual(EXTRACTED);
  });

  it("lists rows whose built-in is gone, and the modules", () => {
    const got = extractedEssentials([HSL, CURVE, LIBRARY], (id) => id !== "core.hsl");
    expect(got.map((r) => r.id)).toEqual(["safelight.hsl", "safelight.library"]);
  });
});

describe("classifyProfile", () => {
  it("calls an empty profile fresh", () => {
    put("sl_ext_settings_acme.widget", { a: 1 });
    expect(classifyProfile(localStorage)).toBe("fresh");
  });

  it.each([
    [MIGRATION_KEY, { done: [] }],
    ["sl_ext_default_seeded", ["core.devtools"]],
    ["sl_dock_layout_v4:develop", {}],
    ["sl_ext_settings_core.hsl", {}],
    ["sl_setup_v1", { outcome: "skipped", at: 1, appVersion: "3.0.0" }],
  ])("calls a profile with %s existing", (key, value) => {
    put(key, value);
    expect(classifyProfile(localStorage)).toBe("existing");
  });
});

describe("prepareEssentialsMigration", () => {
  it("records a fresh profile as done with everything extracted, renaming nothing", () => {
    expect(prepareEssentialsMigration(localStorage, [HSL, LIBRARY])).toEqual([]);
    expect(done()).toEqual(["safelight.hsl", "safelight.library"]);
  });

  it("renames the disabled entry, settings, layout ticks and kinds", () => {
    existing();
    put("sl_ext_disabled", ["core.hsl", "acme.widget"]);
    put("sl_ext_settings_core.hsl", { weights: 2 });
    put("sl_ext_kinds", { "core.hsl": "pixels", "acme.widget": "interface" });
    const layout: UserLayout = {
      id: "u1",
      name: "Layout 1",
      modules: {},
      extensions: { "core.hsl": false, "acme.widget": true },
    };
    put("sl_user_layouts", { u1: layout });

    expect(prepareEssentialsMigration(localStorage, [HSL])).toEqual([HSL]);

    expect(json("sl_ext_disabled")).toEqual(["safelight.hsl", "acme.widget"]);
    expect(json("sl_ext_settings_safelight.hsl")).toEqual({ weights: 2 });
    expect(localStorage.getItem("sl_ext_settings_core.hsl")).toBeNull();
    expect(json("sl_ext_kinds")).toEqual({ "safelight.hsl": "pixels", "acme.widget": "interface" });
    expect(json("sl_user_layouts")).toEqual({
      u1: { ...layout, extensions: { "acme.widget": true, "safelight.hsl": false } },
    });
    expect(done()).toEqual([]);
  });

  it("never overwrites settings already stored under the new id", () => {
    existing();
    put("sl_ext_settings_core.tone-curve", { old: true });
    put("sl_ext_settings_safelight.tone-curve", { new: true });
    prepareEssentialsMigration(localStorage, [CURVE]);
    expect(json("sl_ext_settings_safelight.tone-curve")).toEqual({ new: true });
  });

  it("carries a preference core kept for the panel into the extension's settings", () => {
    existing();
    put("sl_settings_v1", { basicDetailSliders: true, uiScale: 1.25 });
    prepareEssentialsMigration(localStorage, [BASIC]);
    expect(json("sl_ext_settings_safelight.basic")).toEqual({ detailSliders: true });
  });

  it("keeps a moved preference the extension already stores, and the rest of its settings", () => {
    existing();
    put("sl_settings_v1", { basicDetailSliders: true });
    put("sl_ext_settings_safelight.basic", { detailSliders: false, other: 3 });
    prepareEssentialsMigration(localStorage, [BASIC]);
    expect(json("sl_ext_settings_safelight.basic")).toEqual({ detailSliders: false, other: 3 });
  });

  it("writes nothing for a preference core never stored", () => {
    existing();
    put("sl_settings_v1", { uiScale: 1 });
    prepareEssentialsMigration(localStorage, [BASIC]);
    expect(localStorage.getItem("sl_ext_settings_safelight.basic")).toBeNull();
  });

  it("skips Developer Tools when the old id was disabled, and records it done", () => {
    existing();
    put("sl_ext_disabled", ["core.devtools"]);
    expect(prepareEssentialsMigration(localStorage, [DEVTOOLS, HSL])).toEqual([HSL]);
    expect(done()).toEqual(["safelight.devtools"]);
  });

  it("queues Developer Tools when the old id was enabled", () => {
    existing();
    expect(prepareEssentialsMigration(localStorage, [DEVTOOLS])).toEqual([DEVTOOLS]);
  });

  it("leaves rows already done alone", () => {
    put(MIGRATION_KEY, { done: ["safelight.hsl"] });
    put("sl_ext_disabled", ["core.hsl"]);
    expect(prepareEssentialsMigration(localStorage, [HSL])).toEqual([]);
    expect(json("sl_ext_disabled")).toEqual(["core.hsl"]);
  });
});

describe("installEssentials", () => {
  it("installs a disabled essential without enabling it, the rest enabled", async () => {
    existing();
    put("sl_ext_disabled", ["core.hsl"]);
    const pending = prepareEssentialsMigration(localStorage, [HSL, CURVE]);
    await installEssentials(pending, deps());
    expect(install.mock.calls).toEqual([
      [HSL.repo, false],
      [CURVE.repo, true],
    ]);
    expect(done()).toEqual(["safelight.hsl", "safelight.tone-curve"]);
    expect(useEssentialsMigration.getState()).toMatchObject({ status: "idle", missing: [] });
  });

  it("counts an id that is already installed as done", async () => {
    existing();
    installed = ["safelight.hsl"];
    await installEssentials(prepareEssentialsMigration(localStorage, [HSL]), deps());
    expect(install).not.toHaveBeenCalled();
    expect(done()).toEqual(["safelight.hsl"]);
  });

  it("keeps the successes done and reports the failures", async () => {
    existing();
    install.mockImplementation(async (repo: string) => {
      if (repo === HSL.repo) throw new Error("offline");
      return manifestFor(byRepo(repo));
    });
    await installEssentials(prepareEssentialsMigration(localStorage, [HSL, CURVE]), deps());
    expect(done()).toEqual(["safelight.tone-curve"]);
    expect(useEssentialsMigration.getState()).toMatchObject({
      status: "failed",
      missing: ["safelight.hsl"],
    });
  });

  it("counts an essential uninstalled while it downloaded as done", async () => {
    existing();
    install.mockImplementation(async (repo: string) => {
      throw new InstallSupersededError(manifestFor(byRepo(repo)), "uninstalled");
    });
    await installEssentials(prepareEssentialsMigration(localStorage, [HSL]), deps());
    expect(done()).toEqual(["safelight.hsl"]);
    expect(useEssentialsMigration.getState()).toMatchObject({ status: "idle", missing: [] });
  });

  it("never installs a banned repo", async () => {
    existing();
    await installEssentials(
      prepareEssentialsMigration(localStorage, [HSL]),
      deps({ bannedReason: () => "flagged as unsafe" }),
    );
    expect(install).not.toHaveBeenCalled();
    expect(useEssentialsMigration.getState().missing).toEqual(["safelight.hsl"]);
  });

  it("gives up on an install that doesn't answer in time", async () => {
    existing();
    install.mockImplementation(() => new Promise<ExtensionManifest>(() => {}));
    await installEssentials(
      prepareEssentialsMigration(localStorage, [HSL]),
      deps({ timeoutMs: 5 }),
    );
    expect(useEssentialsMigration.getState()).toMatchObject({
      status: "failed",
      missing: ["safelight.hsl"],
    });
  });

  it("retries only the missing ones", async () => {
    existing();
    install.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    await installEssentials(prepareEssentialsMigration(localStorage, [HSL, CURVE]), deps());
    install.mockClear();
    await retryEssentials(deps());
    expect(install.mock.calls).toEqual([[HSL.repo, true]]);
    expect(done()).toEqual(["safelight.tone-curve", "safelight.hsl"]);
    expect(useEssentialsMigration.getState()).toMatchObject({ status: "idle", missing: [] });
  });

  it("does nothing on the boot after it finished", async () => {
    existing();
    put("sl_ext_disabled", ["core.hsl"]);
    await installEssentials(prepareEssentialsMigration(localStorage, [HSL, CURVE]), deps());
    const before = snapshot();
    install.mockClear();
    const pending = prepareEssentialsMigration(localStorage, [HSL, CURVE]);
    await installEssentials(pending, deps());
    expect(pending).toEqual([]);
    expect(install).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });
});

describe("ensureCoreModules", () => {
  const record = (outcome: string) =>
    put("sl_setup_v1", { outcome, at: 1, appVersion: "3.0.0" });
  let offline: boolean;
  const installedRepos = () => install.mock.calls.map(([repo]) => repo);

  beforeEach(() => {
    offline = false;
    install = vi.fn(async (repo: string) => {
      if (offline) throw new Error("getaddrinfo ENOTFOUND raw.githubusercontent.com");
      return manifestFor(rowByRepo(repo));
    });
  });

  it("installs Library from the official list once setup is closed and it never was installed", async () => {
    record("skipped");
    installed = ["safelight.develop"];
    await ensureCoreModules([], deps());
    expect(installedRepos()).toEqual([LIBRARY.repo]);
  });

  it("installs only the modules after a first run that was offline", async () => {
    record("finished");
    installed = [];
    await ensureCoreModules([], deps());
    expect(installedRepos()).toEqual([LIBRARY.repo, row("safelight.develop").repo]);
  });

  it("leaves Develop and the rest uninstalled when the person removed them after setup", async () => {
    record("finished");
    installed = ["safelight.library", "safelight.develop", "safelight.heal", "safelight.hsl"];
    await ensureCoreModules([], deps());
    installed = ["safelight.library", "safelight.hsl"];
    await ensureCoreModules([], deps());
    expect(install).not.toHaveBeenCalled();
  });

  it("leaves a module the person removed after it was installed here uninstalled", async () => {
    record("finished");
    installed = ["safelight.library"];
    await ensureCoreModules([], deps());
    installed = [];
    install.mockClear();
    await ensureCoreModules([], deps());
    expect(install).not.toHaveBeenCalled();
  });

  it("queues them when Develop is the one missing", async () => {
    record("finished");
    installed = ["safelight.library"];
    await ensureCoreModules([], deps());
    expect(installedRepos()).toContain(rowByRepo("anthonyreimche/develop").repo);
  });

  it("installs nothing while Library and Develop are both installed", async () => {
    record("finished");
    installed = ["safelight.library", "safelight.develop"];
    await ensureCoreModules([], deps());
    expect(install).not.toHaveBeenCalled();
  });

  it.each([["in-progress"], [null]])("leaves a profile whose setup is %s to the setup", async (outcome) => {
    if (outcome) record(outcome);
    await ensureCoreModules([], deps());
    expect(install).not.toHaveBeenCalled();
  });

  it("installs nothing when the installed extensions can't be read", async () => {
    record("finished");
    await ensureCoreModules(
      [],
      deps({
        installedIds: async () => {
          throw new Error("no native bridge");
        },
      }),
    );
    expect(install).not.toHaveBeenCalled();
  });

  it("still installs the migration's rows when the modules are there", async () => {
    existing();
    record("not-needed");
    installed = ["safelight.library", "safelight.develop"];
    await ensureCoreModules([HSL], deps());
    expect(install.mock.calls).toEqual([[HSL.repo, true]]);
  });

  it("marks the run failed and shows the top bar notice when nothing can be downloaded", async () => {
    record("finished");
    offline = true;
    render(<EssentialsNotice />);
    expect(screen.queryByRole("status")).toBeNull();
    await act(() => ensureCoreModules([], deps()));
    const state = useEssentialsMigration.getState();
    expect(state.status).toBe("failed");
    expect(state.missing).toContain("safelight.library");
    expect(screen.getByRole("status").textContent).toContain("Some essentials couldn't be installed.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("tries the missing ones again, once, when the window comes back online", async () => {
    record("finished");
    offline = true;
    await ensureCoreModules([], deps());
    expect(useEssentialsMigration.getState().status).toBe("failed");
    offline = false;
    install.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.waitFor(() => expect(useEssentialsMigration.getState().status).toBe("idle"));
    });
    expect(installedRepos()).toContain(LIBRARY.repo);
    const retried = install.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(install.mock.calls.length).toBe(retried);
  });

  it("does not retry again after a failed online retry", async () => {
    record("finished");
    offline = true;
    await ensureCoreModules([], deps());
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.waitFor(() => expect(install.mock.calls.length).toBeGreaterThan(0));
    });
    await vi.waitFor(() => expect(useEssentialsMigration.getState().status).toBe("failed"));
    const attempts = install.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(install.mock.calls.length).toBe(attempts);
  });
});

describe("installMissingEssentials", () => {
  it("installs the essentials that aren't installed, whatever setup recorded", async () => {
    installed = ["safelight.library", "safelight.develop", "safelight.hsl"];
    install = vi.fn(async (repo: string) => manifestFor(rowByRepo(repo)));
    await installMissingEssentials(deps());
    const repos = install.mock.calls.map(([repo]) => repo);
    expect(repos).not.toContain(LIBRARY.repo);
    expect(repos).not.toContain(HSL.repo);
    expect(repos).toContain(BASIC.repo);
    expect(repos).not.toContain(DEVTOOLS.repo);
  });
});

describe("startEssentialsMigration", () => {
  it("records a fresh profile as done with all of them, queueing nothing", () => {
    expect(startEssentialsMigration()).toEqual([]);
    expect(done()).toEqual(EXTRACTED);
  });

  it("queues all of them for an existing profile that had Developer Tools on", () => {
    put("sl_ext_default_seeded", ["core.devtools"]);
    put("sl_ext_disabled", []);
    expect(ids(startEssentialsMigration())).toEqual(EXTRACTED);
    expect(done()).toEqual([]);
  });

  it("queues all but Developer Tools for an existing profile that had it off", () => {
    put("sl_ext_default_seeded", ["core.devtools"]);
    put("sl_ext_disabled", ["core.devtools", "core.info"]);
    expect(ids(startEssentialsMigration())).toEqual(EXTRACTED.filter((id) => id !== "safelight.devtools"));
    expect(done()).toEqual(["safelight.devtools"]);
    expect(json("sl_ext_disabled")).toEqual(["safelight.devtools", "safelight.info"]);
  });

  it("brings the disabled list and saved layouts in memory up to the renames", () => {
    existing();
    put("sl_ext_disabled", ["core.hsl"]);
    put("sl_user_layouts", {
      u1: { id: "u1", name: "Layout 1", modules: {}, extensions: { "core.hsl": true } },
    });
    useDisabledExtensions.setState({ ids: ["core.hsl"] });
    expect(startEssentialsMigration([HSL])).toEqual([HSL]);
    expect(useDisabledExtensions.getState().ids).toEqual(["safelight.hsl"]);
    expect(useUserLayouts.getState().layouts.u1.extensions).toEqual({ "safelight.hsl": true });
  });
});
