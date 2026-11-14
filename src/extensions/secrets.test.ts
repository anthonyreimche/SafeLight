// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.secrets over the privileged bridge: core names the extension asking, so
// one extension's secrets are never another's. The browser build has no
// keychain, so there it keeps nothing.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeSecretsBridge } from "./api/native-bridge";

const h = vi.hoisted(() => ({ secrets: null as NativeSecretsBridge | null }));
vi.mock("@/native/privileged", () => ({ privilegedSecrets: () => h.secrets }));

import { secretsAPI } from "./secrets";

afterEach(() => {
  h.secrets = null;
});

describe("api.secrets through the desktop bridge", () => {
  it("names the extension it belongs to", async () => {
    const bridge = {
      available: vi.fn(async () => true),
      get: vi.fn(async () => "t"),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    h.secrets = bridge;
    const api = secretsAPI("ext.google");
    await expect(api.available()).resolves.toBe(true);
    await expect(api.get("refresh-token")).resolves.toBe("t");
    await api.set("refresh-token", "new");
    await api.delete("refresh-token");
    expect(bridge.get).toHaveBeenCalledWith("ext.google", "refresh-token");
    expect(bridge.set).toHaveBeenCalledWith("ext.google", "refresh-token", "new");
    expect(bridge.delete).toHaveBeenCalledWith("ext.google", "refresh-token");
  });
});

describe("api.secrets in the browser build", () => {
  it("is unavailable, keeps nothing and says so when asked to", async () => {
    const api = secretsAPI("ext.google");
    await expect(api.available()).resolves.toBe(false);
    await expect(api.get("refresh-token")).resolves.toBeNull();
    await expect(api.set("refresh-token", "x")).rejects.toMatchObject({ name: "NotSupportedError" });
    await expect(api.delete("refresh-token")).resolves.toBeUndefined();
  });
});
