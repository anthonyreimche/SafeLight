// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The preload hands the fs:* and updates:install channels, and the extension
// install/uninstall/settle channels, only to core, once, at boot. main.cjs must
// register each through handlePrivileged, which refuses
// every document but the app's own top frame; a bare ipcMain registration would
// answer an extension's own page too. Every channel comes from the table in
// ipc/index.cjs, which runs here; main.cjs itself can't run under vitest, so the
// rest of its wiring is read as text.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ipcChannels, registerIpc } from "./ipc/index.cjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(HERE, file), "utf8");
const MAIN = read("main.cjs");
const PRELOAD = read("preload.cjs");
const STORE = readdirSync(join(HERE, "extension-store"))
  .filter((file) => file.endsWith(".cjs"))
  .map((file) => read(`extension-store/${file}`))
  .join("\n");
const ELECTRON_SOURCES = [
  ...readdirSync(HERE).filter((file) => file.endsWith(".cjs")),
  ...["ipc", "extension-store"].flatMap((dir) =>
    readdirSync(join(HERE, dir))
      .filter((file) => file.endsWith(".cjs"))
      .map((file) => `${dir}/${file}`),
  ),
].map(read);

const PRIVILEGED =
  /^(?:fs:.+|updates:.+|os-open:take|diagnostics:capturePage|gpu:.+|plugins:(?:install|uninstall|settle-update))$/;

type Deps = Parameters<typeof ipcChannels>[0];
type Channel = ReturnType<typeof ipcChannels>[number];

/** The IPC table built on `deps`; building it calls none of them. */
function table(deps: Partial<Deps> = {}): Channel[] {
  return ipcChannels(deps as Deps);
}

function entry(channel: string, deps: Partial<Deps> = {}): Channel {
  const hit = table(deps).find((c) => c.channel === channel);
  expect(hit, `${channel} is in the IPC table`).toBeDefined();
  return hit!;
}

const NO_EVENT = {} as Parameters<Channel["handler"]>[0];

const privilegedChannels = () => table().filter((c) => c.privileged).map((c) => c.channel);
const publicChannels = () => table().filter((c) => !c.privileged).map((c) => c.channel);

/** Channels registered as `<callee>("channel"`, each as "line:channel". */
function registrations(source: string, callee: string): string[] {
  const call = new RegExp(`(?<![\\w$.])${callee}\\s*\\(\\s*(["'\`])([^"'\`]+)\\1`, "g");
  return [...source.matchAll(call)].map((m) => {
    const line = source.slice(0, m.index).split("\n").length;
    return `${line}:${m[2]}`;
  });
}

const channelOf = (entry: string) => entry.slice(entry.indexOf(":") + 1);

/** Privileged channels registered on ipcMain directly. */
function unguarded(source: string): string[] {
  return registrations(source, "ipcMain\\s*\\.\\s*(?:handle|handleOnce|on|once)").filter(
    (entry) => PRIVILEGED.test(channelOf(entry)),
  );
}

