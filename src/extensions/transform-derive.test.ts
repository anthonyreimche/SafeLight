// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Derived uniforms reach a renderer inside the bag it draws with, computed
// from the transform's params on the main thread, and nowhere else.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPipeline, unregisterExtension, useRegistry } from "./registry";
import { resolvePipelineFor } from "./pipelines";
import { bagForRender, derivedEntries, transformValues } from "./transform-derive";
import type { PipelineContribution, TransformDerive, UniformValue } from "./types";

const fn = vi.fn((v: Readonly<Record<string, UniformValue>>) => ({
  twice: 2 * (v.gain as number),
  on: v.enabled as boolean,
}));

const DERIVED: PipelineContribution = {
  id: "test.d",
  name: "Derived",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return on ? twice * lin : lin; }",
  params: [
    { key: "gain", glslType: "float", default: 1 },
    { key: "enabled", glslType: "bool", default: true },
  ],
  derive: {
    uniforms: [
      { key: "twice", glslType: "float", default: 2 },
      { key: "on", glslType: "bool", default: true },
    ],
    fn,
  },
};

beforeEach(() => {
  fn.mockClear();
  useRegistry.setState({ pipelines: {} });
  registerPipeline("test", DERIVED);
});

afterEach(() => {
  vi.restoreAllMocks();
  unregisterExtension("test");
});

const pipeline = () => resolvePipelineFor(DERIVED.id);
const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

describe("transformValues", () => {
  it("takes the bag's value when it fits, else the default", () => {
    expect(transformValues(pipeline(), { "test.d.gain": 3, "test.d.enabled": "yes" })).toEqual({
      gain: 3,
      enabled: true,
    });
  });
});

