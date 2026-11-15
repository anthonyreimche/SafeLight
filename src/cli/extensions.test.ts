// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionService } from "./extensions";
import { CliError, type CliEnv, type ExtensionService, type InstallRisk } from "./types";

const REGISTRY = "https://raw.githubusercontent.com/anthonyreimche/safelight-registry/main/";

function tarEntry(name: string, data: string): Buffer {
  const body = Buffer.from(data);
  const head = Buffer.alloc(512);
  head.write(name, 0, 100, "utf8");
  head.write("0000644\0", 100);
  head.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  head.write("0", 156);
  head.write("ustar\u000000", 257);
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([head, padded]);
}

function tarball(root: string, files: Record<string, string>): Buffer {
  const parts = Object.entries(files).map(([name, data]) => tarEntry(`${root}/${name}`, data));
  return zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

interface Row { fullName: string; name?: string; version?: string }

function registryJson(rows: Row[]) {
  return {
    extensions: rows.map((r) => ({
      fullName: r.fullName,
      name: r.name,
      latest: { from: "branch", version: r.version ?? "1.0.0" },
    })),
  };
}

function manifestFor(id: string, extra: object = {}) {
  return JSON.stringify({
    id, name: "Acme Tool", version: "1.0.0", main: "index.js", repository: "someone/acme-tool", ...extra,
  });
}

interface World {
  rows: Row[];
  verified: string[];
  banned: string[];
  kits: unknown;
  files: Record<string, string>;
  down: boolean;
}

let userData: string;
let world: World;
let fetched: string[];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
  const url = String(input);
  fetched.push(url);
  if (world.down) throw new TypeError("fetch failed");
  if (url === `${REGISTRY}verified.json`) return json({ verified: world.verified });
  if (url === `${REGISTRY}banned.json`)
    return json({ repos: world.banned, reason: Object.fromEntries(world.banned.map((r) => [r, "stole data"])) });
  if (url === `${REGISTRY}registry.json`) return json(registryJson(world.rows));
  if (url === `${REGISTRY}kits.json`) return json(world.kits);
  if (url.startsWith("https://codeload.github.com/"))
    return new Response(new Uint8Array(tarball("acme-HEAD", world.files)), { status: 200 });
  return new Response("not found", { status: 404 });
};

function env(): CliEnv {
  return {
    cwd: userData, userData, appRoot: userData, appVersion: "3.3.0", platform: process.platform,
    isTTY: { stdin: false, stdout: false, stderr: false }, env: {},
  };
}

const service = (): ExtensionService => createExtensionService(env(), fakeFetch as typeof fetch);

const pluginsDir = () => path.join(userData, "plugins");

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "slu-ext-"));
  fetched = [];
  world = {
    rows: [{ fullName: "someone/acme-tool", name: "Acme Tool" }],
    verified: [],
    banned: [],
    kits: { schema: 1, kits: [] },
    files: { "safelight.json": manifestFor("acme.tool"), "index.js": "export {};" },
    down: false,
  };
});

afterEach(() => fs.rmSync(userData, { recursive: true, force: true }));

const allow = async () => true;
const refuse = async () => false;

describe("search", () => {
  it("rates each hit by the trust lists and gives the name to install", async () => {
    world.rows = [
      { fullName: "someone/acme-tool", name: "Acme Tool" },
      { fullName: "good/acme-checked", name: "Acme Checked" },
      { fullName: "evil/acme-bad", name: "Acme Bad" },
    ];
    world.verified = ["good/acme-checked"];
    world.banned = ["evil/acme-bad"];
    const hits = await service().search(["acme"]);
    const by = Object.fromEntries(hits.map((h) => [h.repo, h]));
    expect(by["someone/acme-tool"]).toMatchObject({ installName: "acme-tool", name: "Acme Tool", version: "1.0.0", trust: "unverified" });
    expect(by["good/acme-checked"].trust).toBe("verified");
    expect(by["evil/acme-bad"].trust).toBe("banned");
  });

  it("names the proxy when GitHub can't be reached", async () => {
    world.down = true;
    const failure = await service().search(["acme"]).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe(5);
    expect((failure as CliError).hint).toMatch(/HTTPS_PROXY/);
  });
});

