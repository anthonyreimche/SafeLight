// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Finding the stages a develop program fails to build with, by building it with
// fewer of them. Every build is a whole develop compile, so the count matters as
// much as the answer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import { BUILTIN_RESOLVED } from "./builtin-pipeline";
import { PASS_PRELUDE } from "./export-draw";
import { ProgramCache, buildOutcome, createProgram, isolateFailingStages } from "./program-cache";
import { FRAGMENT_SHADER, V2_VARIANT, VERTEX_SHADER } from "./shaders";
import { buildStageInjection, PASS_VERTEX_SHADER } from "./stage-injection";

const STAGES = ["a", "b", "c", "d", "e", "f", "g", "h"];

/** A build that fails with a log naming each broken stage it is handed. */
function breaksWith(broken: readonly string[]) {
  const subsets: string[][] = [];
  const build = (subset: readonly string[]): string | null => {
    subsets.push([...subset]);
    const bad = subset.filter((s) => broken.includes(s));
    return bad.length > 0 ? `'${bad[0]}' : undeclared identifier` : null;
  };
  return { build, subsets };
}

describe("isolateFailingStages", () => {
  it("names the one stage whose GLSL doesn't compile, with its log", () => {
    const { build, subsets } = breaksWith(["e"]);
    const failing = isolateFailingStages(STAGES, "the whole set failed", build);
    expect(failing).toEqual([{ stage: "e", log: "'e' : undeclared identifier" }]);
    // The stock build, a bisection of eight, and the set without it.
    expect(subsets.length).toBeLessThanOrEqual(5);
  });

  it("names each of several broken stages", () => {
    const { build } = breaksWith(["b", "g"]);
    const failing = isolateFailingStages(STAGES, "the whole set failed", build);
    expect(failing.map((f) => f.stage)).toEqual(["b", "g"]);
  });

  it("blames the stage that carries the set past a limit", () => {
    const build = (subset: readonly string[]) => (subset.length > 6 ? "too many uniforms" : null);
    const failing = isolateFailingStages(STAGES, "too many uniforms", build);
    expect(failing.map((f) => f.stage)).toEqual(["g", "h"]);
    expect(failing[0].log).toBe("too many uniforms");
  });

  it("blames none when the program fails without any of them", () => {
    const { build, subsets } = breaksWith([]);
    const fails = (subset: readonly string[]) => build(subset) ?? "the base shader failed";
    expect(isolateFailingStages(STAGES, "the base shader failed", fails)).toEqual([]);
    expect(subsets).toEqual([[]]);
  });

  // A lost context fails every build after it, whatever it holds: nothing found
  // then is to blame.
  it("blames none once the builds can no longer be trusted", () => {
    const { build, subsets } = breaksWith(["e"]);
    let lost = false;
    const losing = (subset: readonly string[]) => {
      const result = build(subset);
      lost = true;
      return result;
    };
    expect(isolateFailingStages(STAGES, "the whole set failed", losing, undefined, () => lost)).toEqual([]);
    expect(subsets).toEqual([[]]);
  });

  it("stops at its build limit, keeping what it found", () => {
    const { build, subsets } = breaksWith(["a", "b", "c", "d"]);
    const failing = isolateFailingStages(STAGES, "the whole set failed", build, 6);
    expect(subsets.length).toBe(6);
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.length).toBeLessThan(4);
  });
});

const COMPLETION_STATUS_KHR = 0x91b1;

/** A context whose shaders always build, holding each one's type and source.
 *  `link` runs as the driver links. Given `busyPolls`, it has
 *  KHR_parallel_shader_compile and reports each program unfinished that many
 *  times before it is done. `statusReads` lists each COMPILE_STATUS and
 *  LINK_STATUS read, which waits for the driver. */
