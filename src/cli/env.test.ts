// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { appRoot, cliEnv, electronBinary, guiUserData } from "./env";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

describe("guiUserData", () => {
  it("is Roaming AppData on Windows", () => {
    expect(guiUserData("win32", { APPDATA: "C:\\Users\\ann\\AppData\\Roaming" }, "C:\\Users\\ann")).toBe(
      "C:\\Users\\ann\\AppData\\Roaming\\Safelight",
    );
  });

  it("falls back to the home folder when APPDATA is missing", () => {
    expect(guiUserData("win32", {}, "C:\\Users\\ann")).toBe("C:\\Users\\ann\\AppData\\Roaming\\Safelight");
  });

  it("is Application Support on macOS", () => {
    expect(guiUserData("darwin", {}, "/Users/ann")).toBe("/Users/ann/Library/Application Support/Safelight");
  });

  it("follows XDG_CONFIG_HOME on Linux, else ~/.config, in the lowercase folder the Linux app keeps", () => {
    expect(guiUserData("linux", { XDG_CONFIG_HOME: "/xdg" }, "/home/ann")).toBe("/xdg/safelight");
    expect(guiUserData("linux", {}, "/home/ann")).toBe("/home/ann/.config/safelight");
  });

  it("ignores a relative XDG_CONFIG_HOME, as the spec says", () => {
    expect(guiUserData("linux", { XDG_CONFIG_HOME: "rel" }, "/home/ann")).toBe("/home/ann/.config/safelight");
  });

  it("uses SLU_USER_DATA when set", () => {
    expect(guiUserData("linux", { SLU_USER_DATA: "/tmp/profile" }, "/home/ann")).toBe("/tmp/profile");
    expect(guiUserData("win32", { SLU_USER_DATA: "D:\\temp\\profile", APPDATA: "C:\\x" }, "C:\\Users\\ann")).toBe(
      "D:\\temp\\profile",
    );
  });
});

describe("appRoot", () => {
  let temp: string | null = null;
  afterEach(async () => {
    if (temp) await rm(temp, { recursive: true, force: true });
    temp = null;
  });

  it("is the repo in a development run", () => {
    expect(appRoot(join(REPO, "dist-cli", "safelight.mjs"))).toBe(REPO);
    expect(appRoot(join(HERE, "env.ts"))).toBe(REPO);
  });

  it("is app.asar beside the bundle's folder when installed", async () => {
    temp = await mkdtemp(join(tmpdir(), "slu-root-"));
    const resources = join(temp, "resources");
    await mkdir(join(resources, "cli"), { recursive: true });
    expect(appRoot(join(resources, "cli", "safelight.mjs"))).toBe(join(resources, "app.asar"));
  });

  it("skips a package.json that isn't Safelight's", async () => {
    temp = await mkdtemp(join(tmpdir(), "slu-root-"));
    await writeFile(join(temp, "package.json"), JSON.stringify({ name: "other" }));
    await mkdir(join(temp, "resources", "cli"), { recursive: true });
    expect(appRoot(join(temp, "resources", "cli", "safelight.mjs"))).toBe(join(temp, "resources", "app.asar"));
  });
});

describe("cliEnv", () => {
  it("takes userData, platform, terminals and version from what it is given", () => {
    const env = cliEnv({
      cwd: "/work",
      env: { SLU_USER_DATA: "/profile" },
      platform: "linux",
      home: "/home/ann",
      isTTY: { stdin: false, stdout: true, stderr: true },
      moduleFile: join(HERE, "env.ts"),
    });
    expect(env).toMatchObject({
      cwd: "/work",
      userData: "/profile",
      appRoot: REPO,
      platform: "linux",
      isTTY: { stdin: false, stdout: true, stderr: true },
    });
    expect(env.appVersion).toBe(__APP_VERSION__);
  });
});

describe("electronBinary", () => {
  const probe = (over: Partial<Parameters<typeof electronBinary>[3]> = {}) => ({
    electronVersion: undefined, execPath: "/usr/bin/node", exists: () => true, ...over,
  });

  it("is the running binary when the CLI already runs inside Electron", () => {
    expect(electronBinary("win32", { SAFELIGHT_ELECTRON: "X" }, "C:\\r", probe({ electronVersion: "40.0.0", execPath: "C:\\e.exe" }))).toBe("C:\\e.exe");
  });

  it("takes SAFELIGHT_ELECTRON next", () => {
    expect(electronBinary("linux", { SAFELIGHT_ELECTRON: "/opt/electron" }, "/r", probe())).toBe("/opt/electron");
  });

  it("finds the repo's Electron per platform, and only if it exists", () => {
    expect(electronBinary("win32", {}, "C:\\r", probe())).toBe("C:\\r\\node_modules\\electron\\dist\\electron.exe");
    expect(electronBinary("darwin", {}, "/r", probe())).toBe("/r/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
    expect(electronBinary("linux", {}, "/r", probe())).toBe("/r/node_modules/electron/dist/electron");
    expect(electronBinary("linux", {}, "/r", probe({ exists: () => false }))).toBeNull();
  });
});
