// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An extension that declares permissions.userSockets may open live connections
// (WebSockets) to a server address the person types in, such as a studio's own
// sync relay, once the person has allowed that address for it. The page opens
// the socket itself, so the address joins the page's connect-src: at the next
// launch, read from the grants kept here, through the same validation as a
// manifest's declared origins.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSocketAccess, readSocketGrantOrigins, socketOriginOf } from "./socket-access.cjs";

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-sockets-"));
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

type Manifest = { id: string; name: string; permissions?: { userSockets?: boolean; userOrigins?: boolean } };

const COLLAB: Manifest = { id: "studio-collab", name: "Studio Collab", permissions: { userSockets: true } };

function rig(opts: { manifests?: Manifest[]; consent?: boolean; launch?: string[]; userData?: string } = {}) {
  const userData = opts.userData ?? tempDir();
  const manifests = opts.manifests ?? [COLLAB];
  const showConsent = vi.fn(async () => opts.consent ?? true);
  const access = createSocketAccess({
    userData: () => userData,
    fileWriter: writer,
    findManifest: async (id: string) => manifests.find((m) => m.id === id) ?? null,
    showConsent,
    launchOrigins: () => opts.launch ?? [],
  });
  return { access, showConsent, userData, file: path.join(userData, "socket-grants.json") };
}

describe("socketOriginOf", () => {
  it("takes the wss origin of an address, path and all", () => {
    expect(socketOriginOf("wss://relay.studio.example/v1/rooms/abc/socket")).toBe("wss://relay.studio.example");
    expect(socketOriginOf("wss://Relay.Studio.Example:8443")).toBe("wss://relay.studio.example:8443");
    expect(socketOriginOf("wss://10.0.0.5:9000")).toBe("wss://10.0.0.5:9000");
  });

  it("refuses anything the page's policy shouldn't take", () => {
    for (const bad of [
      "ws://relay.studio.example",
      "https://relay.studio.example",
      "wss://user:pw@relay.studio.example",
      "wss://*.studio.example",
      "wss://[::1]:9000",
      "wss://relay.studio.example 'unsafe-eval'",
      "javascript:alert(1)",
      "",
      "not a url",
    ])
      expect(socketOriginOf(bad)).toBeNull();
  });
});

