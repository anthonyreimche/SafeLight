// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dormant stages on the live renderer: a stage that declares `dormantWhen` is
// left out of a version 2 program while its values say it changes nothing, and
// joins it, for the rest of the session, the first time a photo needs it.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION, LEGACY_PROCESS_VERSION, defaultMaskAdjustments, type Mask } from "@/catalog/types";
import type { ProcessingStageContribution } from "@/extensions/types";
import { BUILTIN_DENOISE_ID, denoiseBag } from "./builtin-denoise";
import type { WebGLRenderer, WebGLRendererOpts } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  builtinStage,
  floatImage,
  glHarness,
  identityParams,
  masksStagesFor,
  pixelAt,
  trackGlObjects,
  withRenderer,
  worstDifference,
  type Frame,
} from "./webgl.test-support";

const GAIN_ID = "dormant-gain.test";
const SOURCE = floatImage(8, 8, (x, y) => [0.1 + x / 32, 0.15 + y / 40, 0.3]);

/** A gain that changes nothing at 1, run in Rec.2020 so the full set's frame
 *  takes a round trip the dormant one doesn't. */
const GAIN: ProcessingStageContribution = {
  id: GAIN_ID,
  name: "Gain",
  phase: "scene-linear",
  glsl: "lin *= gain;",
  uniforms: [{ key: "gain", glslType: "float", default: 1 }],
  space: { encoding: "linear", primaries: "rec2020" },
  mask: { maskable: true },
  dormantWhen: { gain: 1 },
};
const gain = (value: number) => ({ [`${GAIN_ID}.gain`]: value });

const LIVE: WebGLRendererOpts = { skipDormantStages: true, pipeline: LINEAR_PROBE_PIPELINE };
const v2 = (over: Parameters<typeof identityParams>[0] = {}) =>
  identityParams({ processVersion: CURRENT_PROCESS_VERSION, ...over });

function capture(r: WebGLRenderer): Frame {
  const frame = r.captureFloatFrame();
  if (!frame) throw new Error("captureFloatFrame returned null");
  return frame;
}

/** The fragment sources the context compiles while `fn` runs. */
function fragmentSources(fn: () => void): string[] {
  const { gl } = glHarness();
  const sources: string[] = [];
  const shaderSource = gl.shaderSource;
  gl.shaderSource = (shader, source) => {
    sources.push(source);
    shaderSource.call(gl, shader, source);
  };
  try {
    fn();
  } finally {
    gl.shaderSource = shaderSource;
  }
  return sources;
}

/** The develop program's fragment source for a `processVersion` frame. */
function developSource(opts: WebGLRendererOpts, processVersion: number): string {
  const sources = fragmentSources(() =>
    withRenderer({ stages: [GAIN], ...opts }, (r) => {
      r.setImage(SOURCE);
      r.setParams(v2({ processVersion }));
      r.render();
    }),
  );
  const develop = sources.filter((s) => s.includes(`#define SL_PROCESS_VERSION ${processVersion}\n`));
  expect(develop).toHaveLength(1);
  return develop[0];
}

describe("a dormant stage on the live renderer", () => {
  it("leaves a version 2 frame within one half-float step of the full set's", () => {
    const dormant = withRenderer({ stages: [GAIN], ...LIVE }, (r) => {
      r.setImage(SOURCE);
      r.setParams(v2());
      const frame = capture(r);
      expect(r.dormantStages).toEqual([GAIN_ID]);
      return frame;
    });
    const full = withRenderer({ stages: [GAIN], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setImage(SOURCE);
      r.setParams(v2());
      return capture(r);
    });
    expect(worstDifference(dormant, full)).toBeLessThanOrEqual(2 ** -11);
  });

  it("leaves the version 1 program's text as the full set's", () => {
    const full = { pipeline: LINEAR_PROBE_PIPELINE };
    expect(developSource(LIVE, CURRENT_PROCESS_VERSION)).not.toBe(developSource(full, CURRENT_PROCESS_VERSION));
    expect(developSource(LIVE, LEGACY_PROCESS_VERSION)).toBe(developSource(full, LEGACY_PROCESS_VERSION));
  });

  it("builds no new program when it registers", () => {
    const { canvas, gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      withRenderer(
        { stages: [], ...LIVE },
        (r) => {
          r.setImage(SOURCE);
          r.setParams(v2());
          r.render();
          const built = tally.created.program;

          r.setStages([GAIN]);
          r.render();

          expect(tally.created.program).toBe(built);
          expect(r.dormantStages).toEqual([GAIN_ID]);
        },
        canvas,
      );
    } finally {
      tally.restore();
    }
  });

  it("keeps the denoise prepass result when it wakes", () => {
    const { canvas, gl } = glHarness();
    const tally = trackGlObjects(gl);
    const params = v2({ colorNR: 25 });
    try {
      withRenderer(
        { stages: [builtinStage(BUILTIN_DENOISE_ID), GAIN], ...LIVE },
        (r) => {
          r.setImage(SOURCE);
          r.setParams(params);
          r.setContributedParams(denoiseBag(params));
          r.render();
          const passes = r.renderDrawCounts.pass;
          const built = tally.created.program;
          expect(passes).toBeGreaterThan(0);

          r.setContributedParams({ ...denoiseBag(params), ...gain(2) });
          r.render();

          expect(r.dormantStages).toEqual([]);
          expect(tally.created.program).toBeGreaterThan(built);
          expect(r.renderDrawCounts.pass).toBe(passes);
        },
        canvas,
      );
    } finally {
      tally.restore();
    }
  });

  it("stays awake on later frames that need it no more", () => {
    withRenderer({ stages: [GAIN], ...LIVE }, (r) => {
      r.setImage(SOURCE);
      r.setParams(v2());
      r.setContributedParams(gain(2));
      r.render();
      r.setContributedParams(gain(1));
      r.render();
      expect(r.dormantStages).toEqual([]);
    });
  });

  it("is in every frame of a renderer that doesn't skip dormant stages", () => {
    withRenderer({ stages: [GAIN], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setImage(SOURCE);
      r.setParams(v2());
      r.render();
      expect(r.dormantStages).toEqual([]);
    });
  });
});

