// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extensions are plain JavaScript, so `space` and `reads` arrive untyped. A
// value the core can't honour refuses the stage at registration rather than
// compiling it with values it never asked for.

import { describe, expect, it } from "vitest";
import { BUILTIN_DENOISE_ID } from "@/rendering/webgl/builtin-denoise";
import { CORE_EXTENSION_ID } from "./core-extension";
import { PROCESSING_PHASE_ORDER, type ProcessingStageContribution } from "./types";
import { checkStageContract } from "./stage-validation";

const base: ProcessingStageContribution = {
  id: "acme.stage",
  name: "Stage",
  phase: "scene-linear",
  glsl: "",
  uniforms: [],
};

const withFields = (fields: Record<string, unknown>): ProcessingStageContribution =>
  // The point is passing values TypeScript would reject, as plain JS can.
  ({ ...base, ...fields }) as ProcessingStageContribution;

describe("checkStageContract", () => {
  it("accepts a stage without the new fields", () => {
    expect(checkStageContract(base)).toEqual({ error: null, readsIgnored: null, warnings: [] });
  });

  it.each([
    ["linear", undefined],
    ["linear", "rec709"],
    ["linear", "rec2020"],
    ["perceptual", undefined],
    ["perceptual", "rec709"],
    ["perceptual", "rec2020"],
  ])("accepts encoding %s with primaries %s", (encoding, primaries) => {
    const check = checkStageContract(withFields({ space: { encoding, primaries } }));
    expect(check.error).toBeNull();
    expect(check.warnings).toEqual([]);
  });

  it.each([
    [{ encoding: "log" }],
    [{ encoding: "linear", primaries: "p3" }],
    ["linear"],
    [null],
  ])("refuses space that isn't an object or has invalid values: %o", (space) => {
    expect(checkStageContract(withFields({ space })).error).toMatch(/^stage "acme\.stage": /);
  });

  it("refuses an unknown reads value", () => {
    expect(checkStageContract(withFields({ reads: "edited" })).error).toMatch(/reads/);
  });

  it("accepts reads source explicitly", () => {
    const check = checkStageContract(withFields({ reads: "source" }));
    expect(check).toEqual({ error: null, readsIgnored: null, warnings: [] });
  });

  it("ignores reads current on a stage without passes, and says why", () => {
    const check = checkStageContract(withFields({ reads: "current" }));
    expect(check.error).toBeNull();
    expect(check.readsIgnored).toMatch(/has none/);
    expect(check.warnings).toEqual([]);
  });

  it("ignores reads current with empty passes array", () => {
    const check = checkStageContract(withFields({ reads: "current", passes: [] }));
    expect(check.error).toBeNull();
    expect(check.readsIgnored).toMatch(/has none/);
    expect(check.warnings).toEqual([]);
  });

  it("ignores reads current on a geometry stage", () => {
    const check = checkStageContract(
      withFields({ phase: "geometry", reads: "current", passes: [{ glsl: "" }] }),
    );
    expect(check.error).toBeNull();
    expect(check.readsIgnored).toMatch(/geometry/);
    expect(check.warnings).toEqual([]);
  });

  it("keeps reads current on a stage with passes", () => {
    const check = checkStageContract(withFields({ reads: "current", passes: [{ glsl: "" }] }));
    expect(check).toEqual({ error: null, readsIgnored: null, warnings: [] });
  });

  it("warns on unknown keys in space object", () => {
    const check = checkStageContract(
      withFields({ space: { encoding: "linear", primary: "rec2020" } }),
    );
    expect(check.error).toBeNull();
    expect(check.warnings).toContainEqual(expect.stringContaining("primary"));
  });

  it("warns when space is given to a geometry stage", () => {
    const check = checkStageContract(
      withFields({ phase: "geometry", space: { encoding: "linear" } }),
    );
    expect(check.error).toBeNull();
    expect(check.warnings).toContainEqual(expect.stringContaining("geometry"));
  });

  it.each([
    [{ space: { encoding: "toString" } }],
    [{ space: { encoding: "linear", primaries: "toString" } }],
    [{ reads: "toString" }],
  ])("refuses built-in names like toString that Object.hasOwn rejects", (fields) => {
    const check = checkStageContract(withFields(fields));
    expect(check.error).toMatch(/stage "acme\.stage":/);
  });

  it("handles JSON.stringify failures on BigInt gracefully", () => {
    const check = checkStageContract(withFields({ reads: 10n as unknown }));
    expect(check.error).toMatch(/stage "acme\.stage": reads/);
  });

  it("handles circular object in space gracefully", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const check = checkStageContract(withFields({ space: { encoding: circular as unknown } }));
    expect(check.error).toMatch(/space\.encoding/);
  });
});

