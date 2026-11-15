// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.secrets: an extension keeps a sign-in token or a key encrypted by the
// OS keychain (Electron's safeStorage), never as plain text on disk, apart
// from every other extension's, and forgotten when it is uninstalled.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionSecrets } from "./extension-secrets.cjs";

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-secrets-"));
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

/** A keychain that reverses the text and marks it, so the file never holds it as given. */
function keychain(opts: { available?: boolean; backend?: string } = {}) {
  return {
    isEncryptionAvailable: () => opts.available ?? true,
    getSelectedStorageBackend: () => opts.backend ?? "gnome_libsecret",
    encryptString: (s: string) => Buffer.from(`enc:${[...s].reverse().join("")}`, "utf8"),
    decryptString: (b: Buffer) => [...b.toString("utf8").slice(4)].reverse().join(""),
  };
}

function rig(opts: { userData?: string; available?: boolean; backend?: string; platform?: string } = {}) {
  const userData = opts.userData ?? tempDir();
  const secrets = createExtensionSecrets({
    userData: () => userData,
    fileWriter: writer,
    safeStorage: keychain(opts),
    platform: opts.platform ?? "win32",
  });
  return { secrets, userData, file: path.join(userData, "extension-secrets.json") };
}

describe("extension secrets", () => {
  it("keeps a value encrypted, reads it back after a restart, and never writes it as given", async () => {
    const { secrets, userData, file } = rig();
    await secrets.set("ext.google", "refresh-token", "1//0abc-secret");
    await expect(secrets.get("ext.google", "refresh-token")).resolves.toBe("1//0abc-secret");
    expect(fs.readFileSync(file, "utf8")).not.toContain("1//0abc-secret");
    const later = rig({ userData });
    await expect(later.secrets.get("ext.google", "refresh-token")).resolves.toBe("1//0abc-secret");
  });

  it("keeps each extension's apart", async () => {
    const { secrets } = rig();
    await secrets.set("ext.a", "token", "a");
    await expect(secrets.get("ext.b", "token")).resolves.toBeNull();
  });

  it("deletes one value, and forgets all of an uninstalled extension's", async () => {
    const { secrets, userData } = rig();
    await secrets.set("ext.a", "one", "1");
    await secrets.set("ext.a", "two", "2");
    await secrets.set("ext.b", "one", "b");
    await secrets.delete("ext.a", "one");
    await expect(secrets.get("ext.a", "one")).resolves.toBeNull();
    await expect(secrets.get("ext.a", "two")).resolves.toBe("2");
    await secrets.forget("ext.a");
    const later = rig({ userData });
    await expect(later.secrets.get("ext.a", "two")).resolves.toBeNull();
    await expect(later.secrets.get("ext.b", "one")).resolves.toBe("b");
  });

  it("is unavailable without a keychain, and on Linux's plain-text fallback", async () => {
    expect(rig({ available: false }).secrets.available()).toBe(false);
    expect(rig({ platform: "linux", backend: "basic_text" }).secrets.available()).toBe(false);
    expect(rig({ platform: "linux", backend: "kwallet5" }).secrets.available()).toBe(true);
    const { secrets, file } = rig({ available: false });
    await expect(secrets.set("ext.a", "token", "x")).rejects.toThrow(/keychain/);
    await expect(secrets.get("ext.a", "token")).resolves.toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses odd keys and oversized values", async () => {
    const { secrets } = rig();
    await expect(secrets.set("ext.a", "../x", "v")).rejects.toThrow(/key/);
    await expect(secrets.set("ext.a", "", "v")).rejects.toThrow(/key/);
    await expect(secrets.set("ext.a", "k", "x".repeat(64 * 1024 + 1))).rejects.toThrow(/large/);
    await expect(secrets.get("ext.a", "__proto__")).resolves.toBeNull();
  });

  it("moves a damaged record aside before writing a new one", async () => {
    const { secrets, file } = rig();
    fs.writeFileSync(file, "{not json");
    await expect(secrets.get("ext.a", "token")).resolves.toBeNull();
    await secrets.set("ext.a", "token", "t");
    expect(fs.readFileSync(`${file}.bad`, "utf8")).toBe("{not json");
    await expect(secrets.get("ext.a", "token")).resolves.toBe("t");
  });

  it("answers null for a value the keychain can no longer read", async () => {
    const { secrets, userData, file } = rig();
    await secrets.set("ext.a", "token", "t");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.secrets["ext.a"].token = Buffer.from("garbage").toString("base64");
    fs.writeFileSync(file, JSON.stringify(saved));
    const broken = createExtensionSecrets({
      userData: () => userData,
      fileWriter: writer,
      safeStorage: {
        ...keychain(),
        decryptString: () => {
          throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
        },
      },
      platform: "win32",
    });
    await expect(broken.get("ext.a", "token")).resolves.toBeNull();
  });
});
