// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The trust registry decides whether third-party code is allowed to run, so
// these tests pin the refusal side of the contract: default-deny for anything
// unknown, spec/repo normalisation, owner-wide bans, ban-beats-verified, and a
// registry outage never widening what is permitted. Run with `npm test`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bannedReason,
  bannedReasonForManifest,
  dismissFlag,
  flagBannedExtension,
  isBanned,
  isVerified,
  loadTrustList,
  repoFromSpec,
  reviewedFor,
  useTrust,
  verificationStatus,
} from "./trust.ts";
import type { ExtensionManifest, TrustList } from "./types.ts";

const trustList = (over: Partial<TrustList> = {}): TrustList => ({
  verified: [],
  reviewed: {},
  repos: [],
  owners: [],
  reason: {},
  ...over,
});

const seed = (list: TrustList): void =>
  useTrust.setState({ list, loadedAt: 0, flagged: [] });

const manifest = (over: Partial<ExtensionManifest> = {}): ExtensionManifest => ({
  id: "acme.tool",
  name: "Acme Tool",
  version: "1.0.0",
  main: "dist/index.js",
  ...over,
});

function memoryStorage(seedEntries: Record<string, string> = {}) {
  const map = new Map(Object.entries(seedEntries));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  } satisfies Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

/** Only the slice of the Electron bridge trust.ts reaches for. */
interface TrustBridge {
  plugins: { trustList?: (force?: boolean) => Promise<TrustList> };
}

function stubBridge(bridge?: TrustBridge): void {
  vi.stubGlobal("window", { safelightNative: bridge });
}

