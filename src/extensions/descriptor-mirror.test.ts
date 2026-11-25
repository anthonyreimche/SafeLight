// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeMirrorBridge } from "./types";
import type { ExtensionDescriptors } from "@/state/shared-settings";
import {
  registerCatalogHooks,
  registerPanel,
  registerProcessingStage,
  unregisterExtension,
} from "./registry";
import { mirrorExtensionDescriptors } from "./descriptor-mirror";

let mirror: NativeMirrorBridge | null = null;
vi.mock("@/native/privileged", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/native/privileged")>()),
  privilegedMirror: () => mirror,
}));

const ID = "acme.film";
let writeDescriptors: ReturnType<typeof vi.fn<(doc: ExtensionDescriptors) => Promise<void>>>;

function registerFixture(): void {
  registerProcessingStage(ID, {
    id: "acme.film.grain",
    name: "Grain",
    phase: "effects",
    priority: 40,
    after: ["acme.film.halation"],
    glsl: "c.rgb += vec3(uAmount);",
    uniforms: [
      { key: "amount", glslType: "float", default: 0.25, range: { min: 0, max: 1, step: 0.01 }, label: "Amount" },
      { key: "mono", glslType: "bool", default: false },
      { key: "gains", glslType: "float", length: 3, default: [0, 0, 0] },
    ],
  });
  registerPanel(ID, { id: "acme.film.panel", title: "Film", component: () => null, owns: ["exposure"] });
  registerCatalogHooks(ID, { id: "acme.film.hooks", onPhotoImport: async () => {} });
}

beforeEach(() => {
  writeDescriptors = vi.fn(async () => {});
  mirror = { writeDescriptors };
});

afterEach(() => {
  unregisterExtension(ID);
  unregisterExtension("acme.other");
});

describe("mirrorExtensionDescriptors", () => {
  it("writes what the extension registered: stages, uniforms with range and label, panels with owns, catalogue hooks", () => {
    registerFixture();
    mirrorExtensionDescriptors(ID, "1.0.0", "Film");
    expect(writeDescriptors).toHaveBeenCalledOnce();
    const doc = writeDescriptors.mock.calls[0][0];
    expect(doc).toMatchObject({
      version: 1,
      id: ID,
      extVersion: "1.0.0",
      name: "Film",
      stages: [{ id: "acme.film.grain", phase: "effects", priority: 40, after: ["acme.film.halation"] }],
      uniforms: [
        {
          key: "acme.film.grain.amount",
          glslType: "float",
          default: 0.25,
          range: { min: 0, max: 1, step: 0.01 },
          label: "Amount",
        },
        { key: "acme.film.grain.mono", glslType: "bool", default: false },
        { key: "acme.film.grain.gains", glslType: "float", length: 3, default: [0, 0, 0] },
      ],
      panels: [{ id: "acme.film.panel", title: "Film", owns: ["exposure"] }],
      hasCatalogHooks: true,
    });
    expect(typeof doc.writtenAt).toBe("number");
  });

  it("names the uniforms the extension computes for each photo, inline and in passes", () => {
    registerProcessingStage(ID, {
      id: "acme.film.lens",
      name: "Lens",
      phase: "scene-linear",
      glsl: "c.rgb *= 1.0 + k1;",
      uniforms: [
        { key: "k1", glslType: "float", default: 0, computed: true },
        { key: "amount", glslType: "float", default: 0 },
      ],
      passes: [
        {
          uniforms: [{ key: "k2", glslType: "float", default: 0, computed: true }],
          glsl: "vec3 c = readPrev(vUv) * (1.0 + k2);",
        },
      ],
    });
    mirrorExtensionDescriptors(ID, "1.0.1", "Film");
    expect(writeDescriptors.mock.calls[0][0].computed).toEqual(["acme.film.lens.k1", "acme.film.lens.k2"]);
  });

  it("leaves out what other extensions registered", () => {
    registerFixture();
    registerPanel("acme.other", { id: "acme.other.panel", title: "Other", component: () => null });
    mirrorExtensionDescriptors("acme.other", "2.0.0", "Other");
    const doc = writeDescriptors.mock.calls[0][0];
    expect(doc).toMatchObject({ stages: [], uniforms: [], hasCatalogHooks: false });
    expect(doc.panels).toEqual([{ id: "acme.other.panel", title: "Other" }]);
  });

  it("writes once per id and version in a session", () => {
    registerFixture();
    mirrorExtensionDescriptors(ID, "1.1.0", "Film");
    mirrorExtensionDescriptors(ID, "1.1.0", "Film");
    expect(writeDescriptors).toHaveBeenCalledOnce();
    mirrorExtensionDescriptors(ID, "1.2.0", "Film");
    expect(writeDescriptors).toHaveBeenCalledTimes(2);
  });

  it("never throws when the write fails or there is no bridge", async () => {
    registerFixture();
    writeDescriptors.mockRejectedValue(new Error("disk full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => mirrorExtensionDescriptors(ID, "1.3.0", "Film")).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    writeDescriptors.mockImplementation(() => {
      throw new Error("sync failure");
    });
    expect(() => mirrorExtensionDescriptors(ID, "1.4.0", "Film")).not.toThrow();
    mirror = null;
    expect(() => mirrorExtensionDescriptors(ID, "1.5.0", "Film")).not.toThrow();
    warn.mockRestore();
  });
});
