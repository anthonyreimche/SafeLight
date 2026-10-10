// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The checks every extension install makes, shared by the Extensions store and
// the welcome setup: the one-time third-party acknowledgement, and whether a
// pinned verified repo has moved past the version a maintainer reviewed.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  checkReview,
  EXTENSION_RISK_NOTICE,
  hasAckedExtensionRisk,
  RISK_ACK_KEY,
  setAckedExtensionRisk,
} from "./install-gate";
import { useTrust } from "./trust";
import type { TrustList } from "./types";

const REPO = "acme/widget";
const trust = (patch: Partial<TrustList> = {}): TrustList => ({
  verified: [],
  reviewed: {},
  repos: [],
  owners: [],
  reason: {},
  ...patch,
});

let remoteManifest: Mock;

beforeEach(() => {
  localStorage.clear();
  remoteManifest = vi.fn(async () => ({ version: "1.0.0" }));
  vi.stubGlobal("safelightNative", { plugins: { remoteManifest } });
  useTrust.setState({ list: trust() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extension risk acknowledgement", () => {
  it("is unset on a fresh profile and remembered once given", () => {
    expect(hasAckedExtensionRisk()).toBe(false);
    setAckedExtensionRisk();
    expect(hasAckedExtensionRisk()).toBe(true);
    expect(localStorage.getItem(RISK_ACK_KEY)).toBe("1");
  });

  it("keeps the store's key, so earlier acknowledgements still count", () => {
    expect(RISK_ACK_KEY).toBe("sl_ext_risk_ack_v1");
    localStorage.setItem("sl_ext_risk_ack_v1", "1");
    expect(hasAckedExtensionRisk()).toBe(true);
  });

  it("says extensions are third-party code with full access", () => {
    expect(EXTENSION_RISK_NOTICE).toMatch(/third-party software/);
    expect(EXTENSION_RISK_NOTICE).toMatch(/full access/);
    expect(EXTENSION_RISK_NOTICE).toMatch(/at your own risk/);
  });
});

describe("checkReview", () => {
  it("treats a missing repo as unverified without a lookup", async () => {
    expect(await checkReview(null)).toEqual({
      verified: false,
      reviewedVersion: null,
      stale: false,
      confirmed: true,
    });
    expect(remoteManifest).not.toHaveBeenCalled();
  });

  it("reports an unverified repo without a lookup", async () => {
    expect(await checkReview(REPO)).toEqual({
      verified: false,
      reviewedVersion: null,
      stale: false,
      confirmed: true,
    });
    expect(remoteManifest).not.toHaveBeenCalled();
  });

  it("trusts an unpinned verified repo without a lookup", async () => {
    useTrust.setState({ list: trust({ verified: [REPO] }) });
    expect(await checkReview(REPO)).toEqual({
      verified: true,
      reviewedVersion: null,
      stale: false,
      confirmed: true,
    });
    expect(remoteManifest).not.toHaveBeenCalled();
  });

  it("flags a pinned repo whose current version is past the review", async () => {
    useTrust.setState({
      list: trust({ verified: [REPO], reviewed: { [REPO]: { version: "1.0.0" } } }),
    });
    remoteManifest.mockResolvedValue({ version: "1.1.0" });
    expect(await checkReview(REPO)).toEqual({
      verified: true,
      reviewedVersion: "1.0.0",
      stale: true,
      confirmed: true,
    });
    expect(remoteManifest).toHaveBeenCalledWith(REPO);
  });

  it("passes a pinned repo still at its reviewed version", async () => {
    useTrust.setState({
      list: trust({ verified: [REPO], reviewed: { [REPO]: { version: "1.0.0" } } }),
    });
    expect(await checkReview(REPO)).toEqual({
      verified: true,
      reviewedVersion: "1.0.0",
      stale: false,
      confirmed: true,
    });
  });

  it("can't confirm a pinned repo when the version lookup fails", async () => {
    useTrust.setState({
      list: trust({ verified: [REPO], reviewed: { [REPO]: { version: "1.0.0" } } }),
    });
    remoteManifest.mockRejectedValue(new Error("rate limited"));
    expect(await checkReview(REPO)).toMatchObject({ stale: false, confirmed: false });
  });

  it("can't confirm a pinned repo whose lookup returns no version", async () => {
    useTrust.setState({
      list: trust({ verified: [REPO], reviewed: { [REPO]: { version: "1.0.0" } } }),
    });
    remoteManifest.mockResolvedValue(null);
    expect(await checkReview(REPO)).toMatchObject({ stale: false, confirmed: false });
  });
});

describe("checkReview with a chosen version", () => {
  beforeEach(() => {
    useTrust.setState({
      list: trust({ verified: [REPO], reviewed: { [REPO]: { version: "1.1.0" } } }),
    });
  });

  it("judges a chosen version newer than the review as unreviewed, without a lookup", async () => {
    expect(await checkReview(REPO, "1.2.0")).toEqual({
      verified: true,
      reviewedVersion: "1.1.0",
      stale: true,
      confirmed: true,
    });
    expect(remoteManifest).not.toHaveBeenCalled();
  });

  it("counts the reviewed version, or an older one, as reviewed", async () => {
    expect((await checkReview(REPO, "1.1.0")).stale).toBe(false);
    expect((await checkReview(REPO, "1.0.0")).stale).toBe(false);
    expect(remoteManifest).not.toHaveBeenCalled();
  });
});
