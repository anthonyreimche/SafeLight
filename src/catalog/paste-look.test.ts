// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { defaultCopy, pasteLook } from "./paste-look";
import { CURRENT_PROCESS_VERSION, DEFAULT_DEVELOP_PARAMS, LEGACY_PROCESS_VERSION, freshParams } from "./types";

const base = { params: freshParams(5200), paramBag: { "a.keep": 1, "a.over": 2 } };

describe("pasteLook", () => {
  it("merges the pasted subset over the current look", () => {
    const next = pasteLook(base, { params: { exposure: 1.5 }, paramBag: { "a.over": 3 } });
    expect(next.params.exposure).toBe(1.5);
    expect(next.params.temperature).toBe(base.params.temperature);
    expect(next.paramBag).toEqual({ "a.keep": 1, "a.over": 3 });
  });

  it("never moves the photo between process versions", () => {
    const legacy = { params: { ...base.params, processVersion: LEGACY_PROCESS_VERSION }, paramBag: {} };
    const next = pasteLook(legacy, { params: { exposure: 1, processVersion: CURRENT_PROCESS_VERSION }, paramBag: {} });
    expect(next.params.processVersion).toBe(LEGACY_PROCESS_VERSION);
  });
});

describe("defaultCopy", () => {
  it("takes changed adjustments, leaves out per-photo ones and keeps the whole bag", () => {
    const look = {
      params: { ...base.params, temperature: DEFAULT_DEVELOP_PARAMS.temperature, exposure: 0.7, straighten: 2 },
      paramBag: { "a.keep": 1 },
    };
    const copied = defaultCopy(look);
    expect(copied.params).toEqual({ exposure: 0.7 });
    expect(copied.paramBag).toEqual({ "a.keep": 1 });
  });
});
