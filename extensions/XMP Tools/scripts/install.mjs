// Build the extension, then copy it into SafeLight's plugins directory so the
// app loads it like any installed external extension.
//
// Target resolution:
//   1. --dir <path>            CLI argument (used alone, if given)
//   2. SAFELIGHT_PLUGINS_DIR   environment variable (used alone, if given)
//   3. <userData>/plugins      every EXISTING candidate — the app's userData
//      dir name differs between a packaged build ("Safelight") and a dev run via
//      `electron .` ("safelight"), and we can't know which is running, so we
//      install into all that already exist. Pass --dir to be explicit.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT_ID = "com.safelight.xmp-tools";

function userDataBase() {
  switch (process.platform) {
    case "win32":
      return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support");
    default:
      return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  }
}

function resolvePluginsDirs() {
  const argIdx = process.argv.indexOf("--dir");
  if (argIdx !== -1 && process.argv[argIdx + 1]) return [process.argv[argIdx + 1]];
  if (process.env.SAFELIGHT_PLUGINS_DIR) return [process.env.SAFELIGHT_PLUGINS_DIR];

  const base = userDataBase();
  // Packaged app uses productName "Safelight"; `electron .` dev uses "safelight".
  const existing = ["safelight", "Safelight"]
    .map((name) => path.join(base, name))
    .filter((dir) => fs.existsSync(dir))
    .map((dir) => path.join(dir, "plugins"));
  // None present yet (app never run?) — default to the dev location.
  return existing.length ? existing : [path.join(base, "safelight", "plugins")];
}

await import("./build.mjs");

for (const pluginsDir of resolvePluginsDirs()) {
  const target = path.join(pluginsDir, EXT_ID);
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(
    path.join(EXT_DIR, "safelight.json"),
    path.join(target, "safelight.json"),
  );
  fs.cpSync(path.join(EXT_DIR, "dist"), path.join(target, "dist"), { recursive: true });
  console.log(`[xmp-tools] installed to ${target}`);
}
console.log("[xmp-tools] restart SafeLight (or re-enable the extension) to load it.");