// A message that quotes a bad value must not be what throws. Plain JavaScript can hand
// the check an object that `String()` refuses (one made with Object.create(null)) and
// that JSON.stringify won't print either; it is quoted by its tag. One that refuses
// even that (a revoked Proxy, a throwing Symbol.toStringTag getter, throwing traps) is
// quoted as "[unprintable]", so no message the check builds can throw.
describe("a value that can't be printed", () => {
  /** A kind of value, a way to make one, and what a message quotes it as. */
  const UNPRINTABLE: [string, () => Record<string, unknown>, string][] = [
    [
      "a cycle, with no prototype",
      () => {
        const value: Record<string, unknown> = Object.create(null);
        value.self = value;
        return value;
      },
      "[object Object]",
    ],
    [
      "a toJSON that answers nothing, with no prototype",
      () => {
        const value: Record<string, unknown> = Object.create(null);
        value.toJSON = () => undefined;
        return value;
      },
      "[object Object]",
    ],
    [
      "a revoked Proxy",
      () => {
        const { proxy, revoke } = Proxy.revocable<Record<string, unknown>>({}, {});
        revoke();
        return proxy;
      },
      "[unprintable]",
    ],
    [
      "a throwing Symbol.toStringTag getter, with no prototype and a toJSON that answers nothing",
      () => {
        const value: Record<string, unknown> = Object.create(null);
        value.toJSON = () => undefined;
        Object.defineProperty(value, Symbol.toStringTag, {
          get() {
            throw new Error("no tag");
          },
        });
        return value;
      },
      "[unprintable]",
    ],
    [
      "a Proxy whose every trap throws",
      () => {
        const everyTrapThrows = new Proxy(
          {},
          {
            get: () => () => {
              throw new Error("trap");
            },
          },
        );
        return new Proxy<Record<string, unknown>>({}, everyTrapThrows);
      },
      "[unprintable]",
    ],
  ];

  describe.each(UNPRINTABLE)("%s", (_kind, make, shown) => {
    it(`refuses it as space.encoding, quoting it as ${shown}`, () => {
      const check = checkStageContract(withFields({ space: { encoding: make() } }));
      expect(check.error).toBe(
        `stage "acme.stage": space.encoding must be "linear" or "perceptual", got ${shown}`,
      );
    });

    it(`refuses it as space.primaries, quoting it as ${shown}`, () => {
      const check = checkStageContract(
        withFields({ space: { encoding: "linear", primaries: make() } }),
      );
      expect(check.error).toBe(
        `stage "acme.stage": space.primaries must be "rec709" or "rec2020", got ${shown}`,
      );
    });

    it(`refuses it as reads, quoting it as ${shown}`, () => {
      const check = checkStageContract(withFields({ reads: make() }));
      expect(check.error).toBe(
        `stage "acme.stage": reads must be "source" or "current", got ${shown}`,
      );
    });

    it(`warns about it as the phase, quoting it as ${shown}, and still accepts the stage`, () => {
      const check = checkStageContract(withFields({ phase: make() }));
      expect(check.error).toBeNull();
      expect(check.warnings).toHaveLength(1);
      expect(check.warnings[0]).toContain(`stage "acme.stage": phase ${shown} is not one of `);
    });

    it(`names the stage ${shown} in a message when it is the id`, () => {
      const check = checkStageContract(withFields({ id: make(), phase: "post-effects" }));
      expect(check.error).toBeNull();
      expect(check.warnings).toHaveLength(1);
      expect(check.warnings[0]).toContain(`stage "${shown}": phase "post-effects" is not one of `);
    });
  });

  it("names a stage whose id is a symbol by the symbol", () => {
    const check = checkStageContract(withFields({ id: Symbol("acme"), phase: "post-effects" }));
    expect(check.warnings).toHaveLength(1);
    expect(check.warnings[0]).toContain(
      'stage "Symbol(acme)": phase "post-effects" is not one of ',
    );
  });
});

