// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Kept versions persist per profile and follow other windows.

import { beforeEach, describe, expect, it } from "vitest";
import { initPinSync, keptVersion, setKept, usePins } from "./pins";

beforeEach(() => {
  localStorage.clear();
  usePins.setState({ pins: {} });
});

describe("kept versions", () => {
  it("persists and clears", () => {
    setKept("acme.widget", "1.2.0");
    expect(keptVersion("acme.widget")).toBe("1.2.0");
    expect(JSON.parse(localStorage.getItem("sl_ext_pins")!)).toEqual({ "acme.widget": "1.2.0" });
    setKept("acme.widget", null);
    expect(keptVersion("acme.widget")).toBeNull();
    expect(JSON.parse(localStorage.getItem("sl_ext_pins")!)).toEqual({});
  });

  it("follows changes made in another window", () => {
    initPinSync();
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "sl_ext_pins",
        newValue: JSON.stringify({ "acme.widget": "1.1.0" }),
      }),
    );
    expect(keptVersion("acme.widget")).toBe("1.1.0");
    window.dispatchEvent(new StorageEvent("storage", { key: "sl_ext_pins", newValue: null }));
    expect(keptVersion("acme.widget")).toBeNull();
  });
});
