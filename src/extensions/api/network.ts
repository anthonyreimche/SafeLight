// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The shapes of api.network: reaching a server address the person chose.

export interface NetworkRequestInit {
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Cookie, Host, Origin and Referer are never sent. */
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** How long the whole request may take, in ms: 30 s by default, between 1 s
   *  and 30 minutes. A request past it rejects with a "TimeoutError". */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A server whose address the person types in (a photo server on their
 *  network, plain http or https), which no manifest can name ahead of time. The
 *  extension declares `"permissions": { "userOrigins": true }`; each address is
 *  then allowed by the person, once, in a dialogue that names the extension,
 *  and stays allowed until revoked or the extension is uninstalled (an update
 *  keeps it). Requests are made by Safelight itself, not
 *  the page: no cookies go with them, and a redirect to another address is
 *  refused. Needs Safelight 3.2.4. */
export interface NetworkAPI {
  /** Ask the person to allow the address (origin) of `url`, unless it already
   *  is; resolves with whether it is allowed now. Ask from a click: the dialogue
   *  should answer something the person just did. */
  requestAccess(url: string): Promise<boolean>;
  /** Whether the address of `url` is allowed, without asking. */
  hasAccess(url: string): Promise<boolean>;
  /** Stop allowing the address of `url`. */
  revokeAccess(url: string): Promise<void>;
  /** Send a request to an allowed address. Resolves with the answer as a
   *  Response, whatever its status; rejects with a TypeError when the address
   *  isn't allowed or the server can't be reached, a "TimeoutError" past
   *  `timeoutMs`, and an "AbortError" when `signal` aborts. Answers are capped
   *  at 1 GiB. */
  fetch(url: string, init?: NetworkRequestInit): Promise<Response>;
}