describe("resolve", () => {
  it("accepts an official repository's old name, the id and the id without its prefix", async () => {
    const svc = service();
    for (const name of ["anthonyreimche/basic-adjustments", "safelight.basic", "basic", "BASIC"])
      expect(await svc.resolve(name)).toMatchObject({ repo: "anthonyreimche/basic", id: "safelight.basic" });
  });

  it("accepts a repository name and a display name in slug form", async () => {
    const svc = service();
    expect(await svc.resolve("acme-tool")).toEqual({ repo: "someone/acme-tool" });
    world.rows = [{ fullName: "someone/thing", name: "Contrast & Texture" }];
    expect(await service().resolve("contrast-and-texture")).toEqual({ repo: "someone/thing" });
  });

  it("stops with exit 5 and the candidates when a name fits two repositories", async () => {
    world.rows = [{ fullName: "a/thing" }, { fullName: "b/thing" }];
    const failure = await service().resolve("thing").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe(5);
    expect((failure as CliError).message).toContain("a/thing");
    expect((failure as CliError).message).toContain("b/thing");
  });

  it("finds a kit, and says when nothing matches", async () => {
    world.kits = {
      schema: 1,
      kits: [{ id: "starter", name: "Starter", extensions: [{ repo: "a/one", name: "One" }, { repo: "b/two", name: "Two" }] }],
    };
    expect(await service().resolve("starter")).toEqual({ kit: "starter", repos: ["a/one", "b/two"] });
    const failure = await service().resolve("nothing-here").catch((e: unknown) => e);
    expect((failure as CliError).code).toBe(5);
  });
});

describe("install", () => {
  it("settles the install: the files stay and no update is left waiting", async () => {
    let risk: InstallRisk | null = null;
    const ext = await service().install("someone/acme-tool", {
      confirm: async (r) => {
        risk = r;
        return true;
      },
    });
    expect(ext).toMatchObject({ id: "acme.tool", version: "1.0.0", enabled: null, trust: "unverified" });
    expect(risk).toMatchObject({ name: "Acme Tool", trust: "unverified" });
    expect(fs.existsSync(path.join(pluginsDir(), "acme.tool", "safelight.json"))).toBe(true);
    expect(fs.existsSync(path.join(userData, "plugins-update", "acme.tool", "prev"))).toBe(false);
    expect(fs.existsSync(path.join(userData, "plugins.lock"))).toBe(false);
  });

  it("lists what the extension may reach in the question", async () => {
    world.files["safelight.json"] = manifestFor("acme.tool", { permissions: { network: ["https://api.acme.test"], userOrigins: true } });
    let risk: InstallRisk | null = null;
    await service().install("someone/acme-tool", { confirm: async (r) => ((risk = r), true) });
    expect((risk as InstallRisk | null)?.permissions).toEqual(["reach https://api.acme.test", "reach web addresses you type in"]);
  });

  it("removes an unverified install the person declines", async () => {
    const failure = await service().install("someone/acme-tool", { confirm: refuse }).catch((e: unknown) => e);
    expect((failure as CliError).code).toBe(5);
    expect(fs.readdirSync(pluginsDir())).toEqual([]);
  });

  it("rolls the files back when stopped while the question is open", async () => {
    const svc = service();
    let asked!: () => void;
    const questionOpen = new Promise<void>((resolve) => { asked = resolve; });
    void svc.install("someone/acme-tool", { confirm: () => { asked(); return new Promise<boolean>(() => {}); } }).catch(() => {});
    await questionOpen;
    expect(fs.existsSync(path.join(pluginsDir(), "acme.tool"))).toBe(true);
    await svc.abandon();
    expect(fs.readdirSync(pluginsDir())).toEqual([]);
    expect(fs.existsSync(path.join(userData, "plugins.lock"))).toBe(false);
  });

  it("doesn't ask about a verified extension", async () => {
    world.verified = ["someone/acme-tool"];
    const confirm = vi.fn(allow);
    const ext = await service().install("someone/acme-tool", { confirm });
    expect(confirm).not.toHaveBeenCalled();
    expect(ext.trust).toBe("verified");
  });

  it("refuses a banned extension before downloading anything", async () => {
    world.banned = ["someone/acme-tool"];
    const failure = await service().install("someone/acme-tool", { confirm: allow }).catch((e: unknown) => e);
    expect((failure as CliError).code).toBe(5);
    expect((failure as CliError).message).toContain("stole data");
    expect(fetched.some((u) => u.startsWith("https://codeload.github.com/"))).toBe(false);
    expect(fs.existsSync(pluginsDir())).toBe(false);
  });
});

