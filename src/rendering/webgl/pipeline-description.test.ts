// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// @vitest-environment jsdom

// The Pipeline tab is only worth reading if it says what the program does, so
// these tests hold describePipeline to the GLSL itself: the clamps and
// conversions to the lines buildStageInjection writes, the stage order to its
// signature, and the core table to shaders.ts's own text.

import { describe, expect, it } from "vitest";
import { defaultMaskAdjustments, type Mask } from "@/catalog/types";
import { BUILTIN_RESOLVED, type ResolvedPipeline } from "@/extensions/pipelines";
import type { ProcessingPhase, ProcessingStageContribution } from "@/extensions/types";
import { fromSpaceExpr, isIdentitySpace, spaceKey, toSpaceExpr } from "../stage-space";
import { isMaskInstance, maskInstances } from "./mask-stage-instances";
import { CORE_BLOCKS, describePipeline, findFloors, type ClipWhen, type PipelineRow } from "./pipeline-description";
import { V1_VARIANT, V2_VARIANT, V3_VARIANT, buildFragmentShader, type ShaderVariant } from "./shaders";
import { buildStageInjection, type InjectionStep } from "./stage-injection";
import { V2_IDENTITY_CONFIGS } from "./v2-identity.fixtures";
import { builtinStages } from "./webgl.test-support";

type Version = "v1" | "v2" | "v3";
const VARIANTS: [Version, ShaderVariant][] = [
  ["v1", V1_VARIANT],
  ["v2", V2_VARIANT],
  ["v3", V3_VARIANT],
];
const COLOUR_GROUPS = ["noiseReduction", "sceneLinear", "effects"] as const;
const GROUPS = ["srcUv", ...COLOUR_GROUPS] as const;

type Row<K extends PipelineRow["kind"]> = Extract<PipelineRow, { kind: K }>;
const rowsOf = <K extends PipelineRow["kind"]>(rows: readonly PipelineRow[], kind: K): Row<K>[] =>
  rows.filter((r): r is Row<K> => r.kind === kind);

type ConvertStep = Extract<InjectionStep, { kind: "convert" }>;
const isConvert = (s: InjectionStep): s is ConvertStep => s.kind === "convert";

/** The lines a convert step stands for: out of the space held, into the next. */
const convertLines = (step: ConvertStep): string[] => {
  if (step.elided) return [];
  const v = step.domain === "scene" ? "lin" : "c";
  const out = isIdentitySpace(step.from, step.domain) ? [] : [`${v} = ${fromSpaceExpr(step.from, step.domain, v)};`];
  const into = isIdentitySpace(step.to, step.domain) ? [] : [`${v} = ${toSpaceExpr(step.to, step.domain, v)};`];
  return [...out, ...into];
};

/** A stage or conversion row, and the step it stands for, in one form. */
const convertKey = (from: string, to: string, elided: boolean | undefined) => `${from}>${to}${elided ? "=" : ""}`;
const rowKey = (r: PipelineRow): string[] =>
  r.kind === "stage" ? [r.id] : r.kind === "convert" ? [convertKey(r.from, r.to, r.elided)] : [];
const stepKey = (s: InjectionStep): string[] =>
  s.kind === "stage"
    ? [s.stageId]
    : isConvert(s)
      ? [convertKey(spaceKey(s.from, s.domain), spaceKey(s.to, s.domain), s.elided)]
      : [];