beforeEach(() => {
  seed(trustList());
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("repoFromSpec", () => {
  it("normalises the shorthand forms to lowercase owner/repo", () => {
    expect(repoFromSpec("Acme/Tool")).toBe("acme/tool");
    expect(repoFromSpec("  acme/tool  ")).toBe("acme/tool");
    expect(repoFromSpec("acme/tool#next")).toBe("acme/tool");
  });

  it("normalises github.com URLs, including .git and /tree refs", () => {
    expect(repoFromSpec("https://github.com/Acme/Tool")).toBe("acme/tool");
    expect(repoFromSpec("http://github.com/acme/tool/")).toBe("acme/tool");
    expect(repoFromSpec("https://github.com/acme/tool.git")).toBe("acme/tool");
    expect(repoFromSpec("https://github.com/acme/tool/tree/main")).toBe("acme/tool");
    expect(repoFromSpec("HTTPS://GITHUB.COM/Acme/Tool")).toBe("acme/tool");
  });

  it("rejects hosts that only look like github.com", () => {
    // A parsed spec is what the install path ban-checks, so a lookalike host
    // must not resolve to the repo name it is impersonating.
    expect(repoFromSpec("https://github.com.evil.test/acme/tool")).toBeNull();
    expect(repoFromSpec("https://github.com@evil.test/acme/tool")).toBeNull();
    expect(repoFromSpec("https://evil.test/acme/tool")).toBeNull();
    expect(repoFromSpec("https://raw.githubusercontent.com/acme/tool")).toBeNull();
  });

  it("rejects specs that are not exactly one owner and one repo", () => {
    expect(repoFromSpec("")).toBeNull();
    expect(repoFromSpec("acme")).toBeNull();
    expect(repoFromSpec("acme/tool/extra")).toBeNull();
    expect(repoFromSpec("acme /tool")).toBeNull();
  });
});

describe("default-deny posture", () => {
  it("treats every repo as unverified and unbanned when the list is empty", () => {
    expect(isVerified("acme/tool")).toBe(false);
    expect(verificationStatus("acme/tool", "1.0.0")).toBe("unverified");
    expect(bannedReason("acme/tool")).toBeNull();
    expect(isBanned("acme/tool")).toBe(false);
  });

  it("never reports a missing repo as verified", () => {
    seed(trustList({ verified: ["acme/tool"] }));
    expect(isVerified(null)).toBe(false);
    expect(isVerified(undefined)).toBe(false);
    expect(isVerified("")).toBe(false);
    expect(isVerified("   ")).toBe(false);
    expect(verificationStatus(null)).toBe("unverified");
  });

  it("does not verify an extension merely because the registry reviewed it", () => {
    // `reviewed` records what a maintainer looked at; only `verified` grants it.
    seed(trustList({ reviewed: { "acme/tool": { version: "1.0.0" } } }));
    expect(isVerified("acme/tool")).toBe(false);
    expect(verificationStatus("acme/tool", "1.0.0")).toBe("unverified");
  });
});

describe("verified allowlist", () => {
  beforeEach(() => seed(trustList({ verified: ["acme/tool"] })));

  it("matches regardless of the caller's casing or padding", () => {
    expect(isVerified("acme/tool")).toBe(true);
    expect(isVerified("ACME/Tool")).toBe(true);
    expect(isVerified("\tacme/tool \n")).toBe(true);
  });

  it("requires the whole owner/repo, not a prefix or a sibling", () => {
    expect(isVerified("acme/tool2")).toBe(false);
    expect(isVerified("acme")).toBe(false);
    expect(isVerified("notacme/tool")).toBe(false);
    expect(isVerified("acme/tool/extra")).toBe(false);
  });

  it("matches a verified entry the registry failed to lowercase", () => {
    seed(
      trustList({
        verified: ["Acme/Tool"],
        reviewed: { "Acme/Tool": { version: "1.2.0" } },
      }),
    );
    expect(isVerified("acme/tool")).toBe(true);
    expect(reviewedFor("acme/tool")).toEqual({ version: "1.2.0" });
    expect(verificationStatus("acme/tool", "1.3.0")).toBe("stale");
  });

  it("does not accept a homoglyph owner as the verified one", () => {
    // Normalisation is ASCII case-folding only — Cyrillic а is a different
    // account, and must fall through to unverified rather than borrow the badge.
    expect(isVerified("аcme/tool")).toBe(false);
  });
});

describe("banned kill-switch", () => {
  const banned = trustList({
    repos: ["evil/tool"],
    owners: ["badactor"],
    reason: { "evil/tool": "ships a credential stealer", badactor: "account compromised" },
  });

  beforeEach(() => seed(banned));

  it("reports the recorded reason for a banned repo", () => {
    expect(bannedReason("evil/tool")).toBe("ships a credential stealer");
    expect(isBanned("evil/tool")).toBe(true);
  });

  it("bans every repo under a banned owner", () => {
    expect(bannedReason("badactor/anything")).toBe("account compromised");
    expect(bannedReason("badactor/other")).toBe("account compromised");
  });

  it("matches through casing and padding", () => {
    expect(isBanned("Evil/Tool")).toBe(true);
    expect(isBanned("  EVIL/tool ")).toBe(true);
    expect(isBanned("BadActor/Thing")).toBe(true);
  });

  it("does not spill onto neighbouring names", () => {
    expect(isBanned("evil/tool2")).toBe(false);
    expect(isBanned("notevil/tool")).toBe(false);
    expect(isBanned("badactor2/thing")).toBe(false);
  });

  it("falls back to a generic reason when the registry recorded none", () => {
    seed(trustList({ repos: ["evil/tool"] }));
    expect(bannedReason("evil/tool")).toBe("flagged as unsafe");
  });

  it("prefers the repo-specific reason over the owner-wide one", () => {
    seed(
      trustList({
        repos: ["badactor/tool"],
        owners: ["badactor"],
        reason: { "badactor/tool": "specific", badactor: "account-wide" },
      }),
    );
    expect(bannedReason("badactor/tool")).toBe("specific");
  });

  it("bans a repo that is also on the verified allowlist", () => {
    // A repo can be verified and later turn malicious. The ban must win, so
    // callers gate on bannedReason before ever consulting isVerified.
    seed(
      trustList({
        verified: ["evil/tool"],
        reviewed: { "evil/tool": { version: "1.0.0" } },
        repos: ["evil/tool"],
        reason: { "evil/tool": "revoked" },
      }),
    );
    expect(isBanned("evil/tool")).toBe(true);
    expect(bannedReason("evil/tool")).toBe("revoked");
    // isVerified is deliberately independent — it still answers "was reviewed",
    // which is why a caller that skipped the ban check would be fooled.
    expect(isVerified("evil/tool")).toBe(true);
  });

  it("bans a whole owner even when one of its repos is verified", () => {
    seed(
      trustList({
        verified: ["badactor/tool"],
        owners: ["badactor"],
        reason: { badactor: "account compromised" },
      }),
    );
    expect(isBanned("badactor/tool")).toBe(true);
  });

  it("matches a banned entry the registry failed to lowercase", () => {
    // The main process lowercases the lists, so this is depth: an entry that
    // slipped through uncased must still ban, however the caller spells it.
    seed(trustList({ repos: ["Evil/Tool"], reason: { "Evil/Tool": "malware" } }));
    expect(isBanned("evil/tool")).toBe(true);
    expect(isBanned("Evil/Tool")).toBe(true);
    expect(bannedReason("evil/tool")).toBe("malware");
  });

  it("matches an uncased banned owner", () => {
    seed(
      trustList({ owners: ["BadActor"], reason: { BadActor: "account compromised" } }),
    );
    expect(bannedReason("badactor/thing")).toBe("account compromised");
  });
});

describe("verificationStatus", () => {
  it("keeps an unpinned verified entry verified at any version", () => {
    seed(trustList({ verified: ["acme/tool"] }));
    expect(verificationStatus("acme/tool", "9.9.9")).toBe("verified");
    expect(reviewedFor("acme/tool")).toBeNull();
  });

  it("goes stale once the version in play is past the reviewed point", () => {
    seed(
      trustList({
        verified: ["acme/tool"],
        reviewed: { "acme/tool": { version: "1.2.0", commit: "abc123" } },
      }),
    );
    expect(verificationStatus("acme/tool", "1.3.0")).toBe("stale");
    expect(verificationStatus("acme/tool", "2.0.0")).toBe("stale");
    expect(verificationStatus("acme/tool", "1.2.0")).toBe("verified");
    expect(verificationStatus("acme/tool", "1.1.9")).toBe("verified");
    expect(reviewedFor("acme/tool")).toEqual({ version: "1.2.0", commit: "abc123" });
  });

  it("stays verified for a pinned entry when the version is unknown", () => {
    // The caller could not determine the version in play; the badge does not
    // downgrade on its own.
    seed(
      trustList({
        verified: ["acme/tool"],
        reviewed: { "acme/tool": { version: "1.2.0" } },
      }),
    );
    expect(verificationStatus("acme/tool")).toBe("verified");
    expect(verificationStatus("acme/tool", null)).toBe("verified");
  });

  it("is verified when only a commit was pinned", () => {
    seed(
      trustList({
        verified: ["acme/tool"],
        reviewed: { "acme/tool": { commit: "abc123" } },
      }),
    );
    expect(verificationStatus("acme/tool", "5.0.0")).toBe("verified");
  });
});

describe("bannedReasonForManifest", () => {
  it("resolves the ban through the manifest's declared repository", () => {
    seed(trustList({ repos: ["evil/tool"], reason: { "evil/tool": "malware" } }));
    expect(bannedReasonForManifest(manifest({ repository: "Evil/Tool" }))).toBe("malware");
  });

  it("resolves the ban through the remembered install source", () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({ sl_ext_sources: JSON.stringify({ "acme.tool": "evil/tool" }) }),
    );
    seed(trustList({ repos: ["evil/tool"], reason: { "evil/tool": "malware" } }));
    expect(bannedReasonForManifest(manifest())).toBe("malware");
  });

  it("returns null for an extension with no known origin", () => {
    seed(trustList({ repos: ["evil/tool"] }));
    expect(bannedReasonForManifest(manifest())).toBeNull();
  });

  it("does not let a self-declared repository shadow a banned install source", () => {
    // The manifest ships inside the extension, so `repository` is authored by
    // the code being judged: it must not launder the repo we installed from.
    vi.stubGlobal(
      "localStorage",
      memoryStorage({ sl_ext_sources: JSON.stringify({ "acme.tool": "evil/tool" }) }),
    );
    seed(trustList({ repos: ["evil/tool"], owners: ["evil"] }));
    expect(bannedReasonForManifest(manifest({ repository: "acme/innocent" }))).toBe(
      "flagged as unsafe",
    );
  });

  it("does not let a self-declared repository shadow a banned owner", () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({ sl_ext_sources: JSON.stringify({ "acme.tool": "evil/tool" }) }),
    );
    seed(trustList({ owners: ["evil"], reason: { evil: "account compromised" } }));
    expect(bannedReasonForManifest(manifest({ repository: "acme/innocent" }))).toBe(
      "account compromised",
    );
  });

  it("still bans a declared repository when the install source is clean", () => {
    // The declared field may add suspicion, never remove it.
    vi.stubGlobal(
      "localStorage",
      memoryStorage({ sl_ext_sources: JSON.stringify({ "acme.tool": "acme/tool" }) }),
    );
    seed(trustList({ repos: ["evil/tool"], reason: { "evil/tool": "malware" } }));
    expect(bannedReasonForManifest(manifest({ repository: "evil/tool" }))).toBe("malware");
  });

  it("falls back to the install source when the declared repository is malformed", () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({ sl_ext_sources: JSON.stringify({ "acme.tool": "evil/tool" }) }),
    );
    seed(trustList({ repos: ["evil/tool"], reason: { "evil/tool": "malware" } }));
    expect(bannedReasonForManifest(manifest({ repository: "not a repo" }))).toBe("malware");
  });
});

