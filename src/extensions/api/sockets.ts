// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The shapes of api.sockets: live connections to a server address the person
// chose.

/** Whether the extension may open a WebSocket to an address: "allowed" now,
 *  allowed but only from the next launch ("after-restart"), or not. */
export type SocketAccess = "allowed" | "after-restart" | "not-allowed";

/** Live connections (WebSockets) to a server whose address the person types
 *  in, such as a studio's own sync relay, which no manifest can name ahead of
 *  time. The extension declares `"permissions": { "userSockets": true }`; each
 *  address is a secure WebSocket origin (`wss://`) that the person allows,
 *  once, in a dialogue that names the extension. The page opens the socket
 *  itself (`new WebSocket(url)`), so an allowed address joins the app's
 *  network policy, and like every change to it, that happens the next time
 *  Safelight starts. An allowed address stays allowed until revoked (here or
 *  on the extension's page in the Extensions window) or the extension is
 *  uninstalled; an update keeps it. Needs Safelight 3.2.5. */
export interface SocketsAPI {
  /** Ask the person to allow live connections to the address (origin) of
   *  `url`, a `wss://` URL, unless it already is. Ask from a click: the
   *  dialogue should answer something the person just did. */
  requestAccess(url: string): Promise<SocketAccess>;
  /** Whether the address of `url` is allowed, and from when, without asking. */
  status(url: string): Promise<SocketAccess>;
  /** The addresses allowed for this extension. */
  list(): Promise<string[]>;
  /** Stop allowing the address of `url`, from the next launch. */
  revokeAccess(url: string): Promise<void>;
}