describe("trust comes from where the files were downloaded", () => {
  const evilFiles = (declared: string) => ({
    "safelight.json": manifestFor("evil.x", { repository: declared }),
    "index.js": "export {};",
  });

  it("asks about an unverified repository that declares an official one", async () => {
    world.files = evilFiles("anthonyreimche/basic-adjustments");
    const confirm = vi.fn(allow);
    const ext = await service().install("evil/x", { confirm });
    expect(confirm).toHaveBeenCalledOnce();
    expect(ext).toMatchObject({ trust: "unverified", repo: "evil/x" });
    expect((await service().installed())[0]).toMatchObject({ trust: "unverified", repo: "evil/x" });
  });

  it("rolls back an install whose manifest names a banned repository", async () => {
    world.banned = ["bad/actor"];
    world.files = evilFiles("bad/actor");
    const failure = await service().install("evil/x", { confirm: allow }).catch((e: unknown) => e);
    expect((failure as CliError).code).toBe(5);
    expect(fs.readdirSync(pluginsDir())).toEqual([]);
  });

  it("updates from the repository it was installed from, not the manifest's word", async () => {
    world.files = evilFiles("someone/acme-tool");
    world.rows = [{ fullName: "evil/x", version: "1.0.0" }, { fullName: "someone/acme-tool", version: "9.0.0" }];
    const svc = service();
    await svc.install("evil/x", { confirm: allow });
    expect(await service().updatesAvailable()).toEqual([]);
  });

  it("has no update source for an extension it didn't install, whatever the manifest declares", async () => {
    const dir = path.join(pluginsDir(), "evil.x");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "safelight.json"), manifestFor("evil.x", { repository: "anthonyreimche/basic-adjustments" }));
    expect((await service().installed())[0]).toMatchObject({ trust: "unverified", repo: null });
  });

  it("shows an installed extension as banned when its manifest names a banned repository", async () => {
    world.banned = ["bad/actor"];
    const dir = path.join(pluginsDir(), "evil.x");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "safelight.json"), manifestFor("evil.x", { repository: "bad/actor" }));
    expect((await service().installed())[0].trust).toBe("banned");
  });
});

describe("sources the app recorded", () => {
  function installedByApp(id: string) {
    const dir = path.join(pluginsDir(), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "safelight.json"), manifestFor(id, { repository: undefined }));
  }

  function appSources(sources: Record<string, string>) {
    fs.writeFileSync(
      path.join(userData, "shared-settings.json"),
      JSON.stringify({
        version: 1, appVersion: "3.3.0", writtenAt: 1, guiPid: null, recentProjects: [],
        storage: { sl_ext_sources: JSON.stringify(sources) },
      }),
    );
  }

  it("rates and updates an extension the app installed from where the app downloaded it", async () => {
    installedByApp("acme.tool");
    appSources({ "acme.tool": "someone/acme-tool" });
    world.rows = [{ fullName: "someone/acme-tool", version: "1.2.0" }];
    expect((await service().installed())[0]).toMatchObject({ repo: "someone/acme-tool", trust: "unverified" });
    expect(await service().updatesAvailable()).toEqual([{ id: "acme.tool", from: "1.0.0", to: "1.2.0" }]);
  });

  it("knows no source for an id the app's record and slu's name differently", async () => {
    installedByApp("acme.tool");
    appSources({ "acme.tool": "other/fork" });
    fs.writeFileSync(path.join(userData, "slu-sources.json"), JSON.stringify({ "acme.tool": "someone/acme-tool" }));
    expect((await service().installed())[0].repo).toBeNull();
  });

  it("keeps the app's record out of slu's own file", async () => {
    appSources({ "other.ext": "someone/other" });
    await service().install("someone/acme-tool", { confirm: allow });
    expect(JSON.parse(fs.readFileSync(path.join(userData, "slu-sources.json"), "utf8"))).toEqual({ "acme.tool": "someone/acme-tool" });
  });
});