describe("flagged extensions", () => {
  const flag = { id: "acme.tool", name: "Acme Tool", reason: "malware" };
  const other = { id: "other.ext", name: "Other", reason: "banned owner" };

  it("records a skipped extension once, keeping insertion order", () => {
    flagBannedExtension(flag);
    flagBannedExtension({ ...flag, reason: "different reason, same id" });
    flagBannedExtension(other);
    expect(useTrust.getState().flagged).toEqual([flag, other]);
  });

  it("dismisses only the named extension", () => {
    flagBannedExtension(flag);
    flagBannedExtension(other);
    dismissFlag("acme.tool");
    expect(useTrust.getState().flagged).toEqual([other]);
  });

  it("ignores a dismissal for an id that was never flagged", () => {
    flagBannedExtension(flag);
    dismissFlag("nobody");
    expect(useTrust.getState().flagged).toEqual([flag]);
  });
});

describe("loadTrustList", () => {
  it("is a no-op without the native bridge, leaving everything unverified", async () => {
    stubBridge({ plugins: {} });
    await expect(loadTrustList()).resolves.toBeUndefined();
    expect(useTrust.getState().loadedAt).toBe(0);
    expect(isVerified("acme/tool")).toBe(false);
  });

  it("caches the fetched list and mirrors it to localStorage", async () => {
    const store = memoryStorage();
    vi.stubGlobal("localStorage", store);
    const list = trustList({ verified: ["acme/tool"], repos: ["evil/tool"] });
    stubBridge({ plugins: { trustList: () => Promise.resolve(list) } });

    await loadTrustList();

    expect(isVerified("acme/tool")).toBe(true);
    expect(isBanned("evil/tool")).toBe(true);
    expect(useTrust.getState().loadedAt).toBeGreaterThan(0);
    expect(JSON.parse(store.getItem("sl_trust_cache") ?? "null")).toEqual(list);
  });

  it("skips a second fetch once loaded, unless forced", async () => {
    const fetchList = vi.fn(() => Promise.resolve(trustList()));
    stubBridge({ plugins: { trustList: fetchList } });

    await loadTrustList();
    await loadTrustList();
    expect(fetchList).toHaveBeenCalledTimes(1);

    await loadTrustList(true);
    expect(fetchList).toHaveBeenCalledTimes(2);
    expect(fetchList).toHaveBeenLastCalledWith(true);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    let settle!: (l: TrustList) => void;
    const fetchList = vi.fn(
      () =>
        new Promise<TrustList>((resolve) => {
          settle = resolve;
        }),
    );
    stubBridge({ plugins: { trustList: fetchList } });

    const first = loadTrustList();
    const second = loadTrustList();
    expect(fetchList).toHaveBeenCalledTimes(1);

    settle(trustList({ repos: ["evil/tool"] }));
    await Promise.all([first, second]);
    expect(isBanned("evil/tool")).toBe(true);
  });

  it("keeps the cached bans when the registry fetch fails", async () => {
    seed(trustList({ repos: ["evil/tool"], reason: { "evil/tool": "malware" } }));
    stubBridge({ plugins: { trustList: () => Promise.reject(new Error("offline")) } });

    await expect(loadTrustList()).resolves.toBeUndefined();

    expect(bannedReason("evil/tool")).toBe("malware");
    // Not marked loaded, so the next launch retries rather than trusting a
    // list that never arrived.
    expect(useTrust.getState().loadedAt).toBe(0);
  });

  it("retries after a failure instead of reusing the dead in-flight promise", async () => {
    const fetchList = vi
      .fn<() => Promise<TrustList>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(trustList({ repos: ["evil/tool"] }));
    stubBridge({ plugins: { trustList: fetchList } });

    await loadTrustList();
    await loadTrustList();

    expect(fetchList).toHaveBeenCalledTimes(2);
    expect(isBanned("evil/tool")).toBe(true);
  });
});

