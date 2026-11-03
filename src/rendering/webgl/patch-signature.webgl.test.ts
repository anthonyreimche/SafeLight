// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The patch-source signature is asked for on every draw. With the edit unchanged it
// answers from the last frame instead of serialising every uniform of the stages that
// patch the source again.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrushDab, RetouchSpot } from "@/catalog/types";
import type { WebGLRenderer } from "./renderer";
import { LINEAR_PROBE_PIPELINE, floatImage, healStages, identityParams, withRenderer } from "./webgl.test-support";

interface PatchProbe {
  frameBag(): Record<string, unknown>;
  patchOf(bag: Record<string, unknown>): { active: boolean; sig: string };
}

const probeOf = (renderer: WebGLRenderer): PatchProbe => renderer as unknown as PatchProbe;

const dabs = (count: number): BrushDab[] =>
  Array.from({ length: count }, (_, i) => ({ x: 0.1 + (i % 50) / 100, y: 0.2 + Math.floor(i / 50) / 10, radius: 0.02, erase: false, feather: 0.5 }));

const stroke = (count: number): RetouchSpot => ({
  id: "stroke",
  shape: "brush",
  mode: "heal",
  visible: true,
  dstX: 0.5,
  dstY: 0.5,
  srcX: 0.7,
  srcY: 0.5,
  radius: 0.02,
  feather: 50,
  opacity: 100,
  dabs: dabs(count),
});

const OPTS = { stages: healStages(), pipeline: LINEAR_PROBE_PIPELINE };

afterEach(() => vi.restoreAllMocks());

describe("the signature of the stages that patch the source", () => {
  it("reads the same on every draw of one edit, without serialising the stages' values again", () => {
    withRenderer(OPTS, (renderer) => {
      renderer.setImage(floatImage(8, 8, () => [0.5, 0.5, 0.5]));
      renderer.setParams(identityParams({ retouch: [stroke(200)] }));
      const probe = probeOf(renderer);
      const bag = probe.frameBag();
      const first = probe.patchOf(bag);
      expect(first.active).toBe(true);

      const stringify = vi.spyOn(JSON, "stringify");
      const again = probe.patchOf(bag);

      expect(again).toEqual(first);
      expect(stringify).not.toHaveBeenCalled();
    });
  });

  it("changes when a value in the bag changes", () => {
    withRenderer(OPTS, (renderer) => {
      renderer.setImage(floatImage(8, 8, () => [0.5, 0.5, 0.5]));
      const probe = probeOf(renderer);
      renderer.setParams(identityParams({ retouch: [stroke(200)] }));
      const before = probe.patchOf(probe.frameBag());
      renderer.setParams(identityParams({ retouch: [{ ...stroke(200), srcX: 0.6 }] }));
      const after = probe.patchOf(probe.frameBag());

      expect(after.sig).not.toBe(before.sig);
    });
  });
});
