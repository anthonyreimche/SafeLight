// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Where `safelight` finds the app: its userData folder and its code.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CliEnv } from "./types";

type EnvVars = Readonly<Record<string, string | undefined>>;

// The folder Electron names userData after. The Windows and macOS builds use
// productName; the Linux AppImage keeps it in lowercase `safelight` (checked on
// the 3.2.2 and 3.2.5 releases), which differs there as paths are case-sensitive.
const APP_NAME = "Safelight";
const LINUX_APP_NAME = "safelight";

/** The installed app's userData folder: SLU_USER_DATA when set, else the folder
 *  Electron picks for this app on the platform. */
export function guiUserData(
  platform: NodeJS.Platform = process.platform,
  env: EnvVars = process.env,
  home: string = homedir(),
): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (env.SLU_USER_DATA) return paths.resolve(env.SLU_USER_DATA);
  if (platform === "win32") {
    return paths.join(env.APPDATA || paths.join(home, "AppData", "Roaming"), APP_NAME);
  }
  if (platform === "darwin") return paths.join(home, "Library", "Application Support", APP_NAME);
  const xdg = env.XDG_CONFIG_HOME;
  return paths.join(xdg && paths.isAbsolute(xdg) ? xdg : paths.join(home, ".config"), LINUX_APP_NAME);
}

function isSafelightPackage(file: string): boolean {
  try {
    const pkg: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof pkg === "object" && pkg !== null && "name" in pkg && pkg.name === "safelight";
  } catch {
    return false;
  }
}

/** The repo root in a development run (the nearest folder above `moduleFile`
 *  holding Safelight's package.json), else `<resources>/app.asar` beside the
 *  bundle's `<resources>/cli` folder. */
export function appRoot(moduleFile: string): string {
  for (let dir = path.dirname(moduleFile); ; dir = path.dirname(dir)) {
    if (isSafelightPackage(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) break;
  }
  return path.join(path.dirname(path.dirname(moduleFile)), "app.asar");
}

export interface ElectronProbe {
  /** process.versions.electron: set when the CLI itself runs inside Electron. */
  electronVersion: string | undefined;
  execPath: string;
  exists: (file: string) => boolean;
}

const REAL_PROBE: ElectronProbe = {
  electronVersion: process.versions.electron,
  execPath: process.execPath,
  exists: existsSync,
};

/** The Electron binary that runs the engine. The CLI itself may be plain Node, so
 *  process.execPath is only the answer when it already is Electron. */
export function electronBinary(
  platform: NodeJS.Platform,
  env: EnvVars,
  root: string,
  probe: ElectronProbe = REAL_PROBE,
): string | null {
  if (probe.electronVersion) return probe.execPath;
  if (env.SAFELIGHT_ELECTRON) return env.SAFELIGHT_ELECTRON;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const dist = paths.join(root, "node_modules", "electron", "dist");
  const bin = platform === "win32" ? paths.join(dist, "electron.exe")
    : platform === "darwin" ? paths.join(dist, "Electron.app", "Contents", "MacOS", "Electron")
    : paths.join(dist, "electron");
  return probe.exists(bin) ? bin : null;
}

export interface CliEnvSource {
  cwd: string;
  env: EnvVars;
  platform: NodeJS.Platform;
  home: string;
  isTTY: CliEnv["isTTY"];
  /** The running bundle (or source file), for appRoot. */
  moduleFile: string;
}

export function cliEnv(src: CliEnvSource): CliEnv {
  const root = appRoot(src.moduleFile);
  return {
    cwd: src.cwd,
    userData: guiUserData(src.platform, src.env, src.home),
    appRoot: root,
    electronBinary: electronBinary(src.platform, src.env, root),
    appVersion: __APP_VERSION__,
    platform: src.platform,
    isTTY: src.isTTY,
    env: src.env,
  };
}