describe("synchronous boot seed from the localStorage mirror", () => {
  // The boot ban-check runs before any fetch resolves, so it depends entirely on
  // the mirror written by the previous launch. Re-import the module per case to
  // exercise the module-init read.
  async function bootWith(cached: string | null) {
    vi.resetModules();
    vi.stubGlobal(
      "localStorage",
      memoryStorage(cached === null ? {} : { sl_trust_cache: cached }),
    );
    return import("./trust.ts");
  }

  it("enforces cached bans with no bridge and no fetch", async () => {
    const cached = trustList({
      verified: ["acme/tool"],
      repos: ["evil/tool"],
      reason: { "evil/tool": "malware" },
    });
    const mod = await bootWith(JSON.stringify(cached));
    expect(mod.isBanned("evil/tool")).toBe(true);
    expect(mod.bannedReason("evil/tool")).toBe("malware");
    expect(mod.isVerified("acme/tool")).toBe(true);
  });

  it("verifies nothing when the mirror is absent or unreadable", async () => {
    for (const cached of [null, "{ not json", "null", '"a string"', "[]"]) {
      const mod = await bootWith(cached);
      expect(mod.isVerified("acme/tool")).toBe(false);
      expect(mod.isBanned("evil/tool")).toBe(false);
    }
  });

  it("drops malformed sub-lists rather than inheriting their shape", async () => {
    const mod = await bootWith(
      JSON.stringify({ verified: ["acme/tool"], repos: "evil/tool", owners: null, reviewed: 7 }),
    );
    expect(mod.isVerified("acme/tool")).toBe(true);
    expect(mod.isBanned("evil/tool")).toBe(false);
    expect(mod.reviewedFor("acme/tool")).toBeNull();
  });
});
