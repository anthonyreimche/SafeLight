// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.sockets: live connections an extension may open to an address the person
// allowed for it. On the desktop the main process asks and keeps the answer
// (electron/socket-access.cjs), and the next launch's network policy takes the
// address; the privileged bridge core holds names the calling extension. The
// browser build has no bridge: there the page's own policy decides.

import type { SocketAccess, SocketsAPI } from "./api/sockets";
import { privilegedSockets } from "@/native/privileged";

const ANSWERS: readonly SocketAccess[] = ["allowed", "after-restart", "not-allowed"];

const accessOf = (value: unknown): SocketAccess => ANSWERS.find((a) => a === value) ?? "not-allowed";

const isSocketAddress = (url: string): boolean => {
  try {
    return new URL(url).protocol === "wss:";
  } catch {
    return false;
  }
};

/** The sockets API of extension `extensionId`. */
export function socketsAPI(extensionId: string): SocketsAPI {
  return {
    requestAccess: async (url) => {
      const sockets = privilegedSockets();
      if (!sockets) return isSocketAddress(String(url)) ? "allowed" : "not-allowed";
      return accessOf(await sockets.request(extensionId, String(url)));
    },
    status: async (url) => {
      const sockets = privilegedSockets();
      if (!sockets) return isSocketAddress(String(url)) ? "allowed" : "not-allowed";
      return accessOf(await sockets.status(extensionId, String(url)));
    },
    list: async () => {
      const found = (await privilegedSockets()?.list(extensionId)) ?? [];
      return found.filter((o): o is string => typeof o === "string");
    },
    revokeAccess: async (url) => {
      await privilegedSockets()?.revoke(extensionId, String(url));
    },
  };
}