const THREE = ["a", "b", "c"].map((name): ProcessingStageContribution => ({ ...GAIN, id: `dormant-${name}.test` }));
const [A, B, C] = THREE.map((stage) => stage.id);
const TOGETHER: WebGLRendererOpts = { ...LIVE, wakeTogether: true };
const gains = (byId: Record<string, number>) =>
  Object.fromEntries(Object.entries(byId).map(([id, value]) => [`${id}.gain`, value]));

// The thumbnail renderer's policy: the stages it is handed, or all of them.
describe("a renderer that wakes its stages together", () => {
  const frame = (r: WebGLRenderer, byId: Record<string, number>) => {
    r.setImage(SOURCE);
    r.setParams(v2());
    r.setContributedParams(gains(byId));
    r.render();
  };

  it("says which stages its frames have needed", () => {
    withRenderer({ stages: THREE, ...LIVE }, (r) => {
      frame(r, { [B]: 2 });
      expect(r.awakeStages).toEqual([B]);
    });
  });

  it("leaves out what it wasn't handed while a frame needs only what it was", () => {
    withRenderer({ stages: THREE, ...TOGETHER }, (r) => {
      r.wakeStages([A]);
      frame(r, { [A]: 2 });
      expect(r.dormantStages).toEqual([B, C]);
    });
  });

  it("puts every stage in when a frame needs one it wasn't handed, and keeps them in", () => {
    withRenderer({ stages: THREE, ...TOGETHER }, (r) => {
      r.wakeStages([A]);
      frame(r, { [B]: 2 });
      expect(r.dormantStages).toEqual([]);
      frame(r, {});
      expect(r.dormantStages).toEqual([]);
    });
  });

  it("puts every stage in when told to", () => {
    withRenderer({ stages: THREE, ...TOGETHER }, (r) => {
      r.wakeAllStages();
      frame(r, {});
      expect(r.dormantStages).toEqual([]);
    });
  });

  // The same text is what lets the graphics driver's program cache answer the
  // thumbnail renderer's build, instead of compiling every stage beside the live view.
  it.each([true, false])("builds the live view's program text once handed its awake stages (high bit depth %s)", (highBitDepth) => {
    const developText = (opts: WebGLRendererOpts, handed: readonly string[] | null) => {
      let awake: readonly string[] = [];
      const sources = fragmentSources(() =>
        withRenderer({ stages: THREE, ...opts }, (r) => {
          if (handed) r.wakeStages(handed);
          frame(r, { [A]: 2 });
          awake = r.awakeStages;
        }),
      );
      const develop = sources.filter((s) => s.includes(`#define SL_PROCESS_VERSION ${CURRENT_PROCESS_VERSION}\n`));
      expect(develop).toHaveLength(1);
      return { text: develop[0], awake };
    };
    const live = developText({ ...LIVE, highBitDepth }, null);
    const thumbnail = developText({ ...TOGETHER, highBitDepth: false }, live.awake);
    expect(live.awake).toEqual([A]);
    expect(thumbnail.text).toBe(live.text);
    expect(thumbnail.text).not.toBe(developText({ pipeline: LINEAR_PROBE_PIPELINE, highBitDepth: false }, null).text);
  });

  it("leaves them out again once the stages change", () => {
    withRenderer({ stages: THREE, ...TOGETHER }, (r) => {
      r.wakeAllStages();
      frame(r, {});
      r.setStages([...THREE]);
      frame(r, {});
      expect(r.dormantStages).toEqual([A, B, C]);
    });
  });
});

