// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Signing in to a web service from an extension (api.network.authorizeInBrowser):
// the provider's page opens in the system browser and sends the person back to
// a one-time listener on the loopback interface, the redirect desktop OAuth
// clients are given now that custom schemes and copy-paste codes are gone.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackAuth } from "./oauth-loopback.cjs";

const AUTH_URL = "https://accounts.example.com/o/oauth2/auth?client_id=c&state=s1";
const opened: string[] = [];
const openExternal = vi.fn(async (url: string) => {
  opened.push(url);
});

afterEach(() => {
  opened.length = 0;
  openExternal.mockClear();
});

type Outcome = { params: [string, string][] } | { error: { kind: string; message: string } };

async function begin(auth: ReturnType<typeof createLoopbackAuth>, id = "ext.google", timeoutMs?: number) {
  const { session, redirectUri } = await auth.listen(id, timeoutMs);
  const outcome: Promise<Outcome> = auth.open(id, session, `${AUTH_URL}&redirect_uri=${encodeURIComponent(redirectUri)}`);
  return { session, redirectUri, outcome };
}

describe("the loopback listener", () => {
  it("listens on 127.0.0.1 at a free port and hands back that address", async () => {
    const auth = createLoopbackAuth({ openExternal });
    const { session, redirectUri, outcome } = await begin(auth);
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(opened).toEqual([`${AUTH_URL}&redirect_uri=${encodeURIComponent(redirectUri)}`]);
    auth.cancel("ext.google", session);
    await expect(outcome).resolves.toMatchObject({ error: { kind: "aborted" } });
  });

  it("resolves with the query the browser comes back with, answers with a fixed page, and stops listening", async () => {
    const auth = createLoopbackAuth({ openExternal });
    const { redirectUri, outcome } = await begin(auth);
    const res = await fetch(`${redirectUri}/?state=s1&code=4%2F0Ab&scope=email`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const page = await res.text();
    expect(page).toContain("close this tab");
    expect(page).not.toContain("4/0Ab");
    await expect(outcome).resolves.toEqual({
      params: [
        ["state", "s1"],
        ["code", "4/0Ab"],
        ["scope", "email"],
      ],
    });
    await expect(fetch(`${redirectUri}/?code=again`)).rejects.toThrow();
  });

  it("takes an error answer as the outcome too", async () => {
    const auth = createLoopbackAuth({ openExternal });
    const { redirectUri, outcome } = await begin(auth);
    await fetch(`${redirectUri}/?error=access_denied&state=s1`);
    await expect(outcome).resolves.toEqual({ params: [["error", "access_denied"], ["state", "s1"]] });
  });

  it("ignores an answer that doesn't carry the state the page was opened with", async () => {
    const auth = createLoopbackAuth({ openExternal });
    const { session, redirectUri } = await auth.listen("ext.google");
    const page = `https://accounts.example.com/auth?state=s-42&redirect_uri=${encodeURIComponent(redirectUri)}`;
    const outcome = auth.open("ext.google", session, page);
    expect((await fetch(`${redirectUri}/?error=access_denied`)).status).toBe(404);
    expect((await fetch(`${redirectUri}/?code=forged&state=other`)).status).toBe(404);
    await fetch(`${redirectUri}/?code=real&state=s-42`);
    await expect(outcome).resolves.toEqual({ params: [["code", "real"], ["state", "s-42"]] });
  });

  it("ignores answers that come before the page is opened", async () => {
    const auth = createLoopbackAuth({ openExternal });
    const { session, redirectUri } = await auth.listen("ext.google");
    expect((await fetch(`${redirectUri}/?code=early&state=s1`)).status).toBe(404);
    const outcome = auth.open("ext.google", session, AUTH_URL);
    await fetch(`${redirectUri}/?code=real&state=s1`);
    await expect(outcome).resolves.toEqual({ params: [["code", "real"], ["state", "s1"]] });
  });

  it("refuses a page address without a state, which would let any answer through", async () => {
    const auth = createLoopbackAuth({ openExternal });
    const { session } = await auth.listen("ext.google");
    await expect(auth.open("ext.google", session, "https://accounts.example.com/auth?client_id=c")).resolves.toMatchObject({
      error: { kind: "refused", message: expect.stringContaining("state") },
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("answers 400 to a request it can't read, and keeps listening", async () => {
    const auth = createLoopbackAuth({ openExternal });
    const { session, redirectUri, outcome } = await begin(auth);
    const { request } = await import("node:http");
    const port = new URL(redirectUri).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "//", headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(400);
    auth.cancel("ext.google", session);
    await expect(outcome).resolves.toMatchObject({ error: { kind: "aborted" } });
  });

  it("ignores other paths, requests without an answer, and other methods", async () => {
    const auth = createLoopbackAuth({ openExternal });
    const { session, redirectUri, outcome } = await begin(auth);
    expect((await fetch(`${redirectUri}/favicon.ico`)).status).toBe(404);
    expect((await fetch(`${redirectUri}/`)).status).toBe(404);
    expect((await fetch(`${redirectUri}/?code=x`, { method: "POST" })).status).toBe(404);
    auth.cancel("ext.google", session);
    await expect(outcome).resolves.toMatchObject({ error: { kind: "aborted" } });
  });

  it("refuses a request naming another host, as a rebinding page would", async () => {
    const auth = createLoopbackAuth({ openExternal });
    const { session, redirectUri, outcome } = await begin(auth);
    const { request } = await import("node:http");
    const port = new URL(redirectUri).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/?code=forged", headers: { Host: `evil.example:${port}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(421);
    auth.cancel("ext.google", session);
    await expect(outcome).resolves.toMatchObject({ error: { kind: "aborted" } });
  });

  it("stops listening at its time limit", async () => {
    const auth = createLoopbackAuth({ openExternal });
    const { redirectUri, outcome } = await begin(auth, "ext.google", 30);
    await expect(outcome).resolves.toMatchObject({ error: { kind: "timeout" } });
    await expect(fetch(`${redirectUri}/?code=late`)).rejects.toThrow();
  });

  it("keeps the time limit between one second and fifteen minutes", () => {
    const auth = createLoopbackAuth({ openExternal });
    expect(auth.clampTimeout(undefined)).toBe(5 * 60_000);
    expect(auth.clampTimeout(10)).toBe(1_000);
    expect(auth.clampTimeout(60 * 60_000)).toBe(15 * 60_000);
  });

  it("opens only an https address, and stops listening when it can't", async () => {
    const auth = createLoopbackAuth({ openExternal });
    for (const url of ["http://accounts.example.com/auth", "javascript:alert(1)", "file:///c:/x", "not a url"]) {
      const { session, redirectUri } = await auth.listen("ext.google");
      await expect(auth.open("ext.google", session, url)).resolves.toMatchObject({ error: { kind: "refused" } });
      await expect(fetch(`${redirectUri}/?code=x`)).rejects.toThrow();
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("belongs to the extension that started it", async () => {
    const auth = createLoopbackAuth({ openExternal });
    const { session } = await auth.listen("ext.google");
    await expect(auth.open("ext.other", session, AUTH_URL)).resolves.toMatchObject({ error: { kind: "refused" } });
    auth.cancel("ext.other", session);
    const outcome = auth.open("ext.google", session, AUTH_URL);
    auth.cancel("ext.google", session);
    await expect(outcome).resolves.toMatchObject({ error: { kind: "aborted" } });
  });

  it("ends an extension's earlier sign-in when it starts another", async () => {
    const auth = createLoopbackAuth({ openExternal });
    const first = await begin(auth);
    const second = await begin(auth);
    await expect(first.outcome).resolves.toMatchObject({ error: { kind: "aborted" } });
    await expect(fetch(`${first.redirectUri}/?code=x`)).rejects.toThrow();
    await fetch(`${second.redirectUri}/?code=y&state=s1`);
    await expect(second.outcome).resolves.toEqual({ params: [["code", "y"], ["state", "s1"]] });
  });

  it("says when the system browser couldn't be opened", async () => {
    const auth = createLoopbackAuth({
      openExternal: async () => {
        throw new Error("no browser");
      },
    });
    const { outcome } = await begin(auth);
    await expect(outcome).resolves.toEqual({ error: { kind: "network", message: expect.stringContaining("no browser") } });
  });

  it("answers an unknown session as refused", async () => {
    const auth = createLoopbackAuth({ openExternal });
    await expect(auth.open("ext.google", "nope", AUTH_URL)).resolves.toMatchObject({ error: { kind: "refused" } });
  });
});
