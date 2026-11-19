// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The engine page after the settings are in place: main.tsx's boot without
// React, then the requests from `slu`. Extensions activate as in the GUI, so
// every stage, derive and input-profile resolver is registered; their panels
// are stored and never shown.

import { installErrorLog } from "@/diagnostics/error-log";
import { windowRole } from "@/diagnostics/environment";
import type { ExtensionManifest } from "@/extensions/types";
import { initExtensionHost } from "@/extensions/host";
import { isExtensionDisabled, isPluginRunning, useExternalPluginsSettled } from "@/extensions/loader";
import { bannedReasonForManifest } from "@/extensions/trust";
import { claimPrivileged, privilegedGpu } from "@/native/privileged";
import { ENGINE_PROTOCOL, type EngineExtensionState } from "./protocol";
import { serveEngine, type EngineChannel } from "./rpc";
import { EngineSession } from "./session";

/** A hidden window has no one to answer a dialog, and an open one blocks the
 *  page for good: each is logged and answered as if dismissed. */
function stubDialogs(): void {
  window.alert = (message?: unknown) => console.warn("[engine] alert:", message);
  window.confirm = (message?: string) => {
    console.warn("[engine] confirm, answered no:", message);
    return false;
  };
  window.prompt = (message?: string) => {
    console.warn("[engine] prompt, answered nothing:", message);
    return null;
  };
}

function externalPluginsSettled(): Promise<void> {
  return new Promise((resolve) => {
    if (useExternalPluginsSettled.getState().settled) return resolve();
    const stop = useExternalPluginsSettled.subscribe((s) => {
      if (!s.settled) return;
      stop();
      resolve();
    });
  });
}

async function extensionStates(): Promise<EngineExtensionState[]> {
  let manifests: ExtensionManifest[] = [];
  try {
    manifests = (await window.safelightNative?.plugins.list()) ?? [];
  } catch {
    return [];
  }
  return manifests.map((manifest) => {
    const { id, version } = manifest;
    const started = isPluginRunning(id);
    if (started || isExtensionDisabled(id)) return { id, version, started };
    const banned = bannedReasonForManifest(manifest);
    return { id, version, started, error: banned ?? "didn't start; see the log" };
  });
}

export async function boot(channel: EngineChannel): Promise<void> {
  installErrorLog({ source: windowRole() });
  stubDialogs();
  claimPrivileged();
  initExtensionHost();

  const session = new EngineSession();
  await externalPluginsSettled();
  const gpu = await privilegedGpu()?.backend().catch(() => null);
  channel.send({
    id: 0,
    type: "ready",
    protocol: ENGINE_PROTOCOL,
    appVersion: __APP_VERSION__,
    backend: gpu?.backend ?? "unknown",
    software: gpu?.software ?? false,
    extensions: await extensionStates(),
  });
  serveEngine(channel, {
    export: (req, out, signal) => session.export(req, out, signal),
    preview: (req, out, signal) => session.preview(req, out, signal),
    import: (req, out, signal) => session.import(req, out, signal),
    thumbs: (req, out, signal) => session.thumbs(req, out, signal),
    command: (req, out, signal) => session.command(req, out, signal),
    shutdown: () => session.close(),
  });
}