describe("a dormant stage's mask copies", () => {
  // Columns 0-3 sit left of the mask's step at u = 0.5, columns 4-7 right of it.
  const OUTSIDE = 1;
  const INSIDE = 6;
  const FLAT = floatImage(8, 8, () => [0.1, 0.1, 0.1]);

  const rightHalf = (bag: Record<string, unknown>): Mask => ({
    id: "m",
    name: "m",
    visible: true,
    invert: false,
    opacity: 100,
    adj: defaultMaskAdjustments(),
    panels: [],
    components: [
      { id: "right", kind: "linear", mode: "add", invert: false, linear: { x0: 0.5, y0: 0, x1: 0.5001, y1: 0 } },
    ],
    bag,
  });

  const red = (r: WebGLRenderer, x: number): number => pixelAt(capture(r), x, 4)[0];

  it("renders an active copy of a parent that is dormant on the photo", () => {
    const masking = masksStagesFor(CURRENT_PROCESS_VERSION);
    const plain = withRenderer({ stages: masking, ...LIVE }, (r) => {
      r.setImage(FLAT);
      r.setParams(v2());
      return { outside: red(r, OUTSIDE), inside: red(r, INSIDE) };
    });
    withRenderer({ stages: [...masking, GAIN], ...LIVE }, (r) => {
      r.setImage(FLAT);
      r.setParams(v2({ masks: [rightHalf(gain(1))] }));
      r.render();
      expect(r.dormantStages).toEqual([GAIN_ID, `${GAIN_ID}@0`]);

      r.setParams(v2({ masks: [rightHalf(gain(2))] }));
      expect(red(r, OUTSIDE)).toBeCloseTo(plain.outside, 3);
      expect(red(r, INSIDE)).toBeCloseTo(2 * plain.inside, 3);
    });
  });
});

// The window hints at a stage about to be needed (its panel opened or hovered,
// its control focused), so the program it will need compiles while the user
// reaches for the slider, not in the middle of the drag.
describe("a prewarm hint", () => {
  function withTally(fn: (r: WebGLRenderer, built: () => number) => void, opts: WebGLRendererOpts = LIVE): void {
    const { canvas, gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      withRenderer(
        { stages: [GAIN], ...opts },
        (r) => {
          r.setImage(SOURCE);
          r.setParams(v2());
          r.render();
          fn(r, () => tally.created.program);
        },
        canvas,
      );
    } finally {
      tally.restore();
    }
  }

  it("compiles the program the hinted stage will need, which waking it then uses", () => {
    withTally((r, built) => {
      const before = built();
      r.prewarmStages([GAIN_ID]);
      expect(built()).toBe(before + 1);

      r.setContributedParams(gain(2));
      r.render();

      expect(r.dormantStages).toEqual([]);
      expect(built()).toBe(before + 1);
    });
  });

  it("wakes the stages hinted together together, so waking one uses the hinted program", () => {
    const second: ProcessingStageContribution = { ...GAIN, id: "dormant-gain-2.test" };
    const { canvas, gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      withRenderer(
        { stages: [GAIN, second], ...LIVE },
        (r) => {
          r.setImage(SOURCE);
          r.setParams(v2());
          r.render();
          const before = tally.created.program;
          r.prewarmStages([GAIN_ID, second.id]);
          expect(tally.created.program).toBe(before + 1);

          r.setContributedParams(gain(2));
          r.render();

          expect(r.dormantStages).toEqual([]);
          expect(tally.created.program).toBe(before + 1);
        },
        canvas,
      );
    } finally {
      tally.restore();
    }
  });

  it("leaves the frame as it was until the stage is needed", () => {
    withTally((r) => {
      const idle = capture(r);
      r.prewarmStages([GAIN_ID]);
      expect(worstDifference(capture(r), idle)).toBe(0);
      expect(r.dormantStages).toEqual([GAIN_ID]);
    });
  });

  it("draws the woken stage with the hinted program", () => {
    const woken = (hint: boolean): Frame => {
      let frame: Frame | null = null;
      withTally((r) => {
        if (hint) r.prewarmStages([GAIN_ID]);
        r.setContributedParams(gain(2));
        frame = capture(r);
      });
      if (!frame) throw new Error("no frame");
      return frame;
    };
    const unhinted = woken(false);
    expect(worstDifference(woken(true), unhinted)).toBe(0);
  });

  it.each([
    ["a stage that is awake", LIVE, () => [GAIN_ID], gain(2)],
    ["an id no stage has", LIVE, () => ["acme.unknown"], {}],
    ["a renderer that doesn't skip dormant stages", { pipeline: LINEAR_PROBE_PIPELINE }, () => [GAIN_ID], {}],
  ])("builds nothing for %s", (_, opts, ids, bag) => {
    withTally((r, built) => {
      r.setContributedParams(bag);
      r.render();
      const before = built();
      r.prewarmStages(ids());
      expect(built()).toBe(before);
    }, opts);
  });
});
