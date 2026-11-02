// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The key diagnostic runs only for a profile that has Developer Tools
// (safelight.devtools) installed and on, read from storage before anything
// loads.

import { beforeEach, describe, expect, it } from "vitest";
import { keyDiagActive } from "./key-diag";

const put = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));

beforeEach(() => localStorage.clear());

describe("keyDiagActive", () => {
  it("is on while Developer Tools is installed and on", () => {
    put("sl_ext_kinds", { "safelight.devtools": "interface" });
    put("sl_ext_disabled", []);
    expect(keyDiagActive()).toBe(true);
  });

  it("is off while Developer Tools is turned off", () => {
    put("sl_ext_kinds", { "safelight.devtools": "interface" });
    put("sl_ext_disabled", ["safelight.devtools"]);
    expect(keyDiagActive()).toBe(false);
  });

  it("is off when Developer Tools was never installed", () => {
    put("sl_ext_kinds", { "acme.widget": "interface" });
    expect(keyDiagActive()).toBe(false);
  });

  it("no longer follows the built-in it replaced", () => {
    put("sl_ext_default_seeded", ["core.devtools"]);
    put("sl_ext_kinds", { "core.devtools": "interface" });
    put("sl_ext_disabled", []);
    expect(keyDiagActive()).toBe(false);
  });

  it("is off when the stored lists are unreadable", () => {
    localStorage.setItem("sl_ext_kinds", "{");
    expect(keyDiagActive()).toBe(false);
  });
});
