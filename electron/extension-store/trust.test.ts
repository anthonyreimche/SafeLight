// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// With no list on disk and no network, there is no blocklist to check against:
// the answer says so, so the installer can refuse what it can't vouch for.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTrustList } from "./trust.cjs";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-trust-"));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const offline = { fetch: async () => Promise.reject(new Error("offline")) };
const writer = { write: async (file: string, data: string) => fs.writeFileSync(file, data) };

function trustFor(net: { fetch: (url: string) => Promise<unknown> }) {
  return createTrustList({ net, userData: () => root, fileWriter: writer } as never);
}

const listOnDisk = {
  at: 1,
  list: { verified: [], reviewed: {}, repos: ["evil/tool"], owners: [], reason: {} },
};

describe("fetchTrustList", () => {
  it("marks the list unchecked when it was never fetched and the network fails", async () => {
    const list = await trustFor(offline).fetchTrustList();
    expect(list.unchecked).toBe(true);
    expect(list.repos).toEqual([]);
  });

  it("keeps the last list from disk, checked, when the network fails", async () => {
    fs.writeFileSync(path.join(root, "trust-cache.json"), JSON.stringify(listOnDisk));
    const list = await trustFor(offline).fetchTrustList(true);
    expect(list.unchecked).toBeUndefined();
    expect(list.repos).toEqual(["evil/tool"]);
  });

  it("tries the network again on the next call after an unchecked answer", async () => {
    let calls = 0;
    const flaky = {
      fetch: async () => {
        calls++;
        if (calls <= 2) throw new Error("offline");
        return { ok: true, status: 200, json: async () => ({ repos: ["evil/tool"] }) };
      },
    };
    const trust = trustFor(flaky);
    expect((await trust.fetchTrustList()).unchecked).toBe(true);
    const list = await trust.fetchTrustList();
    expect(list.unchecked).toBeUndefined();
    expect(list.repos).toEqual(["evil/tool"]);
  });
});