describe("installed, switches and removal", () => {
  async function withInstalled(): Promise<ExtensionService> {
    const svc = service();
    await svc.install("someone/acme-tool", { confirm: allow });
    return svc;
  }

  const stateFile = () => path.join(userData, "extension-state.json");
  const appWroteState = () => fs.writeFileSync(stateFile(), JSON.stringify({ version: 1, disabled: [] }));

  it("refuses to switch an extension before the app has said which are on, and writes nothing", async () => {
    const svc = await withInstalled();
    const failure = await svc.setEnabled("acme.tool", false).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe(5);
    expect((failure as CliError).message).toBe("Open Safelight once so slu can see which extensions are on.");
    expect(fs.existsSync(stateFile())).toBe(false);
  });

  it("reports on and off as unknown before the app has said which are on", async () => {
    const svc = await withInstalled();
    expect((await svc.installed())[0].enabled).toBeNull();
    appWroteState();
    expect((await svc.installed())[0].enabled).toBe(true);
  });

  it("leaves the list alone when the switch is already that way", async () => {
    const svc = await withInstalled();
    appWroteState();
    const before = fs.statSync(stateFile()).mtimeMs;
    fs.utimesSync(stateFile(), new Date(before - 60_000), new Date(before - 60_000));
    await svc.setEnabled("acme.tool", true);
    expect(fs.statSync(stateFile()).mtimeMs).toBeLessThan(before - 30_000);
  });

  it("writes the disabled list that the app reads, and reads it back", async () => {
    const svc = await withInstalled();
    appWroteState();
    await svc.setEnabled("acme.tool", false);
    expect(JSON.parse(fs.readFileSync(path.join(userData, "extension-state.json"), "utf8"))).toEqual({ version: 1, disabled: ["acme.tool"] });
    expect((await svc.installed())[0]).toMatchObject({ id: "acme.tool", enabled: false, repo: "someone/acme-tool" });
    await svc.setEnabled("acme.tool", true);
    expect((await svc.installed())[0].enabled).toBe(true);
  });

  it("uninstalls the files and forgets the switch", async () => {
    const svc = await withInstalled();
    appWroteState();
    await svc.setEnabled("acme.tool", false);
    await svc.uninstall("acme.tool");
    expect(await svc.installed()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(userData, "extension-state.json"), "utf8")).disabled).toEqual([]);
  });

  it("offers a newer release and ignores a current one", async () => {
    const svc = await withInstalled();
    expect(await svc.updatesAvailable()).toEqual([]);
    world.rows = [{ fullName: "someone/acme-tool", version: "1.2.0" }];
    const fresh = service();
    expect(await fresh.updatesAvailable()).toEqual([{ id: "acme.tool", from: "1.0.0", to: "1.2.0" }]);
    expect(await fresh.updatesAvailable(["other.id"])).toEqual([]);
  });
});

describe("guiRunning", () => {
  it("is true only while the app's heartbeat is fresh", async () => {
    const svc = service();
    expect(await svc.guiRunning()).toBe(false);
    const file = path.join(userData, "gui-heartbeat.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, writtenAt: Date.now() - 30_000 }));
    expect(await svc.guiRunning()).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ version: 1, writtenAt: Date.now() - 600_000 }));
    expect(await svc.guiRunning()).toBe(false);
  });
});
