// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.network over the privileged bridge: the extension asking is named by the
// core, answers come back as Responses, and failures as the errors fetch gives.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeNetBridge, NativeNetResult } from "./api/native-bridge";

const h = vi.hoisted(() => ({ net: null as NativeNetBridge | null }));
vi.mock("@/native/privileged", () => ({ privilegedNet: () => h.net }));

import { networkAPI } from "./network";

function bridge(result: NativeNetResult | Promise<NativeNetResult>) {
  const net = {
    requestOrigin: vi.fn(async () => true),
    hasOrigin: vi.fn(async () => true),
    revokeOrigin: vi.fn(async () => {}),
    fetch: vi.fn(async () => result),
    abort: vi.fn(async () => {}),
  };
  h.net = net;
  return net;
}

afterEach(() => {
  h.net = null;
  vi.unstubAllGlobals();
});

describe("api.network through the desktop bridge", () => {
  it("names the extension it belongs to", async () => {
    const net = bridge({ status: 204, statusText: "No Content", headers: [], body: new Uint8Array() });
    const api = networkAPI("ext.immich");
    await expect(api.requestAccess("http://nas:2283")).resolves.toBe(true);
    await api.hasAccess("http://nas:2283");
    await api.revokeAccess("http://nas:2283");
    await api.fetch("http://nas:2283/api", { headers: { "x-api-key": "k" }, timeoutMs: 5000 });
    expect(net.requestOrigin).toHaveBeenCalledWith("ext.immich", "http://nas:2283");
    expect(net.hasOrigin).toHaveBeenCalledWith("ext.immich", "http://nas:2283");
    expect(net.revokeOrigin).toHaveBeenCalledWith("ext.immich", "http://nas:2283");
    expect(net.fetch).toHaveBeenCalledWith("ext.immich", expect.any(String), "http://nas:2283/api", {
      method: undefined,
      headers: { "x-api-key": "k" },
      body: undefined,
      timeoutMs: 5000,
    });
  });

  it("hands back the answer as a Response", async () => {
    bridge({
      status: 200,
      statusText: "OK",
      headers: [["content-type", "application/json"]],
      body: new TextEncoder().encode('{"res":"pong"}'),
    });
    const res = await networkAPI("ext.a").fetch("http://nas:2283/api/server/ping");
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toBe("application/json");
    await expect(res.json()).resolves.toEqual({ res: "pong" });
  });

  it("rejects as fetch does when the request fails", async () => {
    const api = networkAPI("ext.a");
    bridge({ error: { kind: "network", message: "fetch failed (ECONNREFUSED)" } });
    await expect(api.fetch("http://nas:2283")).rejects.toThrow(new TypeError("fetch failed (ECONNREFUSED)"));
    bridge({ error: { kind: "refused", message: "not allowed" } });
    await expect(api.fetch("http://nas:2283")).rejects.toBeInstanceOf(TypeError);
    bridge({ error: { kind: "timeout", message: "no answer within 5 s" } });
    await expect(api.fetch("http://nas:2283")).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("stops a request its signal aborts", async () => {
    const net = bridge(new Promise<NativeNetResult>(() => {}));
    const ac = new AbortController();
    const pending = networkAPI("ext.a").fetch("http://nas:2283", { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const requestId = (net.fetch.mock.calls[0] as unknown[])[1];
    expect(net.abort).toHaveBeenCalledWith(requestId);
  });
});

describe("api.network in the browser build", () => {
  it("lets the page's own policy decide, with no cookies", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);
    const api = networkAPI("ext.a");
    await expect(api.requestAccess("https://photos.example")).resolves.toBe(true);
    await expect(api.requestAccess("file:///C:/")).resolves.toBe(false);
    await expect((await api.fetch("https://photos.example/api")).text()).resolves.toBe("ok");
    expect(fetchSpy).toHaveBeenCalledWith("https://photos.example/api", expect.objectContaining({ credentials: "omit" }));
  });
});

describe("api.network.authorizeInBrowser", () => {
  type Outcome = Awaited<ReturnType<NonNullable<NativeNetBridge["authorizeOpen"]>>>;

  function authBridge(outcome: Outcome | Promise<Outcome>) {
    const net = bridge({ status: 204, statusText: "No Content", headers: [], body: new Uint8Array() });
    const full = Object.assign(net, {
      authorizeListen: vi.fn(async () => ({ session: "s1", redirectUri: "http://127.0.0.1:53682" })),
      authorizeOpen: vi.fn(async () => outcome),
      authorizeCancel: vi.fn(async () => {}),
    });
    h.net = full;
    return full;
  }

  it("builds the page's address around the listener's, opens it, and hands back the query", async () => {
    const net = authBridge({ params: [["code", "4/0A"], ["state", "xyz"]] });
    const build = vi.fn((redirect: string) => `https://accounts.example.com/auth?redirect_uri=${encodeURIComponent(redirect)}`);
    const query = await networkAPI("ext.google").authorizeInBrowser(build, { timeoutMs: 60_000 });
    expect(build).toHaveBeenCalledWith("http://127.0.0.1:53682");
    expect(net.authorizeListen).toHaveBeenCalledWith("ext.google", 60_000);
    expect(net.authorizeOpen).toHaveBeenCalledWith(
      "ext.google",
      "s1",
      "https://accounts.example.com/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A53682",
    );
    expect(query.get("code")).toBe("4/0A");
    expect(query.get("state")).toBe("xyz");
  });

  it("rejects as fetch does when the sign-in ends without an answer", async () => {
    authBridge({ error: { kind: "timeout", message: "no answer" } });
    await expect(networkAPI("ext.a").authorizeInBrowser(() => "https://a.example")).rejects.toMatchObject({ name: "TimeoutError" });
    authBridge({ error: { kind: "refused", message: "must be https" } });
    await expect(networkAPI("ext.a").authorizeInBrowser(() => "http://a.example")).rejects.toBeInstanceOf(TypeError);
  });

  it("stops listening when its signal aborts", async () => {
    const net = authBridge(new Promise<Outcome>(() => {}));
    const ac = new AbortController();
    const pending = networkAPI("ext.a").authorizeInBrowser(() => "https://a.example", { signal: ac.signal });
    await vi.waitFor(() => expect(net.authorizeOpen).toHaveBeenCalled());
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(net.authorizeCancel).toHaveBeenCalledWith("ext.a", "s1");
  });

  it("stops listening when building the address throws", async () => {
    const net = authBridge({ params: [] });
    await expect(
      networkAPI("ext.a").authorizeInBrowser(() => {
        throw new Error("no client id");
      }),
    ).rejects.toThrow("no client id");
    expect(net.authorizeCancel).toHaveBeenCalledWith("ext.a", "s1");
    expect(net.authorizeOpen).not.toHaveBeenCalled();
  });

  it("isn't there outside the desktop app", async () => {
    h.net = null;
    await expect(networkAPI("ext.a").authorizeInBrowser(() => "https://a.example")).rejects.toMatchObject({
      name: "NotSupportedError",
    });
  });
});