function fakeGl(link: () => void = () => {}, busyPolls?: number) {
  const sources = new Map<object, string>();
  const types = new Map<object, number>();
  const statusReads: string[] = [];
  const polls = new Map<object, number>();
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    getExtension: (name: string) =>
      busyPolls !== undefined && name === "KHR_parallel_shader_compile" ? { COMPLETION_STATUS_KHR } : null,
    isContextLost: () => false,
    createShader: (type: number) => {
      const shader = {};
      types.set(shader, type);
      return shader;
    },
    shaderSource: (shader: object, src: string) => sources.set(shader, src),
    compileShader: () => {},
    getShaderParameter: (_shader: object, pname: number) => {
      if (pname === gl.COMPILE_STATUS) statusReads.push("COMPILE_STATUS");
      return true;
    },
    createProgram: () => ({}),
    attachShader: () => {},
    bindAttribLocation: () => {},
    linkProgram: link,
    deleteShader: () => {},
    deleteProgram: () => {},
    getProgramParameter: (program: object, pname: number) => {
      if (pname === COMPLETION_STATUS_KHR) {
        const n = (polls.get(program) ?? 0) + 1;
        polls.set(program, n);
        return n > (busyPolls ?? 0);
      }
      if (pname === gl.LINK_STATUS) statusReads.push("LINK_STATUS");
      return true;
    },
    getUniformLocation: () => null,
  } as unknown as WebGL2RenderingContext;
  return { gl, sources, types, statusReads };
}

/** The fragment source createProgram hands the driver for `fsSrc`. */
function compiledFragment(vsSrc: string, fsSrc: string): string {
  const { gl, sources, types } = fakeGl();
  createProgram(gl, vsSrc, fsSrc);
  const fragment = [...sources].find(([shader]) => types.get(shader) === gl.FRAGMENT_SHADER);
  if (!fragment) throw new Error("no fragment shader compiled");
  return fragment[1];
}

const count = (text: string, part: string) => text.split(part).length - 1;

const BLURRED: ProcessingStageContribution = {
  id: "acme.blur",
  name: "Blur",
  phase: "scene-linear",
  glsl: "lin = mix(lin, stageResult, amount);",
  uniforms: [{ key: "amount", glslType: "float", default: 1 }],
  passes: [{ glsl: "c = readPrev(vUv);" }],
};

// A sampler2D is lowp unless declared otherwise, and drivers that lower lowp to
// fp16 clip HDR values read through it.
describe("createProgram's fragment precision", () => {
  it("declares highp sampler2D for the develop program, right after #version", () => {
    const src = compiledFragment(VERTEX_SHADER, FRAGMENT_SHADER);
    expect(count(src, "precision highp sampler2D;")).toBe(1);
    expect(src.split("\n").slice(0, 2)).toEqual(["#version 300 es", "precision highp sampler2D;"]);
    expect(src.replace("precision highp sampler2D;\n", "")).toBe(FRAGMENT_SHADER);
  });

  it("declares it for a stage's pass program", () => {
    const pass = buildStageInjection([BLURRED], V2_VARIANT).prepass[0].passes[0].fragmentSource;
    expect(count(compiledFragment(PASS_VERTEX_SHADER, pass), "precision highp sampler2D;")).toBe(1);
  });

  it("leaves a source that declares its sampler precision as it is", () => {
    const src = `${PASS_PRELUDE}uniform sampler2D uSrc;\nvoid main() { fragColor = texture(uSrc, vec2(0.0)); }\n`;
    expect(compiledFragment(PASS_VERTEX_SHADER, src)).toBe(src);
  });
});

// A compile error comes with the driver's log. A build that fails with none is
// the driver failing (Direct3D 11 losing the context over a shader it can't
// take), which the window's crash guard treats as a suspect.
describe("buildOutcome", () => {
  it.each([
    ["Shader compile failed: ERROR: 0:12: 'lin' : undeclared identifier", "failed"],
    ["Program link failed: too many uniforms", "failed"],
    ["Program link failed: ", "suspect"],
    ["Shader compile failed: \n", "suspect"],
    ["Program link failed:", "suspect"],
  ])("reads %j as %s", (message, outcome) => {
    expect(buildOutcome(new Error(message))).toBe(outcome);
  });

  it("reads anything else thrown as failed", () => {
    expect(buildOutcome(new Error("WebGLRenderer: out of texture units"))).toBe("failed");
    expect(buildOutcome("boom")).toBe("failed");
  });
});