// A maskable stage runs again inside masks, which only the phases after mask
// coverage can do. A stage that asks elsewhere still registers, unmasked, and
// its author hears why.
describe("mask", () => {
  const clean = { error: null, readsIgnored: null, warnings: [] };

  it.each(["scene-linear", "tone-map", "display-adjust", "effects", "output-encode"])(
    "accepts a maskable %s stage without a warning",
    (phase) => {
      expect(checkStageContract(withFields({ phase, mask: { maskable: true } }))).toEqual(clean);
    },
  );

  it.each(["geometry", "decode", "noise-reduction"])(
    "warns that a %s stage, ahead of mask coverage, is never masked",
    (phase) => {
      const check = checkStageContract(withFields({ phase, mask: { maskable: true } }));
      expect(check.error).toBeNull();
      expect(check.warnings).toEqual([
        `stage "acme.stage": ${phase} stages run before mask coverage is known, so mask is ignored`,
      ]);
    },
  );

  it.each([true, { maskable: false }, "yes"])("warns that mask %j is ignored", (mask) => {
    const check = checkStageContract(withFields({ mask }));
    expect(check.error).toBeNull();
    expect(check.warnings).toEqual([`stage "acme.stage": mask must be { maskable: true }, so it is ignored`]);
  });

  // Mask copies are named "{stageId}@{n}"; a stage named so would share a copy's names.
  it("refuses an id ending in @ and a number", () => {
    const check = checkStageContract(withFields({ id: "acme.stage@2" }));
    expect(check.error).toMatch(/ends in "@2", which mask copies of stages are named with/);
  });
});

describe("inter-stage variables", () => {
  const clean = { error: null, readsIgnored: null, warnings: [] };

  it("accepts a producer with an expression, without a warning", () => {
    const fields = { produces: [{ name: "refT", glslType: "float", producer: "1.0" }] };
    expect(checkStageContract(withFields(fields))).toEqual(clean);
  });

  it("accepts a producer that assigns the variable from its own glsl", () => {
    const fields = { produces: [{ name: "refT_2", glslType: "vec3" }] };
    expect(checkStageContract(withFields(fields))).toEqual(clean);
  });

  it("accepts a consumer, without a warning", () => {
    expect(checkStageContract(withFields({ consumes: ["refT"] }))).toEqual(clean);
  });

  it.each([
    ["produces that isn't an array", { produces: { name: "a", glslType: "float" } }, /produces must be an array/],
    ["an entry that isn't an object", { produces: ["a"] }, /each produces entry must be an object/],
    ["a name with a symbol", { produces: [{ name: "a-b", glslType: "float" }] }, /produces name must be/],
    ["a name starting with a digit", { produces: [{ name: "1a", glslType: "float" }] }, /produces name must be/],
    ["a name with a double underscore", { produces: [{ name: "a__b", glslType: "float" }] }, /produces name must be .*without "__"/],
    ["an unknown type", { produces: [{ name: "a", glslType: "mat3" }] }, /produces "a" glslType must be/],
    ["a producer that isn't text", { produces: [{ name: "a", glslType: "float", producer: 1 }] }, /produces "a" producer must be a non-empty GLSL expression/],
    ["an empty producer", { produces: [{ name: "a", glslType: "float", producer: "" }] }, /produces "a" producer must be a non-empty GLSL expression/],
    ["a blank producer", { produces: [{ name: "a", glslType: "float", producer: " \t " }] }, /produces "a" producer must be a non-empty GLSL expression/],
    ["a name produced twice", { produces: [{ name: "a", glslType: "float" }, { name: "a", glslType: "vec2" }] }, /produces "a" twice/],
    ["consumes that isn't an array", { consumes: "a" }, /consumes must be an array/],
    ["a consumed name with a symbol", { consumes: ["a.b"] }, /consumes must hold variable names/],
    ["a consumed name with a double underscore", { consumes: ["a__b"] }, /consumes must hold variable names .*without "__"/],
  ])("refuses %s", (_what, fields, message) => {
    expect(checkStageContract(withFields(fields)).error).toMatch(message);
  });
});

