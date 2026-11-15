// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Where `slu` finds the app: its userData folder and its code.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CliEnv } from "./types";

type EnvVars = Readonly<Record<string, string | undefined>>;

// Electron names userData after package.json productName, which electron-builder
// writes from build.productName. A development run (`electron .`) has none, so
// it uses the lowercase `name`; that only differs on case-sensitive Linux.
const APP_NAME = "Safelight";

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
  return paths.join(xdg && paths.isAbsolute(xdg) ? xdg : paths.join(home, ".config"), APP_NAME);
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
  return {
    cwd: src.cwd,
    userData: guiUserData(src.platform, src.env, src.home),
    appRoot: appRoot(src.moduleFile),
    appVersion: __APP_VERSION__,
    platform: src.platform,
    isTTY: src.isTTY,
    env: src.env,
  };
}
