// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.sockets over the privileged bridge: core names the extension asking,
// and the browser build, with no bridge, lets the page's own policy decide.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeSocketsBridge } from "./api/native-bridge";

const h = vi.hoisted(() => ({ sockets: null as NativeSocketsBridge | null }));
vi.mock("@/native/privileged", () => ({ privilegedSockets: () => h.sockets }));

import { socketsAPI } from "./sockets";

afterEach(() => {
  h.sockets = null;
});

describe("api.sockets through the desktop bridge", () => {
  it("names the extension it belongs to on every call", async () => {
    const bridge = {
      request: vi.fn(async () => "after-restart"),
      status: vi.fn(async () => "allowed"),
      list: vi.fn(async () => ["wss://relay.example"]),
      revoke: vi.fn(async () => {}),
    };
    h.sockets = bridge;
    const api = socketsAPI("studio-collab");
    await expect(api.requestAccess("wss://relay.example/v1")).resolves.toBe("after-restart");
    await expect(api.status("wss://relay.example")).resolves.toBe("allowed");
    await expect(api.list()).resolves.toEqual(["wss://relay.example"]);
    await api.revokeAccess("wss://relay.example");
    expect(bridge.request).toHaveBeenCalledWith("studio-collab", "wss://relay.example/v1");
    expect(bridge.status).toHaveBeenCalledWith("studio-collab", "wss://relay.example");
    expect(bridge.list).toHaveBeenCalledWith("studio-collab");
    expect(bridge.revoke).toHaveBeenCalledWith("studio-collab", "wss://relay.example");
  });

  it("turns an answer it doesn't know into not allowed", async () => {
    h.sockets = {
      request: vi.fn(async () => "maybe"),
      status: vi.fn(async () => "allowed"),
      list: vi.fn(async () => ["wss://ok.example", 3]),
      revoke: vi.fn(async () => {}),
    };
    const api = socketsAPI("studio-collab");
    await expect(api.requestAccess("wss://relay.example")).resolves.toBe("not-allowed");
    await expect(api.list()).resolves.toEqual(["wss://ok.example"]);
  });
});

describe("api.sockets in the browser build", () => {
  it("lets the page's policy decide for wss addresses and refuses others", async () => {
    const api = socketsAPI("studio-collab");
    await expect(api.requestAccess("wss://relay.example")).resolves.toBe("allowed");
    await expect(api.status("ws://relay.example")).resolves.toBe("not-allowed");
    await expect(api.list()).resolves.toEqual([]);
    await expect(api.revokeAccess("wss://relay.example")).resolves.toBeUndefined();
  });
});
