// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Opening a panel is the hint that its extension's stages are about to be
// needed: the renderer starts building their program before a slider moves.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDockStore } from "./store";
import { useRegistry, type RegisteredPanel, type RegisteredProcessingStage } from "../registry";
import { initStagePrewarm, prewarmPanel } from "./prewarm";

const panel = (id: string, extensionId: string) => ({ id, extensionId }) as RegisteredPanel;
const stage = (id: string, extensionId: string) => ({ id, extensionId }) as RegisteredProcessingStage;

let stop: () => void = () => {};
const hint = vi.fn<(stageIds: string[]) => void>();

beforeEach(() => {
  hint.mockClear();
  useRegistry.setState({
    panels: { "acme.grain": panel("acme.grain", "acme"), "acme.info": panel("acme.info", "other") },
    processingStages: {
      "acme.grain": stage("acme.grain", "acme"),
      "acme.halo": stage("acme.halo", "acme"),
      "beta.tone": stage("beta.tone", "beta"),
    },
  });
  useDockStore.setState({ collapsed: { "acme.grain": true, "acme.info": true } });
  stop = initStagePrewarm(hint);
});

afterEach(() => stop());

describe("stage prewarm", () => {
  it("hints the stages of the extension whose panel opens", () => {
    useDockStore.setState({ collapsed: { "acme.grain": false, "acme.info": true } });

    expect(hint).toHaveBeenCalledTimes(1);
    expect(hint.mock.calls[0][0].sort()).toEqual(["acme.grain", "acme.halo"]);
  });

  it("hints nothing when a panel closes, or opens with no stages behind it", () => {
    useDockStore.setState({ collapsed: { "acme.grain": true, "acme.info": false } });
    useDockStore.setState({ collapsed: { "acme.grain": true, "acme.info": true } });

    expect(hint).not.toHaveBeenCalled();
  });

  it("hints on hover, once per panel until another is hovered", () => {
    prewarmPanel("acme.grain", hint);
    prewarmPanel("acme.grain", hint);

    expect(hint).toHaveBeenCalledTimes(1);
    expect(hint.mock.calls[0][0].sort()).toEqual(["acme.grain", "acme.halo"]);
  });
});
