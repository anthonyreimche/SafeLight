// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The shapes of api.network: reaching a server address the person chose, or
// one the manifest declares, and signing in to a web service.

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

/** What `authorizeInBrowser` takes beyond the page's address. */
export interface AuthorizeOptions {
  /** How long to wait for the browser to come back, in ms: 5 minutes by
   *  default, between 1 second and 15 minutes. Past it the call rejects with a
   *  "TimeoutError". */
  timeoutMs?: number;
  /** Stop waiting (a Cancel button): the call rejects with an "AbortError". */
  signal?: AbortSignal;
}

/** A server whose address the person types in (a photo server on their
 *  network, plain http or https), which no manifest can name ahead of time. The
 *  extension declares `"permissions": { "userOrigins": true }`; each address is
 *  then allowed by the person, once, in a dialogue that names the extension,
 *  and stays allowed until revoked or the extension is uninstalled (an update
 *  keeps it). Requests are made by Safelight itself, not
 *  the page: no cookies go with them, and a redirect to another address is
 *  refused. Needs Safelight 3.2.4.
 *
 *  The https origins the manifest declares in `permissions.network` count as
 *  allowed without asking, and requests to them are made the same way, so a
 *  service that sends no CORS headers (a photo service's content host) can
 *  answer; a redirect may go to another declared origin, without the
 *  Authorization header. A wildcard entry ("https://*.example.com") covers
 *  every subdomain, not example.com itself nor an IP address.
 *  Needs Safelight 3.2.5. */
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
  /** Sign in to a web service the way desktop apps do (OAuth 2.0 for
   *  installed apps): Safelight listens once on the loopback interface, hands
   *  `buildUrl` the redirect address to put in the sign-in page's address
   *  (`http://127.0.0.1:<port>`, answered at "/"), opens the page, which must
   *  be https, in the person's own browser, and resolves with the query the
   *  browser is sent back with (`code` and `state`, or `error`). The browser
   *  tab then says it can be closed. The page's address must carry a
   *  `state`, and only an answer with the same `state` ends the wait. Check
   *  it yourself too, and use PKCE: any program on the computer can reach the
   *  listener. A new call ends this
   *  extension's earlier one. Rejects with a "TimeoutError" or "AbortError"
   *  (see AuthorizeOptions), a TypeError when the page can't be opened, and a
   *  "NotSupportedError" outside the desktop app. Needs Safelight 3.2.5. */
  authorizeInBrowser(buildUrl: (redirectUri: string) => string, options?: AuthorizeOptions): Promise<URLSearchParams>;
}