// A stage that reads isv_x without listing x works while some other stage
// produces it and takes down every develop frame once that stage goes, because
// the orphan filter only sees `consumes`. So every read has to be listed.
describe("inter-stage variable references", () => {
  const clean = { error: null, readsIgnored: null, warnings: [] };
  const unlisted = (where: string) =>
    new RegExp(`^stage "acme\\.stage": ${where} reads isv_x but neither produces nor consumes "x"$`);

  it.each([
    ["glsl", { glsl: "c = vec3(isv_x);" }, unlisted("glsl")],
    ["helpers", { helpers: "float readX() { return isv_x; }" }, unlisted("helpers")],
    [
      "a producer expression",
      { produces: [{ name: "a", glslType: "float", producer: "isv_x * 2.0" }] },
      unlisted('produces "a" producer'),
    ],
    [
      "glsl of a stage that lists other names",
      { glsl: "c = vec3(isv_x);", consumes: ["y"], produces: [{ name: "a", glslType: "float" }] },
      unlisted("glsl"),
    ],
    ["a name that is only a prefix of a listed one", { glsl: "c = vec3(isv_x);", consumes: ["xy"] }, unlisted("glsl")],
  ])("refuses an unlisted read in %s", (_where, fields, message) => {
    expect(checkStageContract(withFields(fields)).error).toMatch(message);
  });

  it.each([
    ["consumes, in glsl", { glsl: "c = vec3(isv_x);", consumes: ["x"] }],
    ["consumes, in helpers", { helpers: "float readX() { return isv_x; }", consumes: ["x"] }],
    ["produces, in glsl", { glsl: "isv_x = lin.g;", produces: [{ name: "x", glslType: "float" }] }],
    ["produces, in its own producer", { produces: [{ name: "x", glslType: "float", producer: "isv_x + 1.0" }] }],
    [
      "consumes, in a producer of another name",
      { consumes: ["x"], produces: [{ name: "a", glslType: "float", producer: "isv_x" }] },
    ],
  ])("accepts a read that is listed in %s", (_where, fields) => {
    expect(checkStageContract(withFields(fields))).toEqual(clean);
  });

  it.each([
    ["a line comment", "lin *= 2.0; // reads isv_x\nlin += 1.0;"],
    ["a block comment", "/* isv_x */ lin *= 2.0;"],
    ["a block comment over several lines", "lin *= 2.0;\n/* the old way:\n   c = vec3(isv_x);\n*/\nlin += 1.0;"],
    ["a line comment holding a block opener", "// reads isv_x /*\nlin *= 2.0;"],
    ["a block comment holding a line comment", "/* // */ lin *= 2.0; /* isv_x */"],
    ["a line comment ended by CRLF", "lin *= 2.0; // isv_x\r\nlin += 1.0;"],
  ])("ignores a mention in %s", (_what, text) => {
    expect(checkStageContract(withFields({ glsl: text }))).toEqual(clean);
    expect(checkStageContract(withFields({ helpers: text }))).toEqual(clean);
  });

  it.each(["1.0 // isv_x", "1.0 /* isv_x */"])("ignores a mention in the producer %j", (producer) => {
    const produces = [{ name: "a", glslType: "float", producer }];
    expect(checkStageContract(withFields({ produces }))).toEqual(clean);
  });

  it("still reads code after a line comment that holds a block opener", () => {
    const glsl = "// note /*\nc = vec3(isv_x);";
    expect(checkStageContract(withFields({ glsl })).error).toMatch(unlisted("glsl"));
  });

  it("does not take a longer identifier ending in isv_x for a read", () => {
    expect(checkStageContract(withFields({ glsl: "float myisv_x = 1.0; lin *= myisv_x;" }))).toEqual(clean);
  });

  // Pass programs are separate draws that never see the globals, so a pass
  // can't read one whether or not its stage lists the name.
  it.each([
    ["glsl", { glsl: "lin *= isv_x;" }],
    ["helpers", { glsl: "", helpers: "float readX() { return isv_x; }" }],
  ])("refuses a pass that reads a variable in its %s", (_where, pass) => {
    const stage = { consumes: ["x"], passes: [{ glsl: "" }, pass] };
    expect(checkStageContract(withFields(stage)).error).toBe(
      'stage "acme.stage": passes[1] reads isv_x; inter-stage variables are not visible to passes',
    );
  });

  it("accepts a pass whose only mention is in a comment", () => {
    const pass = { glsl: "c *= 2.0; // not isv_x", helpers: "/* isv_x */ float f() { return 1.0; }" };
    expect(checkStageContract(withFields({ passes: [pass] }))).toEqual(clean);
  });
});