describe("privileged channel wiring in main.cjs", () => {
  it("registers no privileged channel on ipcMain directly", () => {
    expect(publicChannels()).toContain("plugins:list");
    expect(table().filter((c) => c.privileged !== PRIVILEGED.test(c.channel))).toEqual([]);
    for (const source of ELECTRON_SOURCES) expect(unguarded(source)).toEqual([]);
  });

  it("lists each channel once", () => {
    const channels = table().map((c) => c.channel);
    expect(channels.length).toBeGreaterThan(40);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("registers the whole table through one loop", () => {
    expect(MAIN).toMatch(/registerIpc\(channels, \{ ipcMain, handlePrivileged \}\)/);
    expect(MAIN).not.toMatch(/ipcMain\s*\.\s*handle\(\s*["'`]/);
    const handle = vi.fn();
    const handlePrivileged = vi.fn();
    const open = () => "open";
    const guarded = () => "guarded";
    registerIpc(
      [
        { channel: "a:open", privileged: false, handler: open },
        { channel: "fs:guarded", privileged: true, handler: guarded },
      ],
      { ipcMain: { handle }, handlePrivileged },
    );
    expect(handle.mock.calls).toEqual([["a:open", open]]);
    expect(handlePrivileged.mock.calls).toEqual([["fs:guarded", guarded]]);
  });

  it("answers every channel the preload invokes", () => {
    const invoked = registrations(PRELOAD, "ipcRenderer\\s*\\.\\s*invoke").map(channelOf);
    const channels = table().map((c) => c.channel);
    expect(invoked.filter((channel) => !channels.includes(channel))).toEqual([]);
  });

  it("guards every privileged channel the preload hands out", () => {
    const handedOut = registrations(PRELOAD, "ipcRenderer\\s*\\.\\s*invoke")
      .map(channelOf)
      .filter((channel) => PRIVILEGED.test(channel));
    const guarded = privilegedChannels();
    expect(handedOut).toContain("fs:write");
    expect(handedOut).toContain("updates:install");
    expect(handedOut).toContain("updates:support");
    expect(handedOut).toContain("diagnostics:capturePage");
    expect(handedOut).toContain("gpu:setSoftware");
    expect(handedOut).toContain("os-open:take");
    for (const channel of ["plugins:install", "plugins:uninstall", "plugins:settle-update"]) {
      expect(handedOut).toContain(channel);
      expect(guarded).toContain(channel);
    }
    expect(handedOut.filter((channel) => !guarded.includes(channel))).toEqual([]);
  });

  // Anything on the exposed object is reachable by every extension.
  it("leaves the extension install channels off the public bridge", () => {
    const publicSurface = PRELOAD.slice(PRELOAD.indexOf("contextBridge.exposeInMainWorld"));
    const exposed = registrations(publicSurface, "ipcRenderer\\s*\\.\\s*invoke").map(channelOf);
    expect(exposed).toContain("plugins:list");
    expect(exposed.filter((channel) => PRIVILEGED.test(channel))).toEqual([]);
  });

  it("routes handlePrivileged through the guard", () => {
    expect(MAIN).toMatch(
      /function handlePrivileged\(channel, handler\) \{\s*ipcMain\.handle\(channel, guardPrivileged\(channel, handler,/,
    );
  });

  // The guard judges the committed document; pushState fires
  // did-navigate-in-page, which must not feed it.
  it("records the committed URL on did-navigate for the guard", () => {
    expect(MAIN).toMatch(/\.on\("did-navigate", \(_event, url\) => \{\s*committedUrls\.set\(/);
    expect(MAIN).toMatch(/guardPrivileged\(channel, handler, \{ committedUrls \}\)/);
    expect(MAIN).not.toMatch(/\.on\(\s*["']did-navigate-in-page/);
  });

  it("flags a planted unguarded registration", () => {
    const planted = [
      'handlePrivileged("fs:read", read);',
      'ipcMain.handle("plugins:list", list);',
      'ipcMain.handle("fs:write", write);',
      "ipcMain.handle(\n  'updates:install',\n  install,\n);",
      'ipcMain . handleOnce( "fs:trash", trash);',
      'ipcMain.on("fs:remove", remove);',
    ].join("\n");
    expect(unguarded(planted)).toEqual([
      "3:fs:write",
      "4:updates:install",
      "8:fs:trash",
      "9:fs:remove",
    ]);
  });
});

describe("Report an issue channels", () => {
  const handled = publicChannels();
  const invoked = registrations(PRELOAD, "ipcRenderer\\s*\\.\\s*invoke").map(channelOf);

  it("serves the crash list and opens issue links", () => {
    for (const channel of ["diagnostics:crashes", "report:openIssue"]) {
      expect(handled).toContain(channel);
      expect(invoked).toContain(channel);
    }
  });

  // A crash that the recovery gate ignores is still worth reporting, so the
  // record comes before any filtering.
  it("records every crash before deciding on recovery", () => {
    expect(MAIN).toMatch(/app\.on\("child-process-gone", \(_e, details\) => \{\s*crashLog\.record\(details\.type, details\);/);
    expect(MAIN).toMatch(/contents\.on\("render-process-gone", \(_ev, details\) => \{\s*crashLog\.record\("renderer", details\);/);
  });
});

// A VirtualBox guest whose GL driver can't hold WebGL2 left Develop blank on
// every launch: the probe had cached the hardware backend that started.
describe("GPU backend fallback", () => {
  it("takes its backends and switches from gpu-backend.cjs", () => {
    expect(MAIN).toMatch(/const ANGLE_BACKENDS = gpuLadder\(process\.platform, isWayland\);/);
    expect(MAIN).toMatch(/for \(const \[name, value\] of angleSwitches\(backend\)\)/);
  });

  // Windows and macOS VMs lose WebGL too; the ladder was Linux-only.
  it("runs the ladder on every platform", () => {
    expect(MAIN).not.toMatch(/let fallBackToSoftware = /);
    expect(MAIN).toMatch(/const fallBackToSoftware = \(reason, why\) => \{/);
    expect(MAIN).not.toMatch(/appendSwitch\("use-angle", "d3d11"\)/);
  });

  // A blocklisted driver stays out of a launch the cache sends to software.
  it("ignores the GPU blocklist only through the ladder's switches", () => {
    expect(MAIN).not.toMatch(/appendSwitch\("ignore-gpu-blocklist"\)/);
  });

  it("keeps the cache under userData, never a relative path", () => {
    expect(MAIN).toMatch(/backendCacheFiles\(\s*userDataDir\(\),\s*process\.platform,\s*process\.env\s*\)/);
    expect(MAIN).not.toMatch(/process\.env\.HOME \|\| ""/);
  });

  it("probes only until the first window opens", () => {
    expect(MAIN).toMatch(/app\.on\("browser-window-created", \(\) => \{\s*windowOpened = true;/);
  });

  it("moves the next launch to software once WebGL2 is lost", () => {
    expect(MAIN).toMatch(
      /app\.on\("gpu-info-update", \(\) => \{\s*if \(!webgl2Lost\(app\.getGPUFeatureStatus\(\)\)\) return;\s*if \(!fallBackToSoftware\("webgl2-unavailable", /,
    );
  });

  // A VM retrying the graphics card usually loses WebGL2 without the GPU
  // process crashing, so only this notices; without acting now, Develop stays
  // blank for the whole session.
  it("acts on lost WebGL2 now: relaunches in software before a window, else offers a restart", () => {
    expect(MAIN).toMatch(
      /fallBackToSoftware\("webgl2-unavailable", [^)]*\)\) return;\s*if \(windowOpened\) offerRestart\("gpu"\);\s*else relaunchOn\(ANGLE_BACKENDS\.length - 1\);/,
    );
    expect(MAIN).toMatch(/clearCache\(\);\s*relaunchOn\(angleIdx \+ 1\);/);
  });

  // WebGL2 starts, but Safelight's own shader can't be built on it: no GPU
  // process crashes and Chromium keeps reporting WebGL2, so only the renderer knows.
  it("moves the next launch to software when the renderer says it can't start, through a guarded channel", () => {
    const rendererFailed = vi.fn(() => ({ software: false, nextSoftware: true, reason: "renderer-failed" }));
    const { privileged, handler } = entry("gpu:rendererFailed", { rendererFailed });
    expect(privileged).toBe(true);
    expect(handler(NO_EVENT, "stock program failed to link")).toEqual({
      software: false,
      nextSoftware: true,
      reason: "renderer-failed",
    });
    expect(rendererFailed.mock.calls).toEqual([["stock program failed to link"]]);
    expect(registrations(PRELOAD, "ipcRenderer\\s*\\.\\s*invoke").map(channelOf)).toContain("gpu:rendererFailed");
    expect(MAIN).toMatch(/ipcChannels\(\{[^}]*\brendererFailed,/);
  });

  // The renderer failing steps down the ladder and keeps the app version beside a
  // software fallback, so the launch-count retry can't walk back into the failure.
  it("steps a renderer failure down the ladder and starts with the app version", () => {
    expect(MAIN).toMatch(/reason === "renderer-failed" \? rendererFallbackFor\(ANGLE_BACKENDS, backend\)/);
    expect(MAIN).toMatch(/fallbackCache\(reason, Date\.now\(\), app\.getVersion\(\)\)/);
    expect(MAIN).toMatch(/startRung\(ANGLE_BACKENDS, startCache, relaunchIdx, startedAt, app\.getVersion\(\)\)/);
    expect(MAIN).toMatch(/retriesHardware\(startCache, startedAt, app\.getVersion\(\)\)/);
  });

  // Already in software, fallBackToSoftware changes nothing and no restart is offered.
  it("falls back and offers a restart only when that changes where the next launch goes", () => {
    expect(MAIN).toMatch(
      /const rendererFailed = \(detail\) => \{\s*if \(fallBackToSoftware\("renderer-failed", [^;]*\)\) offerRestart\("gpu"\);\s*return gpuBackendState\(\);\s*\};/,
    );
  });

  it("moves the next launch to software once GPU crash recovery gives up", () => {
    expect(MAIN).toMatch(
      /if \(recover === "ok"\) for \(const win of windows\) win\.webContents\.reload\(\);\s*else if \(recover === "spent"\) \{\s*fallBackToSoftware\(/,
    );
  });

  // A second instance hands off to the first and quits; it must not rewrite
  // the cache the running copy depends on.
  it("caches the working backend only in the instance that holds the lock", () => {
    const lock = MAIN.indexOf("if (!app.requestSingleInstanceLock()) {");
    const write = MAIN.search(/app\.whenReady\(\)\.then\(\(\) => \{\s*cacheWorkingBackend\(\);/);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(lock);
    expect(MAIN.match(/writeCache\(readyCache\(/g)).toHaveLength(1);
    expect(MAIN).toMatch(/const cacheWorkingBackend = \(\) => \{\s*if \(!fellBack\) writeCache\(readyCache\(/);
  });
});

// Once reloading stops helping, the user gets a way out instead of a black
// window and a line in a console they can't see.
describe("unrecoverable windows", () => {
  it("offers a restart once a recovery budget is spent", () => {
    expect(MAIN).toMatch(/else if \(recover === "spent"\) \{\s*fallBackToSoftware\("gpu-crashes", [^)]*\);\s*offerRestart\("gpu"\);/);
    expect(MAIN).toMatch(/if \(recover === "ok"\) contents\.reload\(\);\s*else if \(recover === "spent"\) offerRestart\("renderer"\);/);
  });

  it("retries a failed main-window load once, then offers a restart", () => {
    const source = functionSource("createWindow");
    expect(source).toMatch(/\.on\("did-fail-load", \(_e, errorCode, description, url, isMainFrame\) => \{/);
    expect(source).toMatch(/if \(!isMainFrameLoadFailure\(errorCode, isMainFrame\)\) return;/);
    expect(source).toMatch(/if \(loadRetry\.tryRecover\(\) === "ok"\)[^;]*loadURL\(/);
    expect(source).toMatch(/else offerRestart\("load"\);/);
  });

  it("asks through a native dialog and relaunches without a probe rung", () => {
    const source = functionSource("offerRestart");
    expect(source).toMatch(/const gpu = gpuBackendState\(\);\s*const softwareNext = gpu\.nextSoftware && !gpu\.software;/);
    expect(source).toMatch(/dialog\s*\.showMessageBox\(restartPrompt\(kind, softwareNext\)\)/);
    expect(source).toMatch(/if \(response === RESTART\) app\.relaunch\(relaunchWith\(\)\);/);
    expect(source).toMatch(/app\.quit\(\);/);
  });
});

// electron-builder ships only the files package.json lists; a local module
// main.cjs requires but the list leaves out works in development and stops the
// installed app at startup.
// The local files a module pulls in, following require() through every local
// .cjs it reaches. Paths are relative to electron/.
function localRequires(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const m of read(file).matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
    const dep = posix.normalize(posix.join(posix.dirname(file), m[1]));
    if (dep.endsWith(".cjs")) localRequires(dep, seen);
    else seen.add(dep);
  }
  return seen;
}

describe("packaged electron files", () => {
  it("lists every local module main.cjs and preload.cjs require, however deep", () => {
    const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")) as {
      build: { files: string[] };
    };
    const required = [...localRequires("main.cjs", localRequires("preload.cjs"))].map(
      (file) => `electron/${file}`,
    );
    expect(required).toContain("electron/gpu-backend.cjs");
    expect(required).toContain("electron/ipc/fs.cjs");
    expect(required).toContain("electron/extension-store/install.cjs");
    expect(required).toContain("electron/official-extensions.json");
    expect(required.filter((file) => !pkg.build.files.includes(file))).toEqual([]);
  });
});

describe("extension disk caches", () => {
  const files = [
    "trustCacheFile",
    "searchCacheFile",
    "registryIndexFile",
    "ogCacheFile",
    "iconCacheFile",
  ];

  it.each(files)("persists %s through the atomic writer", (name) => {
    for (const source of [MAIN, STORE])
      expect(source).not.toMatch(new RegExp(`writeFile\\(\\s*${name}\\(`));
    expect(STORE).toMatch(new RegExp(`fileWriter\\s*\\.write\\(\\s*${name}\\(`));
  });
});

describe("extension release channels", () => {
  const handled = publicChannels();
  const invoked = registrations(PRELOAD, "ipcRenderer\\s*\\.\\s*invoke").map(channelOf);

  it("serves release lists and a release's manifest", () => {
    for (const channel of ["plugins:releases", "plugins:manifest-at"]) {
      expect(handled).toContain(channel);
      expect(invoked).toContain(channel);
    }
  });

  it("passes a chosen version through to the installer", async () => {
    const installPlugin = vi.fn(async () => ({}));
    const { handler } = entry("plugins:install", { store: { installPlugin } as Partial<Deps["store"]> as Deps["store"] });
    await handler(NO_EVENT, "owner/repo", 2);
    await handler(NO_EVENT, "owner/repo", null);
    expect(installPlugin.mock.calls).toEqual([
      ["owner/repo", "2"],
      ["owner/repo", undefined],
    ]);
    expect(PRELOAD).toMatch(/install: \(spec, version\) =>/);
  });

  it("asks the update check for pre-releases on request", async () => {
    const fetchRemoteManifest = vi.fn(async () => null);
    const store = { fetchRemoteManifest } as Partial<Deps["store"]> as Deps["store"];
    const { handler } = entry("plugins:remote-manifest", { store });
    await handler(NO_EVENT, "owner/repo", { prerelease: 1 });
    await handler(NO_EVENT, "owner/repo");
    expect(fetchRemoteManifest.mock.calls).toEqual([
      ["owner/repo", { prerelease: true }],
      ["owner/repo", { prerelease: false }],
    ]);
  });
});

/**
 * The text of function `name` in `source` (main.cjs by default), up to the
 * closing brace at its own indent.
 */
function functionSource(name: string, source = MAIN): string {
  const head = new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`, "m").exec(source);
  expect(head, `${name} is defined`).not.toBeNull();
  const start = head!.index;
  const close = new RegExp(`\\r?\\n${head![1]}\\}\\r?\\n`).exec(source.slice(start));
  expect(close, `${name} ends at a brace on its own indent`).not.toBeNull();
  return source.slice(start, start + close!.index + close![0].length);
}

describe("extension download bounds", () => {
  // fetchWithTimeout stops its timer once headers arrive, so a body that
  // stalls afterwards would hang the awaiting install or update check for
  // good. An AbortSignal.timeout stays armed while the body is read.
  for (const [name, file] of [
    ["fetchManifestAt", "extension-store/releases.cjs"],
    ["fetchReleaseListLive", "extension-store/releases.cjs"],
    ["loadRegistryIndex", "extension-store/registry.cjs"],
    ["fetchBuffer", "extension-store/releases.cjs"],
    ["fetchTarballFiles", "extension-store/releases.cjs"],
  ]) {
    it(`${name} bounds the body read`, () => {
      const source = functionSource(name, read(file));
      expect(source).toMatch(/AbortSignal\.timeout\(/);
      expect(source).not.toMatch(/fetchWithTimeout\s*\(/);
    });
  }
});

describe("extension install and search wiring", () => {
  it("validates the repo before the ban gate and any fetch", () => {
    const source = functionSource("installPlugin", read("extension-store/install.cjs"));
    const valid = source.indexOf("validRepo(");
    expect(valid).toBeGreaterThanOrEqual(0);
    expect(valid).toBeLessThan(source.indexOf("bannedReason("));
    expect(valid).toBeLessThan(source.indexOf("fetchTrustList("));
  });

  it("keeps release zip URLs out of the results it hands the renderer", () => {
    const source = functionSource("searchExtensions", read("extension-store/search.cjs"));
    expect(source).toMatch(
      /filterRegistry\(index, query, vocabulary\)\s*\.map\(\(\{ versions, \.\.\.item \}\) => item\)/,
    );
  });

  it("serves the store vocabulary from the cached registry index", async () => {
    const source = functionSource("storeVocabulary", read("extension-store/registry.cjs"));
    expect(source).toMatch(/await fetchRegistryIndex\(false\)/);
    expect(source).toMatch(/registryIndexCache \? registryIndexCache\.vocabulary : null/);
    const storeVocabulary = vi.fn(async () => ({ topics: [] }));
    const store = { storeVocabulary } as Partial<Deps["store"]> as Deps["store"];
    const { privileged, handler } = entry("plugins:store-vocabulary", { store });
    expect(privileged).toBe(false);
    expect(await handler(NO_EVENT)).toEqual({ topics: [] });
    expect(PRELOAD).toMatch(/vocabulary: \(\) => ipcRenderer\.invoke\("plugins:store-vocabulary"\)/);
  });
});

describe("in-app updater", () => {
  const source = () => functionSource("installRelease");

  it("installs only Safelight's own releases", () => {
    expect(source()).toMatch(/if \(repo !== SAFELIGHT_REPO\) throw /);
  });

  it("refuses where this copy can't install itself", () => {
    expect(source()).toMatch(/const method = selfInstallMethod\(updateHost\(\)\);\s*if \(!method\) throw /);
  });

  it("refuses a release with no published checksum before downloading", () => {
    const s = source();
    expect(s).toMatch(/const expected = sha256Digest\(asset\.digest\);\s*if \(!expected\) throw new Error\("[^"]*no published checksum/);
    expect(s.indexOf("sha256Digest(")).toBeLessThan(s.indexOf("browser_download_url"));
  });

  it("streams the download through the checksum before running it", () => {
    const s = source();
    expect(s).not.toMatch(/arrayBuffer\(/);
    const check = s.indexOf("await downloadVerified(");
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(s.indexOf("launchDownloaded("));
  });

  // Ubuntu's App Center is a snap with a private /tmp, so it can't open a
  // package saved to temp.
  it("saves the download under Downloads, not temp", () => {
    expect(source()).toMatch(/app\.getPath\("downloads"\)/);
    expect(source()).not.toMatch(/app\.getPath\("temp"\)/);
  });

  it("quits only once launchDownloaded has seen the installer start", () => {
    expect(source()).toMatch(/await launchDownloaded\(/);
    expect(source()).not.toMatch(/^\s*(?:setTimeout\(\(\) => )?app\.quit\(\)/m);
    expect(source()).not.toMatch(/spawn\(/);
  });

  it("bounds the release metadata fetch", () => {
    expect(source()).toMatch(
      /releases\/tags\/\$\{encodeURIComponent\(tag\)\}`,\s*\{[^}]*\},\s*signal: AbortSignal\.timeout\(30_000\)/,
    );
  });

  it("clears earlier downloads before saving the new one", () => {
    const s = source();
    const clear = s.indexOf("await emptyDir(dir)");
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(clear).toBeLessThan(s.indexOf("await downloadVerified("));
  });

  it("runs one install at a time", async () => {
    expect(MAIN).toMatch(/const installReleaseOnce = oneAtATime\(installRelease\);/);
    expect(MAIN).toMatch(/ipcChannels\(\{[^}]*\binstallReleaseOnce,/);
    const installReleaseOnce = vi.fn(async () => {});
    const { privileged, handler } = entry("updates:install", { installReleaseOnce });
    expect(privileged).toBe(true);
    await handler(NO_EVENT, "anthonyreimche/SafeLight", 3);
    expect(installReleaseOnce.mock.calls).toEqual([["anthonyreimche/SafeLight", "3"]]);
  });

  it("tells the banner what this copy supports", () => {
    const updateHost = vi.fn(() => ({ platform: "win32", execPath: "C:\\Safelight\\Safelight.exe", env: {}, osRelease: "" }));
    const { privileged, handler } = entry("updates:support", { updateHost });
    expect(privileged).toBe(true);
    handler(NO_EVENT, ["Safelight-Setup.exe"]);
    expect(updateHost).toHaveBeenCalledTimes(1);
    expect(PRELOAD).toMatch(/support: \(assetNames\) =>/);
  });
});

// Without an application menu macOS loses Cmd+Q and the Edit shortcuts
// (copy and paste in text fields).
describe("application menu", () => {
  it("keeps the standard app, edit and window menus on macOS only", () => {
    expect(MAIN).toMatch(/process\.platform === "darwin"\s*\?\s*Menu\.buildFromTemplate\(MAC_MENU\)\s*:\s*null/);
    expect(MAIN).toMatch(/\{ role: "appMenu" \}, \{ role: "editMenu" \}, \{ role: "windowMenu" \}/);
    expect(MAIN).not.toMatch(/Menu\.setApplicationMenu\(null\)/);
  });
});

// A photo or folder opened from the OS reaches the first instance three ways:
// its own command line, a second launch's, and macOS's open-file (which can fire
// before ready). The renderer pulls what is waiting, so a path that arrived
// before it subscribed is not lost.
describe("opening paths from the OS", () => {
  it("reads the command line of the first launch and of a second one", () => {
    expect(MAIN).toMatch(/queueOsOpen\(argvPaths\(process\.argv, \{ defaultApp: process\.defaultApp, cwd: process\.cwd\(\) \}\)\)/);
    expect(MAIN).toMatch(
      /app\.on\("second-instance", \(_e, argv, workingDirectory\) => \{\s*queueOsOpen\(argvPaths\(argv, \{ defaultApp: process\.defaultApp, cwd: workingDirectory \}\)\);/,
    );
  });

  it("listens for open-file from the first line of the lock branch, ahead of ready", () => {
    expect(MAIN).toMatch(/app\.on\("open-file", \(event, filePath\) => \{\s*event\.preventDefault\(\);\s*queueOsOpen\(\[filePath\]\);/);
    expect(MAIN.indexOf('app.on("open-file"')).toBeLessThan(MAIN.indexOf("app.whenReady()"));
  });

  it("hands the waiting target over once, through the guarded channel", () => {
    expect(privilegedChannels()).toContain("os-open:take");
    expect(registrations(PRELOAD, "ipcRenderer\\s*\\.\\s*invoke").map(channelOf)).toContain("os-open:take");
    expect(MAIN).toMatch(/function takeOsOpen\(\) \{\s*const target = pendingOsOpen;\s*pendingOsOpen = null;\s*return target;/);
    const takeOsOpen = vi.fn(() => ({ folder: "/photos" }));
    expect(entry("os-open:take", { takeOsOpen }).handler(NO_EVENT)).toEqual({ folder: "/photos" });
  });

  it("tells the windows when another target arrives, over a channel the public bridge does not carry", () => {
    expect(MAIN).toMatch(/webContents\.send\("os-open:request"\)/);
    const privilegedSurface = PRELOAD.slice(0, PRELOAD.indexOf("contextBridge.exposeInMainWorld"));
    const publicSurface = PRELOAD.slice(PRELOAD.indexOf("contextBridge.exposeInMainWorld"));
    expect(privilegedSurface).toContain('"os-open:request"');
    expect(publicSurface).not.toContain("os-open");
  });

  // A relaunch after a GPU fallback is not a second request to open the file.
  it("relaunches without the paths the OS asked to open", () => {
    expect(MAIN).toMatch(/const relaunchArgv = \(\) => withoutPaths\(process\.argv, \{ defaultApp: process\.defaultApp \}\);/);
    expect(MAIN).toMatch(/relaunchOptions\(relaunchArgv\(\), process\.env, rung\)/);
    expect(MAIN).toMatch(/app\.relaunch\(relaunchWith\(rung\)\);/);
    expect(MAIN).not.toMatch(/relaunchArgs\(process\.argv/);
  });

  // The stat that resolves a request is async; the later request must win.
  it("takes a request's place in line before it waits on the disk", () => {
    expect(MAIN).toMatch(/const landOsOpen = createRequestOrder\(\);/);
    expect(MAIN).toMatch(/const lands = landOsOpen\(\);\s*const target = await openTargetFor\(paths\);\s*if \(!target \|\| !lands\(\)\) return;/);
  });

  it("ships the helper", () => {
    const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
    expect(pkg.build.files).toContain("electron/os-open.cjs");
  });
});
