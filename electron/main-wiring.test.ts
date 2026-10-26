// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The preload hands the fs:* and updates:install channels only to core, once,
// at boot. main.cjs must register each through handlePrivileged, which refuses
// every document but the app's own top frame; a bare ipcMain registration would
// answer an extension's own page too. main.cjs can't run under vitest, so this
// reads it as text: a registration whose channel is a string literal is seen,
// one built from a variable is not.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = readFileSync(join(HERE, "main.cjs"), "utf8");
const PRELOAD = readFileSync(join(HERE, "preload.cjs"), "utf8");

const PRIVILEGED = /^(?:fs:.+|updates:install|diagnostics:capturePage|gpu:.+)$/;

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
    // The scan still sees main.cjs's ordinary registrations.
    const direct = registrations(MAIN, "ipcMain\\s*\\.\\s*handle").map(channelOf);
    expect(direct).toContain("plugins:list");
    expect(unguarded(MAIN)).toEqual([]);
  });

  it("guards every privileged channel the preload hands out", () => {
    const handedOut = registrations(PRELOAD, "ipcRenderer\\s*\\.\\s*invoke")
      .map(channelOf)
      .filter((channel) => PRIVILEGED.test(channel));
    const guarded = registrations(MAIN, "handlePrivileged").map(channelOf);
    expect(handedOut).toContain("fs:write");
    expect(handedOut).toContain("updates:install");
    expect(handedOut).toContain("diagnostics:capturePage");
    expect(handedOut).toContain("gpu:setSoftware");
    expect(handedOut.filter((channel) => !guarded.includes(channel))).toEqual([]);
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
  const handled = registrations(MAIN, "ipcMain\\s*\\.\\s*handle").map(channelOf);
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
describe("Linux GPU backend fallback", () => {
  it("takes its backends and switches from gpu-backend.cjs", () => {
    expect(MAIN).toMatch(/const ANGLE_BACKENDS = angleBackends\(isWayland\);/);
    expect(MAIN).toMatch(/for \(const \[name, value\] of angleSwitches\(backend\)\)/);
  });

  it("moves the next launch to software once WebGL2 is lost", () => {
    expect(MAIN).toMatch(
      /app\.on\("gpu-info-update", \(\) => \{\s*if \(webgl2Lost\(app\.getGPUFeatureStatus\(\)\)\) fallBackToSoftware\(/,
    );
  });

  it("moves the next launch to software once GPU crash recovery gives up", () => {
    expect(MAIN).toMatch(/if \(recover\) for \(const win of windows\) win\.webContents\.reload\(\);\s*else fallBackToSoftware\(/);
  });
});

// electron-builder ships only the files package.json lists; a local module
// main.cjs requires but the list leaves out works in development and stops the
// installed app at startup.
describe("packaged electron files", () => {
  it("lists every local module main.cjs and preload.cjs require", () => {
    const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")) as {
      build: { files: string[] };
    };
    const required = [...`${MAIN}\n${PRELOAD}`.matchAll(/require\(\s*["']\.\/([\w.-]+\.cjs)["']\s*\)/g)].map(
      (m) => `electron/${m[1]}`,
    );
    expect(required).toContain("electron/gpu-backend.cjs");
    expect(required.filter((file) => !pkg.build.files.includes(file))).toEqual([]);
  });
});

describe("extension release channels", () => {
  const handled = registrations(MAIN, "ipcMain\\s*\\.\\s*handle").map(channelOf);
  const invoked = registrations(PRELOAD, "ipcRenderer\\s*\\.\\s*invoke").map(channelOf);

  it("serves release lists and a release's manifest", () => {
    for (const channel of ["plugins:releases", "plugins:manifest-at"]) {
      expect(handled).toContain(channel);
      expect(invoked).toContain(channel);
    }
  });

  it("passes a chosen version through to the installer", () => {
    expect(MAIN).toMatch(/ipcMain\.handle\("plugins:install", \(_e, spec, version\) =>/);
    expect(PRELOAD).toMatch(/install: \(spec, version\) =>/);
  });

  it("asks the update check for pre-releases on request", () => {
    expect(MAIN).toMatch(/ipcMain\.handle\("plugins:remote-manifest", \(_e, repo, opts\) =>/);
  });
});

/** The text of top-level function `name` in main.cjs, up to its closing brace. */
function functionSource(name: string): string {
  const start = MAIN.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  expect(start, `${name} is defined in main.cjs`).toBeGreaterThanOrEqual(0);
  const close = /\r?\n\}\r?\n/.exec(MAIN.slice(start));
  expect(close, `${name} ends at a top-level brace`).not.toBeNull();
  return MAIN.slice(start, start + close!.index + close![0].length);
}

describe("extension download bounds", () => {
  // fetchWithTimeout stops its timer once headers arrive, so a body that
  // stalls afterwards would hang the awaiting install or update check for
  // good. An AbortSignal.timeout stays armed while the body is read.
  for (const name of [
    "fetchManifestAt",
    "fetchReleaseListLive",
    "loadRegistryIndex",
    "fetchBuffer",
    "fetchTarballFiles",
  ]) {
    it(`${name} bounds the body read`, () => {
      const source = functionSource(name);
      expect(source).toMatch(/AbortSignal\.timeout\(/);
      expect(source).not.toMatch(/fetchWithTimeout\s*\(/);
    });
  }
});

describe("extension install and search wiring", () => {
  it("validates the repo before the ban gate and any fetch", () => {
    const source = functionSource("installPlugin");
    const valid = source.indexOf("validRepo(");
    expect(valid).toBeGreaterThanOrEqual(0);
    expect(valid).toBeLessThan(source.indexOf("bannedReason("));
    expect(valid).toBeLessThan(source.indexOf("fetchTrustList("));
  });

  it("keeps release zip URLs out of the results it hands the renderer", () => {
    const source = functionSource("searchExtensions");
    expect(source).toMatch(
      /filterRegistry\(index, query, vocabulary\)\s*\.map\(\(\{ versions, \.\.\.item \}\) => item\)/,
    );
  });

  it("serves the store vocabulary from the cached registry index", () => {
    const source = functionSource("storeVocabulary");
    expect(source).toMatch(/await fetchRegistryIndex\(false\)/);
    expect(source).toMatch(/registryIndexCache \? registryIndexCache\.vocabulary : null/);
    expect(MAIN).toMatch(/ipcMain\.handle\("plugins:store-vocabulary", \(\) => storeVocabulary\(\)\)/);
    expect(PRELOAD).toMatch(/vocabulary: \(\) => ipcRenderer\.invoke\("plugins:store-vocabulary"\)/);
  });
});