// The worker builds programs on its one thread and says nothing until a frame is
// drawn, so a build the driver takes seconds over reads as a worker that stopped.
describe("createProgram's build time", () => {
  let clock = 0;
  beforeEach(() => {
    clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  afterEach(() => vi.restoreAllMocks());

  it("warns of a slow build, naming the program, how long it took and its size", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gl } = fakeGl(() => (clock += 1_500));
    createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER, 'the develop program for "builtin" with 3 stages');
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0];
    expect(message).toContain('the develop program for "builtin" with 3 stages took 1500 ms to build');
    expect(message).toContain(" KB of fragment GLSL");
  });

  it("says nothing of a quick one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gl } = fakeGl(() => (clock += 200));
    createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER, "a pass");
    expect(warn).not.toHaveBeenCalled();
  });
});

// The Library histogram and export build on the window's thread, where a status
// read blocks until the driver is done: a whole develop compile, up to a second.
describe("ProgramCache.whenBuilt", () => {
  const BUILT = buildStageInjection([], V2_VARIANT);
  const NONE = new Set<string>();
  afterEach(() => vi.useRealTimers());

  it("reads no compile or link status until the driver says the build is done", async () => {
    vi.useFakeTimers();
    const { gl, statusReads } = fakeGl(undefined, 3);
    const cache = new ProgramCache(gl);
    let done = false;
    const finished = cache.whenBuilt(BUILTIN_RESOLVED, BUILT, V2_VARIANT, NONE).then(() => {
      done = true;
    });
    for (let poll = 0; poll < 3; poll++) {
      await vi.advanceTimersToNextTimerAsync();
      expect(statusReads).toEqual([]);
      expect(done).toBe(false);
    }
    await vi.runAllTimersAsync();
    await finished;
    expect(statusReads).toEqual(["COMPILE_STATUS", "COMPILE_STATUS", "LINK_STATUS"]);
  });

  it("leaves the program built for the frame that asks for it", async () => {
    vi.useFakeTimers();
    const { gl, sources, statusReads } = fakeGl(undefined, 1);
    const cache = new ProgramCache(gl);
    const finished = cache.whenBuilt(BUILTIN_RESOLVED, BUILT, V2_VARIANT, NONE);
    await vi.runAllTimersAsync();
    await finished;
    const compiled = sources.size;
    const reads = statusReads.length;
    cache.entryFor(BUILTIN_RESOLVED, BUILT, V2_VARIANT, NONE);
    expect(sources.size).toBe(compiled);
    expect(statusReads).toHaveLength(reads);
  });

  it("builds nothing, and is done at once, where the driver can't say when a build is", async () => {
    const { gl, sources } = fakeGl();
    await new ProgramCache(gl).whenBuilt(BUILTIN_RESOLVED, BUILT, V2_VARIANT, NONE);
    expect(sources.size).toBe(0);
  });
});

// A build let go of says how it ended to the GPU crash guard. On a lost context
// that is unknown: the driver may have died over it, so the guard keeps blaming it.
describe("a submitted build let go of", () => {
  const BUILT = buildStageInjection([], V2_VARIANT);
  const STAGES_OF = new Set(["acme.blur"]);

  it.each([
    [false, "failed"],
    [true, "suspect"],
  ])("ends as %s-lost: %s", (lost, outcome) => {
    const { gl } = fakeGl();
    const ended: string[] = [];
    const cache = new ProgramCache(gl, undefined, { started: () => {}, ended: (_ids, o) => void ended.push(o) });
    cache.submit(BUILTIN_RESOLVED, BUILT, V2_VARIANT, STAGES_OF);
    Object.assign(gl, { isContextLost: () => lost });
    cache.dispose();
    expect(ended).toEqual([outcome]);
  });
});
