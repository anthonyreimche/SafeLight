// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A preset carries a display transform's settings with its Display transform
// field, and the field is pre-selected once the photo has a pick or one of
// those settings has moved, so a preset made of a tuned look keeps it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { normalizeParams } from "@/catalog/types";
import { DEFAULT_PIPELINE, usePipelineStore } from "@/extensions/pipelines";
import { registerPipeline, unregisterExtension, useRegistry } from "@/extensions/registry";
import { PresetSaveDialog } from "./PresetSaveDialog";

type Saved = Parameters<Parameters<typeof PresetSaveDialog>[0]["onSave"]>[0];

function setup(params: Parameters<typeof normalizeParams>[0], paramBag: Record<string, unknown>) {
  const onSave = vi.fn<(result: Saved) => void>();
  render(
    <PresetSaveDialog
      params={normalizeParams(params)}
      paramBag={paramBag}
      groups={[]}
      onSave={onSave}
      onCancel={() => {}}
    />,
  );
  return { onSave, user: userEvent.setup() };
}

async function save(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByRole("textbox", { name: "Preset name" }), "Tuned look");
  await user.click(screen.getByRole("button", { name: "Save preset" }));
}

describe("a display transform with settings", () => {
  beforeEach(() => {
    useRegistry.setState({ pipelines: {} });
    registerPipeline("test", {
      id: "test.tuned",
      name: "Tuned",
      glsl: "vec3 pipelineToDisplay(vec3 lin) { return gain * lin; }",
      params: [{ key: "gain", glslType: "float", default: 1 }],
    });
  });

  afterEach(() => {
    unregisterExtension("test");
    usePipelineStore.setState({ activeId: DEFAULT_PIPELINE });
  });

  const BAG = { "test.tuned.gain": 2, "other.stage.x": 1 };

  it("saves the picked transform's settings with the pick", async () => {
    const { onSave, user } = setup({ displayTransform: "test.tuned" }, BAG);
    await save(user);
    expect(onSave.mock.calls[0][0].params).toEqual({ displayTransform: "test.tuned" });
    expect(onSave.mock.calls[0][0].paramBag).toEqual({ "test.tuned.gain": 2 });
  });

  it("saves a setting the photo never moved as its default, so the preset resets a tuned photo", async () => {
    const { onSave, user } = setup({ displayTransform: "test.tuned" }, { "other.stage.x": 1 });
    await save(user);
    const saved = JSON.parse(JSON.stringify(onSave.mock.calls[0][0].paramBag));
    expect(saved).toEqual({ "test.tuned.gain": 1 });
    expect({ "test.tuned.gain": 3, ...saved }).toEqual({ "test.tuned.gain": 1 });
  });

  it("pre-selects the field for a photo without a pick once a setting of the default transform moved", async () => {
    usePipelineStore.setState({ activeId: "test.tuned" });
    const { onSave, user } = setup({}, BAG);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /^Display transform/ }).checked).toBe(true);
    await save(user);
    expect(onSave.mock.calls[0][0].params).toEqual({ displayTransform: null });
    expect(onSave.mock.calls[0][0].paramBag).toEqual({ "test.tuned.gain": 2 });
  });
});