describe("derivedEntries", () => {
  it("computes each derived uniform under its own key", () => {
    expect(derivedEntries(pipeline(), { "test.d.gain": 3 })).toEqual({ "test.d#twice": 6, "test.d#on": true });
  });

  it("runs derive once for the same values", () => {
    derivedEntries(pipeline(), { "test.d.gain": 3 });
    derivedEntries(pipeline(), { "test.d.gain": 3, "other.stage.x": 1 });
    expect(fn).toHaveBeenCalledTimes(1);
    derivedEntries(pipeline(), { "test.d.gain": 4 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("runs a re-registered derive even for the same values", () => {
    derivedEntries(pipeline(), { "test.d.gain": 3 });
    const other = vi.fn(() => ({ twice: 1, on: false }));
    registerPipeline("test", { ...DERIVED, derive: { ...DERIVED.derive!, fn: other } });
    expect(derivedEntries(pipeline(), { "test.d.gain": 3 })).toEqual({ "test.d#twice": 1, "test.d#on": false });
  });

  // The bridge diffs the bags it posts by reference, so a memoised array that
  // derive.fn mutates on its next call would never be posted again.
  it("keeps the arrays it hands out apart from the ones derive.fn returns", () => {
    const scale = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    registerPipeline("test", {
      ...DERIVED,
      derive: {
        uniforms: [{ key: "scale", glslType: "mat3", default: [1, 0, 0, 0, 1, 0, 0, 0, 1] }],
        fn: (v) => {
          scale[0] = v.gain as number;
          return { scale };
        },
      },
    });
    const first = derivedEntries(pipeline(), { "test.d.gain": 3 });
    const second = derivedEntries(pipeline(), { "test.d.gain": 4 });
    expect(first["test.d#scale"]).toEqual([3, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(second["test.d#scale"]).toEqual([4, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(second["test.d#scale"]).not.toBe(first["test.d#scale"]);
  });

  it("binds a default for a result that's missing or doesn't fit, with one warning", () => {
    const warn = quiet();
    registerPipeline("test", {
      ...DERIVED,
      derive: { ...DERIVED.derive!, fn: () => ({ twice: Number.NaN }) },
    });
    expect(derivedEntries(pipeline(), { "test.d.gain": 3 })).toEqual({ "test.d#twice": 2, "test.d#on": true });
    derivedEntries(pipeline(), { "test.d.gain": 5 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("binds every default when derive throws, with one warning per registration", () => {
    const warn = quiet();
    registerPipeline("test", {
      ...DERIVED,
      derive: {
        ...DERIVED.derive!,
        fn: () => {
          throw new Error("boom");
        },
      },
    });
    expect(derivedEntries(pipeline(), { "test.d.gain": 3 })).toEqual({ "test.d#twice": 2, "test.d#on": true });
    derivedEntries(pipeline(), { "test.d.gain": 4 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/test\.d.*boom/);
  });

  it("warns again once the same contribution is registered again", () => {
    const warn = quiet();
    const failing: PipelineContribution = {
      ...DERIVED,
      derive: { ...DERIVED.derive!, fn: () => ({ twice: Number.NaN }) },
    };
    registerPipeline("test", failing);
    derivedEntries(pipeline(), { "test.d.gain": 3 });
    registerPipeline("test", failing);
    derivedEntries(pipeline(), { "test.d.gain": 3 });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("binds every default when reading derive's result throws", () => {
    const warn = quiet();
    registerPipeline("test", {
      ...DERIVED,
      derive: {
        ...DERIVED.derive!,
        fn: () => ({
          on: false,
          get twice(): number {
            throw new Error("getter");
          },
        }),
      },
    });
    expect(derivedEntries(pipeline(), { "test.d.gain": 3 })).toEqual({ "test.d#twice": 2, "test.d#on": true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/test\.d.*getter/);
  });

  // Extensions are untyped JavaScript: a derive.fn can return anything.
  const returning =
    (value: unknown): TransformDerive["fn"] =>
    () =>
      value as Record<string, UniformValue>;

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 4],
  ])("binds every default when derive returns %s, with one warning", (_name, value) => {
    const warn = quiet();
    registerPipeline("test", {
      ...DERIVED,
      derive: { ...DERIVED.derive!, fn: returning(value) },
    });
    expect(derivedEntries(pipeline(), { "test.d.gain": 3 })).toEqual({ "test.d#twice": 2, "test.d#on": true });
    expect(derivedEntries(pipeline(), { "test.d.gain": 4 })).toEqual({ "test.d#twice": 2, "test.d#on": true });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("is empty for a transform without derive", () => {
    registerPipeline("test", { id: "test.plain", name: "Plain", glsl: "vec3 pipelineToDisplay(vec3 lin) { return lin; }" });
    expect(derivedEntries(resolvePipelineFor("test.plain"), { "test.d.gain": 3 })).toEqual({});
  });
});

describe("bagForRender", () => {
  it("adds the derived uniforms to the bag", () => {
    const bag = { "test.d.gain": 3, "stage.x": 1 };
    expect(bagForRender(pipeline(), bag)).toEqual({ ...bag, "test.d#twice": 6, "test.d#on": true });
  });

  it("hands back the very bag when nothing is derived", () => {
    registerPipeline("test", { id: "test.plain", name: "Plain", glsl: "vec3 pipelineToDisplay(vec3 lin) { return lin; }" });
    const bag = { "stage.x": 1 };
    expect(bagForRender(resolvePipelineFor("test.plain"), bag)).toBe(bag);
  });
});

// Every direct `.setContributedParams(` caller must hand over a bag built with
// bagForRender; the worker's bags are the ones the bridge built with it. The
// bridge's own message paths (capture, captureFloat, renderThumbnail*) add the
// derived uniforms inside the bridge, covered by its tests. A new direct caller
// fails here until it's checked and added.
describe("render entry points", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/test-support/.test(name) ? [path] : [];
    });

  it("are the known ones", () => {
    const callers = files(SRC)
      .filter((path) => /\.setContributedParams\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path).replaceAll("\\", "/"))
      .sort();
    expect(callers).toEqual([
      "hooks/use-develop-renderer.ts",
      "modules/export/export-image.ts",
      "rendering/render-worker.ts",
    ]);
  });
});