describe("pass draw counts", () => {
  const counted = (iterations: unknown, uniforms: unknown = [{ key: "draws", glslType: "int", default: 0 }]) =>
    withFields({ uniforms, passes: [{ glsl: "", iterations }] });

  it("accepts a key naming an int or a float uniform of the stage", () => {
    expect(checkStageContract(counted({ key: "draws", max: 8 })).error).toBeNull();
    const float = [{ key: "draws", glslType: "float", default: 0 }];
    expect(checkStageContract(counted({ key: "draws", max: 1024 }, float)).error).toBeNull();
  });

  it("accepts a key naming one of the pass's own uniforms", () => {
    const stage = withFields({
      passes: [{ glsl: "", uniforms: [{ key: "n", glslType: "int", default: 1 }], iterations: { key: "n", max: 4 } }],
    });
    expect(checkStageContract(stage).error).toBeNull();
  });

  it("still accepts a fixed count", () => {
    expect(checkStageContract(counted(3)).error).toBeNull();
  });

  it.each([1, 3, 2.5, 1024])("accepts the fixed count %s without a warning", (iterations) => {
    expect(checkStageContract(counted(iterations))).toEqual({ error: null, readsIgnored: null, warnings: [] });
  });

  // A fixed count the renderer clamps (to 1…1024, a non-finite one to 1) stays
  // registrable: an extension written before the bound would otherwise stop loading.
  it.each([
    [0, "0"],
    [-4, "-4"],
    [0.5, "0.5"],
    [1025, "1025"],
    [1e9, "1000000000"],
    [Infinity, "Infinity"],
    [-Infinity, "-Infinity"],
    [NaN, "NaN"],
  ])("warns that the fixed count %s is clamped, and still accepts the stage", (iterations, shown) => {
    const check = checkStageContract(counted(iterations));
    expect(check.error).toBeNull();
    expect(check.warnings).toEqual([
      `stage "acme.stage": passes[0].iterations ${shown} is out of range; it is clamped to 1…1024`,
    ]);
  });

  it("names the pass whose fixed count is out of range", () => {
    const stage = withFields({ passes: [{ glsl: "", iterations: 2 }, { glsl: "" }, { glsl: "", iterations: 5000 }] });
    expect(checkStageContract(stage).warnings).toEqual([
      'stage "acme.stage": passes[2].iterations 5000 is out of range; it is clamped to 1…1024',
    ]);
  });

  it.each([
    ["a string", "draws", /passes\[0\]\.iterations must be a number or \{ key, max \}/],
    ["a max of 0", { key: "draws", max: 0 }, /passes\[0\]\.iterations\.max must be an integer from 1 to 1024/],
    ["a max above 1024", { key: "draws", max: 2000 }, /passes\[0\]\.iterations\.max must be an integer from 1 to 1024/],
    ["a fractional max", { key: "draws", max: 2.5 }, /passes\[0\]\.iterations\.max must be an integer from 1 to 1024/],
    ["an undeclared key", { key: "other", max: 4 }, /passes\[0\]\.iterations\.key must name a uniform the stage declares/],
  ])("refuses %s", (_what, iterations, message) => {
    expect(checkStageContract(counted(iterations)).error).toMatch(message);
  });

  it("refuses a key naming a vector uniform", () => {
    const vec = [{ key: "draws", glslType: "vec2", default: [0, 0] }];
    expect(checkStageContract(counted({ key: "draws", max: 4 }, vec)).error).toMatch(
      /passes\[0\]\.iterations\.key "draws" must name an int or float uniform/,
    );
  });
});

