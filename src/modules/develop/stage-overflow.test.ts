// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { setExtensionName } from "@/extensions/param-registry";
import type { RegisteredProcessingStage } from "@/extensions/registry";
import { overflowNotice } from "./stage-overflow";

const stage = (id: string, extensionId: string): RegisteredProcessingStage => ({
  id,
  name: id,
  phase: "scene-linear",
  glsl: "",
  uniforms: [],
  extensionId,
});

const STAGES = { "acme.gain": stage("acme.gain", "acme"), "acme.blur": stage("acme.blur", "acme") };
setExtensionName("acme", "Acme Tools");

describe("overflowNotice", () => {
  it("says nothing when every stage ran", () => {
    expect(overflowNotice([], STAGES)).toBeNull();
  });

  it("names each owning extension once", () => {
    expect(overflowNotice(["acme.gain", "acme.blur"], STAGES)).toBe(
      "Can't apply Acme Tools. Too many effects are on for this graphics card.",
    );
  });

  it("names a mask copy's extension, not the copy's id", () => {
    expect(overflowNotice(["acme.gain@0", "acme.gain@3"], STAGES)).toBe(
      "Can't apply Acme Tools. Too many effects are on for this graphics card.",
    );
  });
});
