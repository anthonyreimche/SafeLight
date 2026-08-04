// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Pins the param-bag persist/reload contract — the seam between a photo's saved
// extension params and the live stage descriptors. normalizeParamBag() runs on
// every load/commit, so any drift here silently corrupts saved edits. The
// trickiest guarantee is the enabled-vs-disabled divergence: a disabled
// extension's params must survive untouched, while a loaded extension re-checks
// them against its declared types. Run with `npm test`.

import { afterEach, describe, expect, it } from "vitest";
import {
  getParamDescriptor,
  normalizeParamBag,
  registerStageParams,
  unregisterExtensionParams,
  unregisterStageParams,
} from "./param-registry.ts";
import type { UniformDeclaration } from "./types.ts";

const EXT = "test.ext";
const STAGE = "Test Stage";
const UNIFORMS: UniformDeclaration[] = [
  { key: "amount", glslType: "float", default: 0 },
  { key: "enabled", glslType: "bool", default: false },
  { key: "tint", glslType: "vec3", default: [0, 0, 0] },
];

// The descriptor registry is a module-level singleton, so every test that
// registers must clean up or it leaks into the next.
afterEach(() => unregisterExtensionParams(EXT));

describe("normalizeParamBag — empty / non-object input", () => {
  it("returns an empty bag for undefined, null, or non-object", () => {
    expect(normalizeParamBag(undefined)).toEqual({});
    expect(normalizeParamBag(null as unknown as Record<string, unknown>)).toEqual({});
    expect(normalizeParamBag(7 as unknown as Record<string, unknown>)).toEqual({});
  });
});

describe("normalizeParamBag — unknown keys (extension absent)", () => {
  it("preserves keys with no descriptor untouched, whatever the value type", () => {
    // No stage registered, so every key is 'unknown'. A disabled extension's
    // saved params land here and must round-trip exactly.
    const bag = {
      "ghost.stage.x": 0.5,
      "ghost.stage.flag": true,
      "ghost.stage.vec": [1, 2, 3],
      "ghost.stage.weird": "a string we can't validate",
    };
    expect(normalizeParamBag(bag)).toEqual(bag);
  });
});

describe("normalizeParamBag — registered keys", () => {
  it("keeps values whose type matches the declared GLSL type", () => {
    registerStageParams("test.stage", STAGE, EXT, UNIFORMS);
    const bag = {
      "test.stage.amount": 0.7,
      "test.stage.enabled": true,
      "test.stage.tint": [1, 2, 3],
    };
    expect(normalizeParamBag(bag)).toEqual(bag);
  });

  it("drops values whose type is wrong, so bind falls back to the uniform default", () => {
    registerStageParams("test.stage", STAGE, EXT, UNIFORMS);
    const bag = {
      "test.stage.amount": "nope", // float expects a number
      "test.stage.enabled": 1, // bool expects a boolean
      "test.stage.tint": 0.5, // vec3 expects an array
    };
    expect(normalizeParamBag(bag)).toEqual({});
  });

  it("keeps valid keys, drops invalid ones, preserves unknown ones in a mixed bag", () => {
    registerStageParams("test.stage", STAGE, EXT, UNIFORMS);
    const bag = {
      "test.stage.amount": 0.7, // valid → kept
      "test.stage.enabled": "yes", // invalid → dropped
      "other.ext.legacy": 42, // unknown → preserved
    };
    expect(normalizeParamBag(bag)).toEqual({
      "test.stage.amount": 0.7,
      "other.ext.legacy": 42,
    });
  });

  it("is idempotent — re-normalizing a normalized bag does not drift", () => {
    registerStageParams("test.stage", STAGE, EXT, UNIFORMS);
    // The core round-trip: persist → reload → persist must be a fixed point,
    // or repeated saves would slowly mutate a stable edit.
    const bag = {
      "test.stage.amount": 0.7,
      "test.stage.tint": [1, 2, 3],
      "external.legacy": "x",
    };
    const once = normalizeParamBag(bag);
    expect(normalizeParamBag(once)).toEqual(once);
  });
});

describe("normalizeParamBag — enabled vs disabled divergence", () => {
  // The same out-of-type value is handled two opposite ways depending on whether
  // the owning extension is loaded. This is intentional (you can't re-validate a
  // param whose descriptor isn't present), but it's the subtle seam that makes
  // 'disable → re-enable' able to resurrect stale params. Pin both sides so a
  // refactor can't quietly collapse them into one behavior.
  it("drops an out-of-type value while the stage is registered", () => {
    registerStageParams("test.stage", STAGE, EXT, UNIFORMS);
    expect(normalizeParamBag({ "test.stage.amount": "bad" })).toEqual({});
  });

  it("preserves the same value once the stage is unregistered (extension disabled)", () => {
    // No registration this turn — the descriptor is gone, so the value is opaque
    // and must be preserved rather than destroyed.
    expect(normalizeParamBag({ "test.stage.amount": "bad" })).toEqual({
      "test.stage.amount": "bad",
    });
  });
});

describe("stage param registration lifecycle", () => {
  it("registers each uniform under its '{stageId}.{key}' qualified key", () => {
    registerStageParams("test.stage", STAGE, EXT, [
      { key: "amount", glslType: "float", default: 0.25, range: { min: 0, max: 1 } },
    ]);
    const d = getParamDescriptor("test.stage.amount");
    expect(d?.localKey).toBe("amount");
    expect(d?.stageId).toBe("test.stage");
    expect(d?.extensionId).toBe(EXT);
    expect(d?.default).toBe(0.25);
  });

  it("unregisterStageParams removes only that stage's descriptors", () => {
    registerStageParams("test.stage", STAGE, EXT, [{ key: "a", glslType: "float", default: 0 }]);
    registerStageParams("other.stage", STAGE, EXT, [{ key: "b", glslType: "float", default: 0 }]);
    unregisterStageParams("test.stage");
    expect(getParamDescriptor("test.stage.a")).toBeUndefined();
    expect(getParamDescriptor("other.stage.b")).toBeDefined();
  });

  it("unregisterExtensionParams removes every descriptor for the extension", () => {
    registerStageParams("s1", STAGE, EXT, [{ key: "a", glslType: "float", default: 0 }]);
    registerStageParams("s2", STAGE, EXT, [{ key: "b", glslType: "bool", default: false }]);
    unregisterExtensionParams(EXT);
    expect(getParamDescriptor("s1.a")).toBeUndefined();
    expect(getParamDescriptor("s2.b")).toBeUndefined();
  });
});
