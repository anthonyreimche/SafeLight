// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An extension that declares permissions.userOrigins may reach a server address
// the person types in (a photo server on the LAN, often plain http), once the
// person has allowed that address for it. The main process asks, keeps the
// answer and makes the requests, so neither the page's security policy nor
// mixed-content rules need widening for an address no manifest could name.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNetAccess, originOf } from "./net-access.cjs";

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-net-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const writer = {
  write: async (p: string, bytes: Uint8Array) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
  },
};

type Manifest = { id: string; name: string; permissions?: { userOrigins?: boolean; network?: string[] } };

function rig(
  opts: { manifests?: Manifest[]; consent?: boolean; fetchImpl?: typeof fetch; userData?: string; maxBodyBytes?: number } = {},
) {
  const userData = opts.userData ?? tempDir();
  const manifests = opts.manifests ?? [{ id: "ext.immich", name: "Immich Web Folders", permissions: { userOrigins: true } }];
  const showConsent = vi.fn(async () => opts.consent ?? true);
  const fetchImpl = vi.fn(opts.fetchImpl ?? (async () => new Response("ok", { status: 200 })));
  const access = createNetAccess({
    userData: () => userData,
    fileWriter: writer,
    findManifest: async (id: string) => manifests.find((m) => m.id === id) ?? null,
    showConsent,
    fetchImpl,
    maxBodyBytes: opts.maxBodyBytes,
  });
  return { access, showConsent, fetchImpl, userData };
}

