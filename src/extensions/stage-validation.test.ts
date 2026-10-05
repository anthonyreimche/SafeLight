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

// The contract names three fields the core doesn't implement. An older extension
// may carry one, so the stage still registers, but its author hears that the core
// does nothing with it.
describe("reserved fields", () => {
  const RESERVED: [string, unknown][] = [
    ["produces", [{ name: "refT", glslType: "float", producer: "1.0" }]],
    ["consumes", ["refT"]],
    ["mask", { maskable: true, maskPhase: "linear" }],
  ];

  it.each(RESERVED)("warns that %s is reserved, and still accepts the stage", (field, value) => {
    const check = checkStageContract(withFields({ [field]: value }));
    expect(check.error).toBeNull();
    expect(check.warnings).toHaveLength(1);
    expect(check.warnings[0]).toMatch(new RegExp(`^stage "acme\\.stage": ${field} is reserved`));
  });

  it("warns once for each reserved field a stage sets", () => {
    const check = checkStageContract(withFields(Object.fromEntries(RESERVED)));
    expect(check.error).toBeNull();
    expect(check.warnings).toHaveLength(RESERVED.length);
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
