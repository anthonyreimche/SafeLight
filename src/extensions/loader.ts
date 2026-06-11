// External plugin loader. Plugins live in <userData>/plugins/<id>/ on disk,
// are served by the Electron app:// protocol under /__plugins__/, and are
// dynamic-imported as ESM. They never bundle React — they use api.react.

import type { ExtensionManifest, ExtensionModule } from "./types";
import { unregisterExtension } from "./registry";
import { applySavedTheme } from "./themes";
import { makeScopedAPI } from "./host";

const loaded = new Map<string, ExtensionModule>();

async function loadPlugin(manifest: ExtensionManifest): Promise<void> {
  if (loaded.has(manifest.id)) return;
  const url = `${location.origin}/__plugins__/${manifest.id}/${manifest.main}`;
  const mod = (await import(/* @vite-ignore */ url)) as Partial<ExtensionModule>;
  if (typeof mod.activate !== "function")
    throw new Error(`${manifest.id}: bundle has no activate(api) export`);
  mod.activate(makeScopedAPI(manifest.id));
  loaded.set(manifest.id, mod as ExtensionModule);
}

export async function loadExternalPlugins(): Promise<void> {
  const native = window.safelightNative;
  if (!native) return; // plain-browser dev build
  let list: ExtensionManifest[] = [];
  try {
    list = await native.plugins.list();
  } catch {
    return;
  }
  for (const manifest of list) {
    try {
      await loadPlugin(manifest);
    } catch (e) {
      console.error(`[extensions] failed to load ${manifest.id}:`, e);
    }
  }
  // The saved theme may belong to a plugin that just registered it.
  applySavedTheme();
}

export async function installFromGitHub(
  spec: string,
): Promise<ExtensionManifest> {
  const native = window.safelightNative;
  if (!native) throw new Error("Requires the desktop app.");
  const manifest = await native.plugins.install(spec);
  await loadPlugin(manifest); // live, no restart
  return manifest;
}

export async function uninstallPlugin(id: string): Promise<void> {
  const native = window.safelightNative;
  loaded.get(id)?.deactivate?.();
  loaded.delete(id);
  unregisterExtension(id);
  await native?.plugins.uninstall(id);
}