describe("the size limit on an answer", () => {
  it("refuses an answer that declares more than the limit, without reading it", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(4)), cancel });
    const { access } = rig({
      maxBodyBytes: 8,
      fetchImpl: async () => new Response(body, { status: 200, headers: { "content-length": "9" } }),
    });
    await access.request(null, "ext.immich", "http://nas:2283");
    const res = await access.fetch("ext.immich", "r1", "http://nas:2283/big", {});
    expect(res).toEqual({ error: { kind: "too-large", message: expect.stringContaining("8 bytes") } });
  });

  it("stops reading an answer of undeclared length once it passes the limit", async () => {
    let sent = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull: (c) => {
        sent += 4;
        c.enqueue(new Uint8Array(4));
      },
      cancel,
    });
    const { access } = rig({ maxBodyBytes: 8, fetchImpl: async () => new Response(body, { status: 200 }) });
    await access.request(null, "ext.immich", "http://nas:2283");
    const res = await access.fetch("ext.immich", "r1", "http://nas:2283/endless", {});
    expect(res).toEqual({ error: { kind: "too-large", message: expect.stringContaining("8 bytes") } });
    expect(cancel).toHaveBeenCalled();
    expect(sent).toBeLessThanOrEqual(16);
  });

  it("hands back an answer of undeclared length that fits, whole", async () => {
    const parts = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const body = new ReadableStream<Uint8Array>({
      pull: (c) => {
        const next = parts.shift();
        if (next) c.enqueue(next);
        else c.close();
      },
    });
    const { access } = rig({ maxBodyBytes: 8, fetchImpl: async () => new Response(body, { status: 200 }) });
    await access.request(null, "ext.immich", "http://nas:2283");
    const res = await access.fetch("ext.immich", "r1", "http://nas:2283/small", {});
    expect([...(res as { body: Uint8Array }).body]).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("reading an answer with a declared length", () => {
  const chunked = (parts: number[][]) => {
    const rest = parts.map((p) => new Uint8Array(p));
    return new ReadableStream<Uint8Array>({
      pull: (c) => {
        const next = rest.shift();
        if (next) c.enqueue(next);
        else c.close();
      },
    });
  };
  const read = async (headers: Record<string, string>) => {
    const { access } = rig({
      fetchImpl: async () => new Response(chunked([[1, 2, 3], [4, 5]]), { status: 200, headers }),
    });
    await access.request(null, "ext.immich", "http://nas:2283");
    const res = await access.fetch("ext.immich", "r1", "http://nas:2283/x", {});
    return [...(res as { body: Uint8Array }).body];
  };

  it("returns the same bytes with and without a content-length", async () => {
    expect(await read({ "content-length": "5" })).toEqual([1, 2, 3, 4, 5]);
    expect(await read({})).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns only the bytes that arrived when the body is shorter than declared", async () => {
    expect(await read({ "content-length": "9" })).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns every byte when the body is longer than declared", async () => {
    expect(await read({ "content-length": "4" })).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("originOf", () => {
  it("takes the origin of an http or https address", () => {
    expect(originOf("http://192.168.1.20:2283/api/albums")).toBe("http://192.168.1.20:2283");
    expect(originOf("HTTPS://Photos.Example.com/")).toBe("https://photos.example.com");
  });

  it("refuses anything else", () => {
    for (const bad of ["file:///C:/x", "ftp://a.b", "javascript:alert(1)", "http://user:pw@a.b/", "not a url", ""])
      expect(originOf(bad)).toBeNull();
  });
});

describe("asking for an address", () => {
  it("asks the person once, naming the extension and the address, and keeps a yes", async () => {
    const { access, showConsent, userData } = rig();
    await expect(access.request(null, "ext.immich", "http://nas:2283/api")).resolves.toBe(true);
    expect(showConsent).toHaveBeenCalledWith(null, { name: "Immich Web Folders", origin: "http://nas:2283", plain: true });
    await expect(access.request(null, "ext.immich", "http://nas:2283/other")).resolves.toBe(true);
    expect(showConsent).toHaveBeenCalledTimes(1);

    // A later launch reads the answer back.
    const later = rig({ userData });
    await expect(later.access.has("ext.immich", "http://nas:2283")).resolves.toBe(true);
    await expect(later.access.has("ext.other", "http://nas:2283")).resolves.toBe(false);
  });

  it("keeps nothing on a no", async () => {
    const { access } = rig({ consent: false });
    await expect(access.request(null, "ext.immich", "http://nas:2283")).resolves.toBe(false);
    await expect(access.has("ext.immich", "http://nas:2283")).resolves.toBe(false);
  });

  it("isn't asked for an extension that didn't declare it", async () => {
    const { access, showConsent } = rig({ manifests: [{ id: "ext.immich", name: "X" }] });
    await expect(access.request(null, "ext.immich", "http://nas:2283")).resolves.toBe(false);
    await expect(access.request(null, "ext.missing", "http://nas:2283")).resolves.toBe(false);
    expect(showConsent).not.toHaveBeenCalled();
  });

  // A different extension installed later under the same id must not inherit them.
  it("forgets every address of an uninstalled extension, after a restart too, and no other's", async () => {
    const manifests = [
      { id: "ext.immich", name: "Immich Web Folders", permissions: { userOrigins: true } },
      { id: "ext.other", name: "Other", permissions: { userOrigins: true } },
    ];
    const { access, userData } = rig({ manifests });
    await access.request(null, "ext.immich", "http://nas:2283");
    await access.request(null, "ext.immich", "https://photos.example.com");
    await access.request(null, "ext.other", "http://nas:2283");
    await access.forget("ext.immich");
    await expect(access.has("ext.immich", "http://nas:2283")).resolves.toBe(false);
    await expect(access.has("ext.immich", "https://photos.example.com")).resolves.toBe(false);
    await expect(access.has("ext.other", "http://nas:2283")).resolves.toBe(true);
    const later = rig({ manifests, userData });
    await expect(later.access.has("ext.immich", "http://nas:2283")).resolves.toBe(false);
    await expect(later.access.has("ext.other", "http://nas:2283")).resolves.toBe(true);
  });

  it("forgets an address on revoke", async () => {
    const { access } = rig();
    await access.request(null, "ext.immich", "http://nas:2283");
    await access.revoke("ext.immich", "http://nas:2283/api");
    await expect(access.has("ext.immich", "http://nas:2283")).resolves.toBe(false);
  });
});

// Windows hands a file to antivirus or backup for a moment: a read refused then
// must not cost every extension the addresses it was allowed.
describe("the record of allowed addresses", () => {
  const record = (userData: string) => path.join(userData, "network-grants.json");
  const busy = () => {
    throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
  };

  afterEach(() => vi.restoreAllMocks());

  async function allowed() {
    const first = rig();
    await first.access.request(null, "ext.immich", "http://nas:2283");
    return first.userData;
  }

  it("is read again after a read that failed, and the address is still allowed", async () => {
    const { access } = rig({ userData: await allowed() });
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(busy);
    await expect(access.has("ext.immich", "http://nas:2283")).rejects.toThrow("EBUSY");
    expect(await access.has("ext.immich", "http://nas:2283")).toBe(true);
  });

  it("is never written over after a read that failed, and the person isn't asked", async () => {
    const userData = await allowed();
    const before = fs.readFileSync(record(userData), "utf8");
    const { access, showConsent } = rig({ userData });
    vi.spyOn(fs, "readFileSync").mockImplementation(busy);
    await expect(access.request(null, "ext.immich", "http://other:1")).rejects.toThrow("EBUSY");
    await expect(access.revoke("ext.immich", "http://nas:2283")).rejects.toThrow("EBUSY");
    await expect(access.forget("ext.immich")).rejects.toThrow("EBUSY");
    expect(showConsent).not.toHaveBeenCalled();
    vi.mocked(fs.readFileSync).mockRestore();
    expect(fs.readFileSync(record(userData), "utf8")).toBe(before);
  });

  it.each([
    ["isn't JSON", "{ broken"],
    ["is of a version this copy doesn't know", JSON.stringify({ version: 9, grants: {} })],
  ])("is moved aside before the first write when it %s", async (_why, text) => {
    const userData = tempDir();
    fs.writeFileSync(record(userData), text);
    const { access } = rig({ userData });
    expect(await access.has("ext.immich", "http://nas:2283")).toBe(false);
    expect(fs.existsSync(`${record(userData)}.bad`)).toBe(false);
    await access.request(null, "ext.immich", "http://nas:2283");
    expect(fs.readFileSync(`${record(userData)}.bad`, "utf8")).toBe(text);
    expect(await rig({ userData }).access.has("ext.immich", "http://nas:2283")).toBe(true);
  });
});

describe("requests", () => {
  it("reach an allowed address with the extension's headers, and hand back the whole answer", async () => {
    const { access, fetchImpl } = rig({
      fetchImpl: async () =>
        new Response(JSON.stringify([{ id: "a" }]), { status: 200, headers: { "content-type": "application/json" } }),
    });
    await access.request(null, "ext.immich", "http://nas:2283");
    const res = await access.fetch("ext.immich", "r1", "http://nas:2283/api/albums", {
      method: "GET",
      headers: { "x-api-key": "secret", Cookie: "dropped", Host: "dropped" },
    });
    expect(res).toMatchObject({ status: 200, headers: expect.arrayContaining([["content-type", "application/json"]]) });
    expect(new TextDecoder().decode((res as { body: Uint8Array }).body)).toBe('[{"id":"a"}]');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://nas:2283/api/albums");
    expect(init.headers).toEqual({ "x-api-key": "secret" });
    expect(init.redirect).toBe("manual");
  });

  it("are refused for an address the person hasn't allowed", async () => {
    const { access, fetchImpl } = rig();
    const res = await access.fetch("ext.immich", "r1", "http://nas:2283/api", {});
    expect(res).toEqual({ error: { kind: "refused", message: expect.stringContaining("http://nas:2283") } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("follow a redirect on the same address only", async () => {
    let n = 0;
    const { access } = rig({
      fetchImpl: async () =>
        ++n === 1
          ? new Response(null, { status: 302, headers: { location: "/api/b" } })
          : new Response(null, { status: 302, headers: { location: "https://elsewhere.example/x" } }),
    });
    await access.request(null, "ext.immich", "http://nas:2283");
    const res = await access.fetch("ext.immich", "r1", "http://nas:2283/api/a", {});
    expect(res).toEqual({ error: { kind: "refused", message: expect.stringContaining("another address") } });
    expect(n).toBe(2);
  });

  it("end at their time limit", async () => {
    vi.useFakeTimers();
    try {
      const { access } = rig({
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      });
      await access.request(null, "ext.immich", "http://nas:2283");
      const pending = access.fetch("ext.immich", "r1", "http://nas:2283/api", { timeoutMs: 2000 });
      await vi.advanceTimersByTimeAsync(2001);
      await expect(pending).resolves.toEqual({ error: { kind: "timeout", message: expect.any(String) } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop when the page aborts them", async () => {
    const { access } = rig({
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });
    await access.request(null, "ext.immich", "http://nas:2283");
    const pending = access.fetch("ext.immich", "r9", "http://nas:2283/api", {});
    access.abort("r9");
    await expect(pending).resolves.toEqual({ error: { kind: "aborted", message: expect.any(String) } });
  });

  it("say why the network failed", async () => {
    const { access } = rig({
      fetchImpl: async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      },
    });
    await access.request(null, "ext.immich", "http://nas:2283");
    await expect(access.fetch("ext.immich", "r1", "http://nas:2283/api", {})).resolves.toEqual({
      error: { kind: "network", message: "fetch failed (ECONNREFUSED)" },
    });
  });
});

describe("the net:* channels", () => {
  it("ask in a native dialogue naming the extension and the address, warning of plain http", async () => {
    const { netChannels } = await import("./ipc/net.cjs");
    const showMessageBox = vi.fn(async () => ({ response: 0 }));
    const win = {};
    const channels = netChannels({
      BrowserWindow: { fromWebContents: () => win },
      dialog: { showMessageBox },
      userData: () => tempDir(),
      fileWriter: writer,
      listPlugins: () => [{ id: "ext.immich", name: "Immich Web Folders", permissions: { userOrigins: true } }],
      devFolderFile: () => path.join(tempDir(), "dev-folder.json"),
    } as never) as { channel: string; privileged: boolean; handler: (...args: unknown[]) => Promise<unknown> }[];
    expect(channels.every((c) => c.privileged)).toBe(true);
    const request = channels.find((c) => c.channel === "net:requestOrigin")!.handler;
    await expect(request({ sender: {} }, "ext.immich", "http://nas:2283/api")).resolves.toBe(true);
    const [shownOn, options] = showMessageBox.mock.calls[0] as unknown as [unknown, { message: string; detail: string; buttons: string[] }];
    expect(shownOn).toBe(win);
    expect(options.message).toBe("Allow “Immich Web Folders” to connect to http://nas:2283?");
    expect(options.detail).toMatch(/plain HTTP/);
    expect(options.buttons).toEqual(["Allow", "Don't allow"]);
    const has = channels.find((c) => c.channel === "net:hasOrigin")!.handler;
    await expect(has({}, "ext.immich", "http://nas:2283")).resolves.toBe(true);
  });
});

// An origin the extension's own manifest names in permissions.network was
// shown to the person at install, and the page's CSP already lets the
// extension reach it. Through the main process it reaches it without asking
// and without the server having to answer CORS, which some APIs' content hosts
// never do.
describe("origins the manifest declares", () => {
  const google = {
    id: "ext.google",
    name: "Google Photos",
    permissions: {
      network: ["https://oauth2.googleapis.com", "https://*.googleusercontent.com", "wss://live.example.com"],
    },
  };

  it("are reached without asking, and count as allowed", async () => {
    const { access, showConsent, fetchImpl } = rig({ manifests: [google] });
    await expect(access.has("ext.google", "https://oauth2.googleapis.com/token")).resolves.toBe(true);
    await expect(access.request(null, "ext.google", "https://oauth2.googleapis.com")).resolves.toBe(true);
    const res = await access.fetch("ext.google", "r1", "https://oauth2.googleapis.com/token", { method: "POST", body: "a=b" });
    expect(res).toMatchObject({ status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(showConsent).not.toHaveBeenCalled();
  });

  it("match a wildcard at any subdomain depth but not the bare domain, at the default port only", async () => {
    const { access } = rig({ manifests: [google] });
    await expect(access.has("ext.google", "https://lh3.googleusercontent.com/x")).resolves.toBe(true);
    await expect(access.has("ext.google", "https://a.b.googleusercontent.com/x")).resolves.toBe(true);
    await expect(access.has("ext.google", "https://googleusercontent.com/x")).resolves.toBe(false);
    await expect(access.has("ext.google", "https://evilgoogleusercontent.com/x")).resolves.toBe(false);
    await expect(access.has("ext.google", "https://lh3.googleusercontent.com:8443/x")).resolves.toBe(false);
    await expect(access.has("ext.google", "http://lh3.googleusercontent.com/x")).resolves.toBe(false);
  });

  it("are the extension's own: another extension still has to ask", async () => {
    const { access, fetchImpl } = rig({ manifests: [google, { id: "ext.other", name: "Other" }] });
    const res = await access.fetch("ext.other", "r1", "https://oauth2.googleapis.com/token", {});
    expect(res).toEqual({ error: { kind: "refused", message: expect.any(String) } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("don't let a wildcard over a bare top-level domain reach everything under it", async () => {
    const broad = { id: "ext.broad", name: "Broad", permissions: { network: ["https://*.com"] } };
    const { access } = rig({ manifests: [broad] });
    await expect(access.has("ext.broad", "https://bank.com")).resolves.toBe(false);
  });

  it("never match an IP address with a wildcard, as the CSP never does", async () => {
    const ips = { id: "ext.ips", name: "IPs", permissions: { network: ["https://*.0.1", "https://*.168.1.20"] } };
    const { access } = rig({ manifests: [ips] });
    await expect(access.has("ext.ips", "https://127.0.0.1")).resolves.toBe(false);
    await expect(access.has("ext.ips", "https://192.168.1.20")).resolves.toBe(false);
  });

  it("drop the Authorization header when a redirect leaves the origin, as fetch does", async () => {
    const hops = [
      new Response(null, { status: 302, headers: { location: "/same" } }),
      new Response(null, { status: 302, headers: { location: "https://lh5.googleusercontent.com/b" } }),
      new Response("bytes", { status: 200 }),
    ];
    const { access, fetchImpl } = rig({ manifests: [google], fetchImpl: async () => hops.shift()! });
    const res = await access.fetch("ext.google", "r1", "https://lh3.googleusercontent.com/a", {
      headers: { Authorization: "Bearer t", "Proxy-Authorization": "p", Accept: "image/*" },
    });
    expect(res).toMatchObject({ status: 200 });
    const sent = fetchImpl.mock.calls.map((c) => (c[1] as RequestInit).headers);
    expect(sent[0]).toEqual({ Authorization: "Bearer t", "Proxy-Authorization": "p", Accept: "image/*" });
    expect(sent[1]).toEqual({ Authorization: "Bearer t", "Proxy-Authorization": "p", Accept: "image/*" });
    expect(sent[2]).toEqual({ Accept: "image/*" });
  });

  it("leave wss and malformed entries out of plain requests", async () => {
    const odd = { id: "ext.odd", name: "Odd", permissions: { network: ["wss://live.example.com", "*", "https://*", "http://x.example"] } };
    const { access } = rig({ manifests: [odd] });
    await expect(access.has("ext.odd", "https://live.example.com")).resolves.toBe(false);
    await expect(access.has("ext.odd", "https://anything.example")).resolves.toBe(false);
    await expect(access.has("ext.odd", "http://x.example")).resolves.toBe(false);
  });

  it("follow a redirect to another declared origin, and refuse one to an undeclared origin", async () => {
    const hops = [
      new Response(null, { status: 302, headers: { location: "https://lh5.googleusercontent.com/b" } }),
      new Response(null, { status: 302, headers: { location: "https://elsewhere.example/c" } }),
    ];
    const { access, fetchImpl } = rig({ manifests: [google], fetchImpl: async () => hops.shift()! });
    const res = await access.fetch("ext.google", "r1", "https://lh3.googleusercontent.com/a", {
      headers: { Authorization: "Bearer t" },
    });
    expect(res).toEqual({ error: { kind: "refused", message: expect.stringContaining("another address") } });
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://lh3.googleusercontent.com/a",
      "https://lh5.googleusercontent.com/b",
    ]);
  });

  it("can't be revoked: the manifest grants them", async () => {
    const { access } = rig({ manifests: [google] });
    await access.revoke("ext.google", "https://oauth2.googleapis.com");
    await expect(access.has("ext.google", "https://oauth2.googleapis.com")).resolves.toBe(true);
  });
});

describe("reading the declared origins", () => {
  it("reads an extension's manifest once per launch, like the CSP, and again after an uninstall", async () => {
    const manifests = [{ id: "ext.google", name: "Google Photos", permissions: { network: ["https://oauth2.googleapis.com"] } }];
    const userData = tempDir();
    const findManifest = vi.fn(async (id: string) => manifests.find((m) => m.id === id) ?? null);
    const access = createNetAccess({
      userData: () => userData,
      fileWriter: writer,
      findManifest,
      showConsent: async () => false,
      fetchImpl: async () => new Response("ok"),
    });
    for (let i = 0; i < 3; i++) await access.fetch("ext.google", `r${i}`, "https://oauth2.googleapis.com/token", {});
    expect(findManifest).toHaveBeenCalledTimes(1);
    await access.forget("ext.google");
    await access.has("ext.google", "https://oauth2.googleapis.com");
    expect(findManifest).toHaveBeenCalledTimes(2);
  });
});
