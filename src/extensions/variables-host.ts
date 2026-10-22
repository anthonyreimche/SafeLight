// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// This window's shared-variables registry (variables.ts), synced with the
// other Safelight windows over its own BroadcastChannel. It is separate from
// "safelight-sync", which echoes locally and carries catalog traffic.

import { WINDOW_ID } from "@/state/broadcast";
import {
  createVariableRegistry,
  type VariableMessage,
  type VariableRegistry,
  type VariableTransport,
} from "./variables";

export const VARIABLES_CHANNEL = "safelight-variables";

let registry: VariableRegistry | null = null;

/** How other windows name this one: the detached Developer Tools window, a
 *  module pop-out by its module id, or "main". Read from the URL rather than
 *  the detach modules, which import the extension registry. */
export function windowLabel(search: string = window.location.search): string {
  const q = new URLSearchParams(search);
  if (q.get("devtools") === "1") return "Developer Tools";
  return q.get("detached") || "main";
}

function broadcastTransport(): VariableTransport {
  const channel = new BroadcastChannel(VARIABLES_CHANNEL);
  return {
    post: (m) => channel.postMessage(m),
    listen: (handler) => {
      const onMessage = (e: MessageEvent<VariableMessage>) => handler(e.data);
      channel.addEventListener("message", onMessage);
      return () => channel.removeEventListener("message", onMessage);
    },
  };
}

/** Start this window's registry and its sync. Runs first in
 *  initExtensionHost, before any extension can register, so the hello goes
 *  out as early as possible. */
export function initVariables(): void {
  if (registry) return;
  registry = createVariableRegistry({
    window: { id: WINDOW_ID, label: windowLabel() },
    transport: typeof BroadcastChannel === "undefined" ? null : broadcastTransport(),
  });
}

/** The registry, created for this window alone when initVariables hasn't run
 *  (tests that build a scoped API directly). */
export function variableRegistry(): VariableRegistry {
  registry ??= createVariableRegistry({ window: { id: WINDOW_ID, label: windowLabel() }, transport: null });
  return registry;
}

export function dropExtensionVariables(extension: string): void {
  registry?.dropExtension(extension);
}