// The ordering reads `after` as a list of stage ids and ignores anything else, so
// a value it can't use is a warning: the author would otherwise get no effect and
// no word about it.
describe("after", () => {
  it.each([[[]], [["acme.base"]], [["acme.base", "acme.other"]]])(
    "accepts the list %o without a warning",
    (after) => {
      const check = checkStageContract(withFields({ after }));
      expect(check).toEqual({ error: null, readsIgnored: null, warnings: [] });
    },
  );

  it.each(["acme.base", 3, null, true, { 0: "acme.base" }])(
    "warns that %o isn't an array of stage ids, and still accepts the stage",
    (after) => {
      const check = checkStageContract(withFields({ after }));
      expect(check.error).toBeNull();
      expect(check.warnings).toHaveLength(1);
      expect(check.warnings[0]).toMatch(
        /^stage "acme\.stage": after must be an array of stage ids, so it is ignored$/,
      );
    },
  );

  it.each([[[1, "acme.base"]], [[null]], [[["acme.base"]]]])(
    "warns that the list %o holds more than stage ids, and still accepts the stage",
    (after) => {
      const check = checkStageContract(withFields({ after }));
      expect(check.error).toBeNull();
      expect(check.warnings).toHaveLength(1);
      expect(check.warnings[0]).toMatch(
        /^stage "acme\.stage": after must hold stage ids \(strings\) only, so the other entries are ignored$/,
      );
    },
  );
});

// The injection places a stage in a phase its table lacks (after every listed
// one), so an unlisted phase is a warning, not a refusal.
describe("phase", () => {
  it.each(PROCESSING_PHASE_ORDER)("accepts %s without a warning", (phase) => {
    const check = checkStageContract(withFields({ phase }));
    expect(check).toEqual({ error: null, readsIgnored: null, warnings: [] });
  });

  it.each(["post-effects", "toString", "", 3, undefined])(
    "warns that phase %o isn't one of the phases, and still accepts the stage",
    (phase) => {
      const check = checkStageContract(withFields({ phase }));
      expect(check.error).toBeNull();
      expect(check.warnings).toHaveLength(1);
      expect(check.warnings[0]).toMatch(/^stage "acme\.stage": phase /);
    },
  );
});

// Ids under "core." and the built-in denoiser's id get core treatment in the
// injection: raw uniform names, no param-bag bindings, version 2's helper
// rewrite. An extension that took one would bring that treatment to its own GLSL.
describe("ids that belong to Safelight's own stages", () => {
  const OWN = ["core.vignette", "core.something.new", BUILTIN_DENOISE_ID];
  const ACCEPTED = { error: null, readsIgnored: null, warnings: [] };

  it.each(OWN)("refuses %s from an extension", (id) => {
    const { error } = checkStageContract(withFields({ id }), "acme");
    expect(error).toContain(`stage "${id}"`);
    expect(error).toMatch(/reserved for Safelight's own stages/);
  });

  it.each(OWN)("refuses %s when no extension is named, as an extension's", (id) => {
    expect(checkStageContract(withFields({ id })).error).not.toBeNull();
  });

  it.each(OWN)("accepts %s from the core extension", (id) => {
    expect(checkStageContract(withFields({ id }), CORE_EXTENSION_ID)).toEqual(ACCEPTED);
  });

  // The other built-in extensions (core.hsl, core.devtools) register panels, not stages.
  it("refuses them from another extension in the core. namespace", () => {
    const check = checkStageContract(withFields({ id: "core.vignette" }), "core.hsl");
    expect(check.error).not.toBeNull();
  });

  it.each(["acme.stage", "core", "corex.stage", "my.core.stage", `${BUILTIN_DENOISE_ID}.extra`])(
    "leaves %s to any extension",
    (id) => {
      expect(checkStageContract(withFields({ id }), "acme")).toEqual(ACCEPTED);
    },
  );

  // Extensions are plain JavaScript; the check must not be the thing that throws.
  it.each([undefined, null, 4])("doesn't throw for the id %o", (id) => {
    expect(() => checkStageContract(withFields({ id }), "acme")).not.toThrow();
  });
});
