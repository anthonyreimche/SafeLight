// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.network: an extension reaches a server address the person allowed for it,
// or one its manifest declares. On the desktop the main process asks, keeps the
// answer and makes the request (electron/net-access.cjs), over the privileged
// bridge core holds, so the id it names is the calling extension's own. The
// browser build has no such bridge: there the page's own policy decides what
// can be reached. Signing in through the browser (electron/oauth-loopback.cjs)
// exists on the desktop only.

import type { AuthorizeOptions, NetworkAPI, NetworkRequestInit } from "./api/network";
import type { NativeNetBridge } from "./api/native-bridge";
import { privilegedNet } from "@/native/privileged";

const DEFAULT_TIMEOUT_MS = 30_000;
/** Statuses a Response can't be made with a body for. */
const NULL_BODY = new Set([101, 204, 205, 304]);

let requests = 0;

const isWebAddress = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

const abortError = () => new DOMException("The request was stopped.", "AbortError");

function failureOf(error: { kind: string; message: string }): Error {
  if (error.kind === "timeout") return new DOMException(error.message, "TimeoutError");
  if (error.kind === "aborted") return abortError();
  return new TypeError(error.message);
}

async function viaBridge(net: NativeNetBridge, extensionId: string, url: string, init: NetworkRequestInit): Promise<Response> {
  const { signal } = init;
  if (signal?.aborted) throw abortError();
  const requestId = `${extensionId}#${++requests}`;
  const sent = net.fetch(extensionId, requestId, url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    timeoutMs: init.timeoutMs,
  });
  let onAbort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => {
      void net.abort(requestId);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([sent, stopped]);
    if ("error" in result) throw failureOf(result.error);
    return new Response(NULL_BODY.has(result.status) ? null : result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function viaPage(url: string, init: NetworkRequestInit): Promise<Response> {
  const limit = AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, limit]) : limit;
  const body = init.body instanceof Uint8Array ? new Blob([init.body as BlobPart]) : init.body;
  return fetch(url, { method: init.method, headers: init.headers, body, credentials: "omit", signal });
}

async function authorizeVia(
  net: NativeNetBridge,
  extensionId: string,
  buildUrl: (redirectUri: string) => string,
  { timeoutMs, signal }: AuthorizeOptions,
): Promise<URLSearchParams> {
  const { authorizeListen, authorizeOpen, authorizeCancel } = net;
  if (!authorizeListen || !authorizeOpen || !authorizeCancel) {
    throw new DOMException("Signing in through the browser needs a newer Safelight.", "NotSupportedError");
  }
  if (signal?.aborted) throw abortError();
  const { session, redirectUri } = await authorizeListen(extensionId, timeoutMs);
  const cancel = () => void authorizeCancel(extensionId, session);
  let url: string;
  try {
    url = String(buildUrl(redirectUri));
  } catch (error) {
    cancel();
    throw error;
  }
  let onAbort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => {
      cancel();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const outcome = await Promise.race([authorizeOpen(extensionId, session, url), stopped]);
    if ("error" in outcome) throw failureOf(outcome.error);
    return new URLSearchParams(outcome.params);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** The network API of extension `extensionId`. */
export function networkAPI(extensionId: string): NetworkAPI {
  return {
    requestAccess: async (url) => {
      const net = privilegedNet();
      return net ? net.requestOrigin(extensionId, String(url)) : isWebAddress(String(url));
    },
    hasAccess: async (url) => {
      const net = privilegedNet();
      return net ? net.hasOrigin(extensionId, String(url)) : isWebAddress(String(url));
    },
    revokeAccess: async (url) => {
      await privilegedNet()?.revokeOrigin(extensionId, String(url));
    },
    fetch: (url, init = {}) => {
      const net = privilegedNet();
      return net ? viaBridge(net, extensionId, String(url), init) : viaPage(String(url), init);
    },
    authorizeInBrowser: async (buildUrl, options = {}) => {
      const net = privilegedNet();
      if (!net) throw new DOMException("Signing in through the browser needs the Safelight desktop app.", "NotSupportedError");
      return authorizeVia(net, extensionId, buildUrl, options);
    },
  };
}