// Every conversion the injector writes assigns the colour variable one of these.
const CONVERSION_LINE = /^(lin|c) = (slEncodePerceptual\(|slDecodePerceptual\(|\(SL_REC)/;
const writtenConversions = (glsl: string): string[] =>
  glsl
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => CONVERSION_LINE.test(line));

// Written by the injector both ahead of a legacy display stage's block and
// into the split exit its passes read.
const STAGE_CLIP = "clamp(c, 0.0, 1.0)";
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

const amount = (key: string) => [{ key, glslType: "float" as const, default: 0 }];
const COPY_PASS = [{ glsl: "c = readPrev(vUv);" }];
const mask = (id: string, bag: Record<string, unknown>): Mask => ({
  id,
  name: id,
  visible: true,
  invert: false,
  opacity: 100,
  adj: defaultMaskAdjustments(),
  panels: [],
  components: [],
  bag,
});

// Maskable stages that make the injector write something for each copy: a
// legacy display stage (its clip), a reader with a declared space (its exit's
// conversions) and a legacy reader in the output frame (its deferred exit's clip).
const MASKED: ProcessingStageContribution[] = [
  {
    id: "masked.wash", name: "Wash", phase: "display-adjust",
    glsl: "c *= washAmount;", uniforms: amount("washAmount"), mask: { maskable: true },
  },
  {
    id: "masked.wide", name: "Wide reader", phase: "display-adjust", reads: "current",
    space: { encoding: "linear", primaries: "rec2020" },
    glsl: "c = mix(c, stageResult, wideMix);", uniforms: amount("wideMix"), passes: COPY_PASS,
    mask: { maskable: true },
  },
  {
    id: "masked.glow", name: "Glow", phase: "effects", reads: "current",
    glsl: "c = mix(c, stageResult, glowMix);", uniforms: amount("glowMix"), passes: COPY_PASS,
    mask: { maskable: true },
  },
];
const MASKS = ["a", "b"].map((id) =>
  mask(id, {
    "masked.wash.washAmount": 1,
    "masked.wide.wideMix": 1,
    "masked.glow.glowMix": 1,
    "acme.grade.lift": 1,
  }),
);
/** The stages with the copies two masks call for, as the renderer passes them. */
const withCopies = (stages: readonly ProcessingStageContribution[], variant: ShaderVariant) =>
  maskInstances(stages, MASKS, variant).stages;

interface CrossCheck {
  stages: (variant: ShaderVariant) => readonly ProcessingStageContribution[];
  samplerBudget?: number;
}
const CROSS_CHECKS: Record<string, CrossCheck> = {
  ...V2_IDENTITY_CONFIGS,
  masked: { stages: (variant) => withCopies([...builtinStages(), ...MASKED], variant) },
};

describe("describePipeline against the GLSL buildStageInjection writes", () => {
  for (const [name, config] of Object.entries(CROSS_CHECKS)) {
    for (const [version, variant] of VARIANTS) {
      describe(`${name} on ${version}`, () => {
        const stages = config.stages(variant);
        const built = buildStageInjection(stages, variant, config.samplerBudget);
        const rows = describePipeline(stages, variant, BUILTIN_RESOLVED);

        // A stage's mask copies have no rows: each repeats the clips its stage's rows list.
        it("lists every clip the injector writes", () => {
          const written = COLOUR_GROUPS.reduce((n, g) => n + occurrences(built.injection[g], STAGE_CLIP), 0);
          const copies = new Map(rowsOf(rows, "stage").map((r) => [r.id, r.copies ?? 0]));
          const listed = rowsOf(rows, "clamp").flatMap((r) =>
            r.reason === "legacy-display-stage" ? [1 + (copies.get(r.stageId) ?? 0)] : [],
          );
          expect(listed.reduce((a, b) => a + b, 0)).toBe(written);
        });

        it("records every conversion line the injector writes, and lists it where it is written", () => {
          for (const group of COLOUR_GROUPS) {
            const steps = built.steps.filter(isConvert).filter((s) => s.group === group);
            expect(steps.flatMap(convertLines), group).toEqual(writtenConversions(built.injection[group]));
          }
          // A copy's conversions fold into its stage's note instead.
          if (stages.some(isMaskInstance)) return;
          const inProgramOrder = GROUPS.flatMap((g) => built.steps.filter((s) => s.group === g));
          expect(rows.flatMap(rowKey)).toEqual(inProgramOrder.flatMap(stepKey));
        });

        it("lists the stages in pipeline order, without their mask copies", () => {
          const order = built.sig.split("|").map((entry) => entry.slice(0, entry.lastIndexOf(":")));
          const copies = new Set(stages.filter(isMaskInstance).map((s) => s.id));
          expect(rowsOf(rows, "stage").map((r) => r.id)).toEqual(order.filter((id) => !copies.has(id)));
        });
      });
    }
  }

  it("lists the clip ahead of each legacy display stage right above its row", () => {
    const rows = describePipeline(V2_IDENTITY_CONFIGS.legacyExtensions.stages(), V2_VARIANT, BUILTIN_RESOLVED);
    const above = rows.flatMap((r, i) =>
      r.kind === "clamp" && r.reason === "legacy-display-stage" && r.where === "input" ? [rows[i + 1]] : [],
    );
    expect(above.map((r) => r.kind === "stage" && r.id)).toEqual(["legacy.tint", "legacy.glow", "legacy.mono"]);
  });

  it("lists the clip of what a legacy reader's passes read", () => {
    const passClips = (variant: ShaderVariant) =>
      rowsOf(describePipeline(V2_IDENTITY_CONFIGS.splits.stages(), variant, BUILTIN_RESOLVED), "clamp").flatMap(
        (r) => (r.reason === "legacy-display-stage" && r.where === "pass-input" ? [r.stageId] : []),
      );
    expect(passClips(V2_VARIANT)).toEqual(["split.effects"]);
    expect(passClips(V1_VARIANT)).toEqual([]);
  });

  it("says where adjacent stages share a space and nothing is converted", () => {
    const rows = describePipeline(V2_IDENTITY_CONFIGS.spaced.stages(), V2_VARIANT, BUILTIN_RESOLVED);
    const at = rows.findIndex((r) => r.kind === "stage" && r.id === "spaced.wideToo");
    expect(rows[at - 1]).toEqual({ kind: "convert", from: "linear/rec2020", to: "linear/rec2020", elided: true });
  });

  it("lists no conversion between working values", () => {
    expect(rowsOf(describePipeline(builtinStages(), V2_VARIANT, BUILTIN_RESOLVED), "convert")).toEqual([]);
  });

  // The version 2 freeze hashes everything in `injection` but its GLSL as
  // injectionMeta, so the steps must ride beside it.
  it("keeps the steps out of the injection the version 2 freeze hashes", () => {
    const built = buildStageInjection(V2_IDENTITY_CONFIGS.spaced.stages(), V2_VARIANT);
    expect(built.steps.length).toBeGreaterThan(0);
    expect(built.injection).not.toHaveProperty("steps");
  });
});

// Where each core block starts in main(), by a phrase only that block has there,
// on the block's first line in every version.
const BLOCK_MARKERS: Record<string, string> = {
  "Crop & Straighten": "cropTransformUV(viewUv)",
  Heal: "src = applyRetouch(srcUv, src)",
  "Linear source and baseline tone": "vec3 lin = uLinear ? src",
  "Noise Reduction": "if (!uSkipCoreNR",
  "Channel reconstruction": "lin = reconstructClipped(lin, srcUv)",
  "White Balance": "lin = applyWhiteBalance(lin",
  "Exposure, Highlights, Shadows & tone shoulder": "float E = uExposure;",
  "Masking (scene values)": "float mcovs[MAX_MASKS]",
  "Display transform": "vec3 disp = ",
  Whites: "abs(uWhites)",
  Blacks: "abs(uBlacks)",
  Contrast: "abs(ck)",
  "Tone Curve": "applyToneCurve(c)",
  HSL: "applyHSL(",
  Dehaze: "abs(dehAmt)",
  Clarity: "abs(clarAmt)",
  Texture: "abs(texAmt)",
  "Highlight Detail & Shadow Detail": "float bandDet",
  "Vibrance & Saturation": "uVibrance",
  "Color Grading": "applyColorGrading(",
  Sharpening: "float sharpen = uSharpening",
  "Masking (display values)": "float mcov = mcovs[mi];",
};
const OUTPUT_MARKER = "vec3 outRgb = ";

const PLACEHOLDERS = {
  srcUv: "//__CONTRIBUTED_GEOMETRY__",
  noiseReduction: "//__CONTRIBUTED_NOISE_REDUCTION__",
  sceneLinear: "//__CONTRIBUTED_SCENE_LINEAR__",
  effects: "//__CONTRIBUTED_EFFECTS__",
};

/** The develop program with each group's placeholder left where it stands. */
const program = (variant: ShaderVariant): string =>
  buildFragmentShader(null, { uniforms: "", helpers: "", ...PLACEHOLDERS }, variant);

/** Where a clip is in one version's main(), and when it runs there. */
type At = readonly [phrase: string, when: ClipWhen];

interface ClipSite {
  /** The core block whose span of main() holds it, and whose row its row sits
   *  under; "Output" for the output encode. */
  block: string;
  where: "input" | "result";
  v1?: At;
  v2?: At;
  v3?: At;
  /** For a clip a helper makes: the helper main() calls, and its clipping line
   *  (an input clip is its first). */
  helper?: readonly [name: string, clip: string];
}

const IN_USE = "while-active";
const everywhere = (phrase: string, when: ClipWhen) =>
  ({ v1: [phrase, when], v2: [phrase, when], v3: [phrase, when] }) as const;
const fromV2 = (phrase: string, when: ClipWhen) => ({ v2: [phrase, when], v3: [phrase, when] }) as const;
const thenClip = (line: string) => `${line}\n    c = clamp(c, 0.0, 1.0);`;
const gateClip = (gate: string) => thenClip(`${gate} > 0.001) {`);
const RESULT_CLIP = thenClip("c = c * (newL / L);");
const OPENS_CLIPPED = "{\n  c = clamp(c, 0.0, 1.0);";
const VIB_SAT_GATE = "if (abs(uVibrance) >= 0.1 || abs(uSaturation) > 0.1)\n    c = applyVibSat(";

// Every clip of the working colour in the develop program's main(), in
// program order (the review's clip-site list). The code phrases key each one
// to the shader's text; the rows must follow the table.
const CLIP_SITES: ClipSite[] = [
  {
    block: "Display transform", where: "result",
    v1: ["vec3 disp = clamp(pipelineToDisplay(lin), 0.0, 1.0);", "always"],
  },
  { block: "Whites", where: "input", ...fromV2(gateClip("abs(uWhites)"), IN_USE) },
  { block: "Whites", where: "result", ...everywhere(RESULT_CLIP, IN_USE) },
  { block: "Blacks", where: "input", ...fromV2(gateClip("abs(uBlacks)"), IN_USE) },
  { block: "Blacks", where: "result", ...everywhere(RESULT_CLIP, IN_USE) },
  { block: "Contrast", where: "input", ...fromV2(gateClip("abs(ck)"), IN_USE) },
  { block: "Contrast", where: "result", ...everywhere(thenClip("c = c * (Lnew / max(L, 1e-4));"), IN_USE) },
  {
    block: "Tone Curve", where: "input",
    v1: ["c = applyToneCurve(c);", "always"], ...fromV2("if (uCurveActive) c = applyToneCurve(c);", IN_USE),
    helper: ["applyToneCurve", OPENS_CLIPPED],
  },
  { block: "HSL", where: "input", ...fromV2("if (uHslActive) c = applyHSL(clamp(c, 0.0, 1.0));", IN_USE) },
  {
    block: "HSL", where: "result",
    v1: ["c = applyHSL(c);", "always"], ...fromV2("if (uHslActive) c = applyHSL(", IN_USE),
    helper: ["applyHSL", "return clamp(rgb, 0.0, 1.0);"],
  },
  { block: "Dehaze", where: "input", ...fromV2(gateClip("abs(dehAmt)"), IN_USE) },
  { block: "Dehaze", where: "result", ...everywhere(thenClip("c = mix(vec3(dl), c, 1.0 + dehAmt * 0.4);"), IN_USE) },
  { block: "Highlight Detail & Shadow Detail", where: "result", v1: ["}\n  c = clamp(c, 0.0, 1.0);", "always"] },
  {
    block: "Vibrance & Saturation", where: "input",
    v1: ["c = applyVibSat(c, uVibrance, uSaturation);", "always"], ...fromV2(VIB_SAT_GATE, IN_USE),
    helper: ["applyVibSat", OPENS_CLIPPED],
  },
  // Version 1 calls it for every pixel, but it clips its result only for a
  // saturation or vibrance it applies.
  {
    block: "Vibrance & Saturation", where: "result",
    v1: ["c = applyVibSat(", IN_USE], ...fromV2(VIB_SAT_GATE, IN_USE),
    helper: ["applyVibSat", "c = clamp(mix(vec3(l), c, 1.0 + vibAmt), 0.0, 1.0);"],
  },
  {
    block: "Color Grading", where: "input",
    ...fromV2("if (uColorGradingActive) c = applyColorGrading(clamp(c, 0.0, 1.0));", IN_USE),
  },
  {
    block: "Color Grading", where: "result",
    v1: ["c = applyColorGrading(c);", "always"], ...fromV2("if (uColorGradingActive) c = applyColorGrading(", IN_USE),
    helper: ["applyColorGrading", "return clamp(c, 0.0, 1.0);"],
  },
  { block: "Sharpening", where: "result", ...everywhere(thenClip("if (uIsFallbackPreview) {"), "fallback-preview") },
  {
    block: "Masking (display values)", where: "input",
    ...fromV2("if (uMaskHasDisplay[mi] == 1)\n      c = mix(c, applyMaskDisplay(clamp(c, 0.0, 1.0)", "per-mask"),
  },
  {
    block: "Masking (display values)", where: "result",
    v1: ["c = applyMaskDisplay(c, ", "per-mask"], ...fromV2("c = mix(c, applyMaskDisplay(", "per-mask"),
    helper: ["applyMaskDisplay", "r = clamp(r, 0.0, 1.0);\n  return mix(c, r, m);"],
  },
  {
    block: "Masking (display values)", where: "input",
    ...everywhere("if (uMaskHasHsl[mi] == 1)\n      c = mix(c, maskHsl(clamp(c, 0.0, 1.0), mi), mcov);", "per-mask"),
  },
  {
    block: "Masking (display values)", where: "result",
    ...everywhere("c = mix(c, maskHsl(", "per-mask"), helper: ["maskHsl", "return clamp(rgb, 0.0, 1.0);"],
  },
  {
    block: "Masking (display values)", where: "input",
    ...everywhere("if (uMaskHasCurve[mi] == 1)\n      c = maskCurve(c, mi, mcov);", "per-mask"),
    helper: ["maskCurve", "{\n  vec3 cs = clamp(c, 0.0, 1.0);"],
  },
  {
    block: "Output", where: "input",
    v1: ["vec3 outRgb = encodeOutput(clamp(c, 0.0, 1.0));", "always"],
    v2: ["vec3 outRgb = encodeOutput(clamp(c, 0.0, 1.0));", "always"],
  },
  {
    block: "Output", where: "result",
    v1: ["vec3 outRgb = encodeOutput(", "non-srgb-output"], v2: ["vec3 outRgb = encodeOutput(", "non-srgb-output"],
    helper: ["encodeOutput", "vec3 lin = clamp(uOutMatrix * srgbToLinear(srgb), 0.0, 1.0);"],
  },
];

// Clips of the colour that never reach the frame: the sharpening and Color-NR
// previews, the clipping overlay, and the scene tone the masks classify by.
const NOT_THE_FRAME = [
  "sharpenViz = luma(clamp(c, 0.0, 1.0))",
  "vec3 cc = clamp(c, 0.0, 1.0);",
  "vec3 display = encodeOutput(clamp(c, 0.0, 1.0));",
  "float refT = clamp(luma(linearToSrgbU(max(lin, vec3(0.0)))), 0.0, 1.0);",
];
const CLIP_IN_MAIN = new RegExp(
  [
    String.raw`\b(?:clamp|max|min)\s*\(\s*(?:c|lin)\s*,`,
    String.raw`encodeOutput\s*\(\s*clamp\s*\(`,
    String.raw`clamp\s*\(\s*pipelineToDisplay\s*\(`,
  ].join("|"),
  "g",
);

/** Each core block's span of main(), from the start of its marker's line
 *  (a block's gate can share that line), up to the next block's. */
function blockSpans(src: string): Map<string, readonly [number, number]> {
  const main = src.indexOf("void main()");
  const lineStart = (marker: string) => src.lastIndexOf("\n", src.indexOf(marker, main)) + 1;
  const labels = [...CORE_BLOCKS.map((b) => b.label), "Output"];
  const starts = [...CORE_BLOCKS.map((b) => lineStart(BLOCK_MARKERS[b.label])), lineStart(OUTPUT_MARKER), src.length];
  return new Map(labels.map((label, i) => [label, [starts[i], starts[i + 1]] as const]));
}

/** A helper's body, from its opening brace to the one that closes it. */
function helperBody(src: string, name: string): string {
  const open = src.indexOf("{", src.search(new RegExp(String.raw`\bvec3 ${name}\(`)));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return "";
}

/** The core and output clamp rows, each with the block it sits under. */
const coreClips = (rows: readonly PipelineRow[]) => {
  let block = "";
  return rows.flatMap((r) => {
    if (r.kind === "core") block = r.label;
    if (r.kind !== "clamp" || r.reason === "legacy-display-stage") return [];
    return [{ block: r.reason === "output" ? "Output" : block, where: r.where, when: r.when }];
  });
};

for (const [version, variant] of VARIANTS) {
  describe(`every clip in the ${version} program's main()`, () => {
    const src = program(variant);
    const spans = blockSpans(src);
    const sites = CLIP_SITES.flatMap((site) => {
      const at = site[version];
      return at ? [{ ...site, phrase: at[0], when: at[1] }] : [];
    });
    const spanOf = (block: string) => spans.get(block) ?? [0, 0];

    it("is where the site table says, once in its block's code", () => {
      for (const { block, where, phrase, helper } of sites) {
        const [from, to] = spanOf(block);
        expect(occurrences(src.slice(from, to), phrase), `${block}, ${where}`).toBe(1);
        if (!helper) continue;
        const body = helperBody(src, helper[0]);
        expect(where === "input" ? body.startsWith(helper[1]) : body.includes(helper[1]), helper[0]).toBe(true);
      }
    });

    it("has a row under its block, in program order", () => {
      const rows = describePipeline([], variant, BUILTIN_RESOLVED);
      expect(coreClips(rows)).toEqual(sites.map(({ block, where, when }) => ({ block, where, when })));
    });

    // A clip added to main() without a row in the table fails here.
    it("is in the site table unless it never reaches the frame", () => {
      let text = src;
      const blank = (from: number, length: number) => {
        text = text.slice(0, from) + " ".repeat(length) + text.slice(from + length);
      };
      for (const { block, phrase, helper } of sites) {
        const at = src.indexOf(phrase, spanOf(block)[0]);
        if (!helper && at >= 0) blank(at, phrase.length);
      }
      for (const phrase of NOT_THE_FRAME) {
        for (let at = text.indexOf(phrase); at >= 0; at = text.indexOf(phrase, at)) blank(at, phrase.length);
      }
      expect(text.slice(src.indexOf("void main()")).match(CLIP_IN_MAIN) ?? []).toEqual([]);
    });
  });
}

describe("the core block table", () => {
  it("has a marker for every block", () => {
    expect(CORE_BLOCKS.map((b) => b.label).filter((label) => !(label in BLOCK_MARKERS))).toEqual([]);
  });

  for (const [version, variant] of VARIANTS) {
    it(`follows the ${version} program, each group's placeholder where the table anchors it`, () => {
      const src = program(variant);
      const main = src.indexOf("void main()");
      const anchors = [
        ...CORE_BLOCKS.flatMap((b) => [BLOCK_MARKERS[b.label], ...(b.stages ? [PLACEHOLDERS[b.stages]] : [])]),
        OUTPUT_MARKER,
      ];
      const at = anchors.map((a) => src.indexOf(a, main));
      expect(anchors.filter((_, i) => at[i] < 0)).toEqual([]);
      expect(at).toEqual([...at].sort((a, b) => a - b));
    });
  }
});

describe("what each version does differently", () => {
  const describeBuiltin = (variant: ShaderVariant, pipeline: ResolvedPipeline = BUILTIN_RESOLVED) =>
    describePipeline(builtinStages(), variant, pipeline);

  it("clips the output on versions 1 and 2, and maps it into a named target on version 3", () => {
    const output = (variant: ShaderVariant) => rowsOf(describeBuiltin(variant), "output");
    expect(output(V1_VARIANT)).toMatchObject([{ mapped: false }]);
    expect(output(V2_VARIANT)).toMatchObject([{ mapped: false }]);
    const [v3] = output(V3_VARIANT);
    expect(v3.mapped).toBe(true);
    expect(v3.detail).toMatch(/sRGB or Display P3/);
    expect(v3.detail).toMatch(/export's colour space/);
  });

  const FILMIC: ResolvedPipeline = {
    id: "acme.filmic",
    glsl: "vec3 pipelineToDisplay(vec3 lin) { return lin / (1.0 + lin); }",
    skipBaseCurve: true,
    skipToneShoulder: true,
    sig: "acme.filmic",
  };

  it("honours skipToneShoulder from version 2 on, and skipBaseCurve on every version", () => {
    const transform = (variant: ShaderVariant) => rowsOf(describeBuiltin(variant, FILMIC), "transform");
    const flags = (shoulderHonoured: boolean) => [
      {
        kind: "transform",
        id: "acme.filmic",
        flags: [
          { flag: "skipBaseCurve", honoured: true },
          { flag: "skipToneShoulder", honoured: shoulderHonoured },
        ],
      },
    ];
    expect(transform(V1_VARIANT)).toEqual(flags(false));
    expect(transform(V2_VARIANT)).toEqual(flags(true));
    expect(transform(V3_VARIANT)).toEqual(flags(true));
    const shoulderOnly = { ...FILMIC, skipBaseCurve: false };
    expect(rowsOf(describeBuiltin(V2_VARIANT, shoulderOnly), "transform")[0].flags).toEqual([
      { flag: "skipToneShoulder", honoured: true },
    ]);
  });

  it("names no transform and no flags for the built-in one", () => {
    expect(rowsOf(describeBuiltin(V2_VARIANT), "transform")).toEqual([{ kind: "transform", id: null, flags: [] }]);
  });

  it("notes the channel roll-off where the tone shoulder runs on version 2 and later", () => {
    const transformNote = (variant: ShaderVariant, pipeline?: ResolvedPipeline) =>
      rowsOf(describeBuiltin(variant, pipeline), "core").find((r) => r.label === "Display transform")?.note;
    expect(transformNote(V2_VARIANT)).toBeTruthy();
    expect(transformNote(V1_VARIANT)).toBeUndefined();
    expect(transformNote(V2_VARIANT, FILMIC)).toBeUndefined();
  });

  it("notes that a noise-reduction stage replaces the core block", () => {
    const nrNote = (stages: ProcessingStageContribution[]) =>
      rowsOf(describePipeline(stages, V2_VARIANT, BUILTIN_RESOLVED), "core").find(
        (r) => r.label === "Noise Reduction",
      )?.note;
    expect(nrNote(builtinStages())).toBeTruthy();
    expect(nrNote([])).toBeUndefined();
  });
});

describe("stage rows", () => {
  const GRADE: ProcessingStageContribution & { extensionId: string } = {
    id: "acme.grade",
    name: "Grade",
    phase: "display-adjust",
    priority: 120,
    space: { encoding: "perceptual" },
    glsl: "c = max(c, 0.0);",
    uniforms: [{ key: "lift", glslType: "float", default: 0 }],
    mask: { maskable: true },
    extensionId: "acme",
  };
  const registered = () => [...builtinStages().map((s) => ({ ...s, extensionId: "core" })), GRADE];
  const stageRow = (rows: readonly PipelineRow[], id: string) => rowsOf(rows, "stage").find((r) => r.id === id);

  it("carry what the stage declares, who owns it and the floors in its GLSL", () => {
    expect(stageRow(describePipeline(registered(), V2_VARIANT, BUILTIN_RESOLVED), "acme.grade")).toEqual({
      kind: "stage",
      id: "acme.grade",
      name: "Grade",
      phase: "display-adjust",
      priority: 120,
      owner: "acme",
      space: { encoding: "perceptual" },
      domain: "display",
      reads: "source",
      maskable: true,
      floors: ["max(c, 0.0)"],
    });
  });

  it("carry the values the phase's stages see: none for geometry", () => {
    const domain = (phase: ProcessingPhase) =>
      stageRow(describePipeline([{ ...GRADE, phase }], V2_VARIANT, BUILTIN_RESOLVED), "acme.grade")?.domain;
    expect([domain("geometry"), domain("scene-linear"), domain("display-adjust")]).toEqual([null, "scene", "display"]);
  });

  // Extensions are plain JavaScript and the registry only warns about a phase
  // the table lacks (or one that is only an inherited property of it), so the
  // rows must survive it, with the domain the injector hands such a stage.
  for (const name of ["post-effects", "toString"]) {
    it(`give a stage naming the unlisted phase "${name}" the domain the injector gives it`, () => {
      const odd = { ...GRADE, id: "acme.odd", phase: name as ProcessingPhase };
      const rows = describePipeline([odd], V2_VARIANT, BUILTIN_RESOLVED);
      expect(stageRow(rows, "acme.odd")).toMatchObject({ phase: name, domain: "scene" });
      // The injector's own convert for the stage's declared space names the
      // domain it treated the stage in; the row must say the same.
      const converts = buildStageInjection([odd], V2_VARIANT).steps.filter(isConvert);
      expect(converts.length).toBeGreaterThan(0);
      expect(new Set(converts.map((s) => s.domain))).toEqual(new Set(["scene"]));
    });
  }

  it("give Safelight's own stages no owner and the default priority", () => {
    const rows = describePipeline(registered(), V2_VARIANT, BUILTIN_RESOLVED);
    expect(stageRow(rows, "core.vignette")).toMatchObject({ owner: null, space: null, maskable: false });
    expect(stageRow(rows, "builtin.denoise")).toMatchObject({ owner: null });
    expect(stageRow(describePipeline([{ ...GRADE, priority: undefined }], V2_VARIANT, BUILTIN_RESOLVED), "acme.grade"))
      .toMatchObject({ priority: 100 });
  });

  // Version 2 drops the clamp that closes the core Vignette and Grain helpers.
  it("scan a core stage's helpers as the version compiles them", () => {
    const floors = (variant: ShaderVariant) =>
      stageRow(describePipeline(builtinStages(), variant, BUILTIN_RESOLVED), "core.vignette")?.floors;
    expect(floors(V1_VARIANT)).toEqual(["clamp(c, 0.0, 1.0)"]);
    expect(floors(V2_VARIANT)).toEqual([]);
  });

  it("read the current image where the injector gives the stage a split exit", () => {
    const reads = (variant: ShaderVariant) =>
      Object.fromEntries(
        rowsOf(describePipeline(V2_IDENTITY_CONFIGS.splits.stages(), variant, BUILTIN_RESOLVED), "stage")
          .filter((r) => r.reads === "current")
          .map((r) => [r.id, r.reads]),
      );
    const readers = ["split.decode", "split.scene", "split.display", "split.effects"];
    expect(Object.keys(reads(V2_VARIANT)).sort()).toEqual(["builtin.denoise", ...readers].sort());
    expect(Object.keys(reads(V1_VARIANT)).sort()).toEqual([...readers].sort());
  });

  // The review's case: a legacy display stage's copies used to leave a clip row
  // each, under no stage.
  it("fold a stage's mask copies into its row, which notes the clip each copy makes", () => {
    const legacy = { ...GRADE, space: undefined };
    const rows = describePipeline(withCopies([legacy], V2_VARIANT), V2_VARIANT, BUILTIN_RESOLVED);
    const effects = rows.slice(rows.findIndex((r) => r.kind === "clamp" && r.reason === "legacy-display-stage"));
    expect(effects.map((r) => r.kind)).toEqual(["clamp", "stage", "clamp", "clamp", "output"]);
    expect(effects[1]).toMatchObject({
      id: "acme.grade",
      copies: 2,
      note: "Runs again inside 2 masks; each copy clips its input to [0, 1]",
    });
  });

  it("fold what the injector writes for each copy into the note: its passes' clip, its conversions", () => {
    const rows = describePipeline(withCopies(MASKED, V2_VARIANT), V2_VARIANT, BUILTIN_RESOLVED);
    expect(rowsOf(rows, "stage").map((r) => [r.id, r.copies])).toEqual([
      ["masked.wash", 2],
      ["masked.wide", 2],
      ["masked.glow", 2],
    ]);
    expect(stageRow(rows, "masked.wide")?.note).toBe(
      "Runs again inside 2 masks; each copy converts " +
        "linear/rec2020 → perceptual/rec709, perceptual/rec709 → linear/rec2020",
    );
    expect(stageRow(rows, "masked.glow")?.note).toBe(
      "Runs again inside 2 masks; each copy hands its passes values clipped to [0, 1], clips its input to [0, 1]",
    );
    const named = rowsOf(rows, "clamp").flatMap((r) => (r.reason === "legacy-display-stage" ? [r.stageId] : []));
    expect(named.filter((id) => id.includes("@"))).toEqual([]);
  });
});

describe("findFloors", () => {
  const stage = (glsl: string, helpers?: string): ProcessingStageContribution => ({
    id: "acme.film",
    name: "Film",
    phase: "scene-linear",
    glsl,
    ...(helpers ? { helpers } : {}),
    uniforms: [],
  });

  it("flags a floor on lin and a clip of c", () => {
    expect(findFloors(stage("lin = max(lin, 0.0);\nc = clamp(c, 0.0, 1.0);"))).toEqual([
      "max(lin, 0.0)",
      "clamp(c, 0.0, 1.0)",
    ]);
  });

  it("reads the helpers too, whatever the spacing", () => {
    const helpers = "vec3 film(vec3 lin) { return clamp( lin ,\n  vec3(0.0), vec3(max(1.0, 4.0))); }";
    expect(findFloors(stage("lin = film(lin);", helpers))).toEqual(["clamp( lin , vec3(0.0), vec3(max(1.0, 4.0)))"]);
    expect(findFloors(stage("lin = max(lin,vec3(0.0));"))).toEqual(["max(lin,vec3(0.0))"]);
  });

  // A constant floor drops every value under it, whatever the constant.
  it("flags any constant floor, however its literal is written", () => {
    const floors = [
      "max(lin, 1e-6)",
      "max(lin, 0.5)",
      "max(c, .0)",
      "max(c, 0.)",
      "max(c, 0)",
      "max(c, vec3(0.0, 0.0, 0.0))",
      "clamp(c, -1.0, 2.0)",
    ];
    expect(findFloors(stage(floors.map((f) => `c = ${f};`).join("\n")))).toEqual(floors);
  });

  it("doesn't flag another variable, a floor that isn't constant, or anything in a comment", () => {
    const glsl = [
      "float x = max(x, 0.0);",
      "lin = max(linear, 0.0);",
      "lin = max(lin, floorLevel);",
      "c = max(c, vec3(lo));",
      "// lin = max(lin, 0.0);",
      "/* c = clamp(c, 0.0, 1.0); */",
    ].join("\n");
    expect(findFloors(stage(glsl))).toEqual([]);
  });
});