describe("createSocketAccess", () => {
  it("asks once, names the extension and the address, and keeps the answer", async () => {
    const { access, showConsent } = rig();
    expect(await access.request(null, "studio-collab", "wss://relay.studio.example/v1/rooms/x/socket")).toBe("after-restart");
    expect(showConsent).toHaveBeenCalledWith(null, { name: "Studio Collab", origin: "wss://relay.studio.example" });
    expect(await access.request(null, "studio-collab", "wss://relay.studio.example")).toBe("after-restart");
    expect(showConsent).toHaveBeenCalledTimes(1);
    expect(await access.list("studio-collab")).toEqual(["wss://relay.studio.example"]);
  });

  it("says an address is usable now once this launch's policy holds it", async () => {
    const { access } = rig({ launch: ["wss://relay.studio.example"] });
    expect(await access.status("studio-collab", "wss://relay.studio.example")).toBe("not-allowed");
    expect(await access.request(null, "studio-collab", "wss://relay.studio.example")).toBe("allowed");
    expect(await access.status("studio-collab", "wss://relay.studio.example")).toBe("allowed");
  });

  it("keeps nothing when the person says no", async () => {
    const { access, file } = rig({ consent: false });
    expect(await access.request(null, "studio-collab", "wss://relay.studio.example")).toBe("not-allowed");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("asks nothing for an extension that doesn't declare userSockets, or for a bad address", async () => {
    const { access, showConsent } = rig({ manifests: [{ id: "other", name: "Other", permissions: { userOrigins: true } }] });
    expect(await access.request(null, "other", "wss://relay.studio.example")).toBe("not-allowed");
    expect(await access.request(null, "studio-collab", "wss://relay.studio.example")).toBe("not-allowed");
    const declared = rig();
    expect(await declared.access.request(null, "studio-collab", "ws://relay.studio.example")).toBe("not-allowed");
    expect(showConsent).not.toHaveBeenCalled();
    expect(declared.showConsent).not.toHaveBeenCalled();
  });

  it("keeps each extension's grants apart", async () => {
    const other: Manifest = { id: "other", name: "Other", permissions: { userSockets: true } };
    const { access } = rig({ manifests: [COLLAB, other] });
    await access.request(null, "studio-collab", "wss://relay.studio.example");
    expect(await access.status("other", "wss://relay.studio.example")).toBe("not-allowed");
    expect(await access.list("other")).toEqual([]);
  });

  it("revokes one address, and forgets everything for an uninstalled extension", async () => {
    const { access } = rig();
    await access.request(null, "studio-collab", "wss://a.example");
    await access.request(null, "studio-collab", "wss://b.example");
    await access.revoke("studio-collab", "wss://a.example/any/path");
    expect(await access.list("studio-collab")).toEqual(["wss://b.example"]);
    await access.forget("studio-collab");
    expect(await access.list("studio-collab")).toEqual([]);
  });

  it("keeps no grant that failed to reach the disk", async () => {
    const userData = tempDir();
    const access = createSocketAccess({
      userData: () => userData,
      fileWriter: { write: async () => Promise.reject(new Error("disk full")) },
      findManifest: async () => COLLAB,
      showConsent: async () => true,
      launchOrigins: () => [],
    });
    await expect(access.request(null, "studio-collab", "wss://relay.studio.example")).rejects.toThrow("disk full");
    expect(await access.status("studio-collab", "wss://relay.studio.example")).toBe("not-allowed");
  });

  it("turns down a second request while its dialogue is still open, instead of stacking another", async () => {
    let answer: (yes: boolean) => void = () => {};
    const userData = tempDir();
    const showConsent = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const access = createSocketAccess({
      userData: () => userData,
      fileWriter: writer,
      findManifest: async () => COLLAB,
      showConsent,
      launchOrigins: () => [],
    });
    const first = access.request(null, "studio-collab", "wss://a.example");
    await vi.waitFor(() => expect(showConsent).toHaveBeenCalledTimes(1));
    expect(await access.request(null, "studio-collab", "wss://b.example")).toBe("not-allowed");
    answer(true);
    expect(await first).toBe("after-restart");
    expect(showConsent).toHaveBeenCalledTimes(1);
  });

  it("moves a damaged record aside before writing a new one", async () => {
    const userData = tempDir();
    fs.writeFileSync(path.join(userData, "socket-grants.json"), "{not json");
    const { access, file } = rig({ userData });
    await access.request(null, "studio-collab", "wss://relay.studio.example");
    expect(fs.readFileSync(`${file}.bad`, "utf8")).toBe("{not json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      version: 1,
      grants: { "studio-collab": ["wss://relay.studio.example"] },
    });
  });
});

describe("readSocketGrantOrigins", () => {
  async function grantsFile(grants: unknown): Promise<string> {
    const file = path.join(tempDir(), "socket-grants.json");
    fs.writeFileSync(file, typeof grants === "string" ? grants : JSON.stringify(grants));
    return file;
  }

  it("gives the granted origins of installed extensions that still declare userSockets", async () => {
    const file = await grantsFile({
      version: 1,
      grants: {
        "studio-collab": ["wss://relay.studio.example", "wss://relay.studio.example"],
        "stopped-declaring": ["wss://old.example"],
        "uninstalled": ["wss://gone.example"],
      },
    });
    const manifests = [COLLAB, { id: "stopped-declaring", name: "S", permissions: {} }];
    expect(await readSocketGrantOrigins(file, manifests)).toEqual(["wss://relay.studio.example"]);
  });

  it("lets nothing malformed reach the policy, whatever the file holds", async () => {
    const file = await grantsFile({
      version: 1,
      grants: {
        "studio-collab": ["*", "'unsafe-eval'", "wss://ok.example", "https://not-a-socket.example", "wss://*.wild.example", "data:"],
      },
    });
    expect(await readSocketGrantOrigins(file, [COLLAB])).toEqual(["wss://ok.example"]);
  });

  it("gives nothing for a missing, damaged or unknown record", async () => {
    expect(await readSocketGrantOrigins(path.join(tempDir(), "missing.json"), [COLLAB])).toEqual([]);
    expect(await readSocketGrantOrigins(await grantsFile("{oops"), [COLLAB])).toEqual([]);
    expect(await readSocketGrantOrigins(await grantsFile({ version: 2, grants: { "studio-collab": ["wss://a.example"] } }), [COLLAB])).toEqual([]);
  });
});
