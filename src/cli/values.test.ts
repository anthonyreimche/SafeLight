import { describe, expect, it } from "vitest";
import { freshParams } from "@/catalog/types";
import type { ExtensionDescriptors } from "@/state/shared-settings";
import { createValueService } from "./values";
import { CliError, type Assignment, type InstalledExtension, type Look } from "./types";

const assign = (raw: string): Assignment => {
  const m = /^(.+?)(\+=|-=|=)(.*)$/.exec(raw);
  if (!m) throw new Error(raw);
  return { raw, key: m[1], op: m[2] as Assignment["op"], value: m[3] };
};

const localContrast: ExtensionDescriptors = {
  version: 1,
  id: "local-contrast",
  extVersion: "1.0.0",
  name: "Local Contrast",
  writtenAt: 0,
  stages: [{ id: "local-contrast.lightness", phase: "display-adjust", priority: 10 }],
  uniforms: [
    { key: "local-contrast.lightness.detail", glslType: "float", default: 1, range: { min: 0.25, max: 4, step: 0.05 }, label: "Detail" },
    { key: "local-contrast.lightness.on", glslType: "bool", default: false },
    { key: "local-contrast.lightness.tint", glslType: "vec3", default: [0, 0, 0] },
  ],
  panels: [],
  hasCatalogHooks: true,
};
const installed: InstalledExtension[] = [
  { id: "local-contrast", name: "Local Contrast", version: "1.0.0", enabled: true, trust: "official", repo: null },
  { id: "retinex", name: "Retinex", version: "1.2.0", enabled: true, trust: "official", repo: null },
];

const service = () => createValueService(new Map([["local-contrast", localContrast]]), installed, []);
const look = (asShot = 5500): Look => ({ params: freshParams(asShot), paramBag: {} });
const apply = (l: Look, raw: string[], strict = false) =>
  service().apply(l, raw.map(assign), { asShot: 5500, strict });

describe("tools", () => {
  it("lists core tools in pipeline order, then extensions with their flags", () => {
    const tools = service().tools();
    const ids = tools.map((t) => t.id);
    expect(ids.indexOf("safelight.crop")).toBeLessThan(ids.indexOf("safelight.basic"));
    expect(ids.indexOf("safelight.basic")).toBeLessThan(ids.indexOf("local-contrast"));
    expect(tools.find((t) => t.id === "local-contrast")).toMatchObject({ kind: "extension", settable: false, hasCommitHooks: true });
    expect(tools.find((t) => t.id === "safelight.basic")).toMatchObject({ kind: "core", settable: true });
    expect(tools.find((t) => t.id === "safelight.tone-curve")).toMatchObject({ settable: false });
  });

  it("finds a tool by id, short id, or name, and suggests on a typo", () => {
    const s = service();
    expect(s.tool("safelight.basic").id).toBe("safelight.basic");
    expect(s.tool("white-balance").id).toBe("safelight.white-balance");
    expect(s.tool("Colour Grading").id).toBe("safelight.color-grading");
    expect(s.tool("retinex").id).toBe("retinex");
    expect(() => s.tool("basik")).toThrow(expect.objectContaining({ hint: expect.stringContaining('Did you mean "basic"') }));
  });

  it("marks a disabled tool off", () => {
    const s = createValueService(new Map(), installed, ["retinex", "safelight.hsl"]);
    expect(s.tool("retinex").enabled).toBe(false);
    expect(s.tool("hsl").enabled).toBe(false);
  });
});

describe("resolveKey", () => {
  it("ignores case and takes colour for color", () => {
    const s = service();
    expect(s.resolveKey("Exposure").key).toBe("exposure");
    expect(s.resolveKey("colourNR").key).toBe("colorNR");
    expect(s.resolveKey("grain.colour").key).toBe("grain.color");
    expect(s.resolveKey("colourGrading.shadows.hue").key).toBe("colorGrading.shadows.hue");
  });

  it("takes an extension's full key and its shorthand when unique", () => {
    const s = service();
    expect(s.resolveKey("local-contrast.lightness.detail").tool.id).toBe("local-contrast");
    expect(s.resolveKey("local-contrast.detail").key).toBe("local-contrast.lightness.detail");
  });

  it("suggests a close key and refuses a stranger", () => {
    const s = service();
    try {
      s.resolveKey("exposur");
      throw new Error("no throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).hint).toMatch(/Did you mean "exposure"/);
    }
    expect(() => s.resolveKey("zzzzzzzz")).toThrow(/No value called/);
  });

  it("answers a read-only key with its reason", () => {
    const info = service().resolveKey("toneCurve");
    expect(info.settable).toBe(false);
    expect(info.notSettableReason).toBe("Edit Tone Curve's points in Safelight; slu can't set them yet.");
    expect(service().resolveKey("crop.x").settable).toBe(false);
  });

  it("lists scalar extension uniforms with their ranges and skips vectors", () => {
    const keys = service().values("local-contrast").map((v) => v.key);
    expect(keys).toEqual(["local-contrast.lightness.detail", "local-contrast.lightness.on"]);
    expect(service().resolveKey("local-contrast.lightness.detail")).toMatchObject({ min: 0.25, max: 4, step: 0.05, decimals: 2 });
  });
});

describe("apply", () => {
  it("sets absolute values, with or without a plus sign", () => {
    expect(apply(look(), ["exposure=0.5"]).look.params.exposure).toBe(0.5);
    expect(apply(look(), ["exposure=+0.5"]).look.params.exposure).toBe(0.5);
    expect(apply(look(), ["exposure=-0.5"]).look.params.exposure).toBe(-0.5);
  });

  it("changes relatively with += and -=", () => {
    const start = apply(look(), ["contrast=10"]).look;
    expect(apply(start, ["contrast+=5"]).look.params.contrast).toBe(15);
    expect(apply(start, ["contrast-=30"]).look.params.contrast).toBe(-20);
    expect(apply(look(), ["exposure+=0.1", "exposure+=0.2"]).look.params.exposure).toBe(0.3);
  });

  it("accepts the value's own unit and refuses another", () => {
    expect(apply(look(), ["temperature=5600K"]).look.params.temperature).toBe(5600);
    expect(apply(look(), ["exposure=+0.7EV"]).look.params.exposure).toBe(0.7);
    expect(apply(look(), ["straighten=-1.2°"]).look.params.straighten).toBe(-1.2);
    expect(() => apply(look(), ["exposure=1K"])).toThrow(/EV/);
    expect(() => apply(look(), ["contrast=1EV"])).toThrow(/no unit/);
    expect(() => apply(look(), ["exposure=abc"])).toThrow(/not a number/);
  });

  it("sends temperature=default to the as-shot value and displayTransform=default to null", () => {
    const warm = apply(look(), ["temperature=7000"]).look;
    expect(apply(warm, ["temperature=default"]).look.params.temperature).toBe(5500);
    const mapped = apply(look(), ["displayTransform=agx"]).look;
    expect(mapped.params.displayTransform).toBe("agx");
    expect(apply(mapped, ["displayTransform=default"]).look.params.displayTransform).toBeNull();
  });

  it("writes a nested key and leaves the input look alone", () => {
    const start = look();
    const result = apply(start, ["hsl.saturation.blue=-40", "vignette.amount=-20"]);
    expect(result.look.params.hsl.saturation.blue).toBe(-40);
    expect(result.look.params.vignette.amount).toBe(-20);
    expect(start.params.hsl.saturation.blue).toBe(0);
  });

  it("takes switches and choices", () => {
    const flipped = apply(look(), ["transform.flipH=on", "uprightMode=Auto"]).look.params;
    expect(flipped.transform.flipH).toBe(true);
    expect(flipped.uprightMode).toBe("auto");
    expect(apply(look(), ["transform.flipV=0"]).look.params.transform.flipV).toBe(false);
    expect(() => apply(look(), ["transform.flipH=maybe"])).toThrow(/on or off/);
    expect(() => apply(look(), ["uprightMode=guided"])).toThrow(/one of/);
  });

  it("clamps with a note, or refuses under strict", () => {
    const result = apply(look(), ["exposure=9"]);
    expect(result.look.params.exposure).toBe(5);
    expect(result.changes[0].clamped).toEqual({ requested: 9, limit: 5 });
    expect(() => apply(look(), ["exposure=9"], true)).toThrow(/range/);
    expect(apply(look(), ["sharpening=150"]).look.params.sharpening).toBe(150);
  });

  it("reports before and after and labels the step with the changed values", () => {
    const result = apply(look(), ["exposure=1", "contrast=0", "vignette.amount=-10", "exposure+=0.5"]);
    expect(result.changes[0]).toMatchObject({ before: 0, after: 1 });
    expect(result.label).toBe("Exposure, Vignette Amount");
    expect(apply(look(), ["temperature=6000"]).label).toBe("Temperature");
  });

  it("refuses an extension value with the tool's reason, and a read-only core value", () => {
    expect(() => apply(look(), ["local-contrast.detail=1.2"])).toThrow("Local Contrast doesn't support slu yet. Set it in Safelight.");
    expect(() => apply(look(), ["toneCurve=1"])).toThrow("Edit Tone Curve's points in Safelight; slu can't set them yet.");
  });
});

describe("read and isDefault", () => {
  it("reads core values and falls back to an extension uniform's default", () => {
    const s = service();
    const l = apply(look(), ["exposure=1"]).look;
    expect(s.read(l, s.resolveKey("exposure"))).toBe(1);
    expect(s.read(l, s.resolveKey("local-contrast.detail"))).toBe(1);
    const withBag = { ...l, paramBag: { "local-contrast.lightness.detail": 2 } };
    expect(s.read(withBag, s.resolveKey("local-contrast.detail"))).toBe(2);
  });

  it("calls temperature default at the as-shot value", () => {
    const s = service();
    const info = s.resolveKey("temperature");
    expect(s.isDefault(look(5500), info, 5500)).toBe(true);
    expect(s.isDefault(look(5500), info, 4000)).toBe(false);
  });
});

describe("resets", () => {
  it("resets a core tool to its defaults, as-shot for temperature", () => {
    const s = service();
    const edited = apply(look(), ["temperature=7000", "tint=20", "exposure=1"]).look;
    const reset = s.resetTool(edited, "white-balance", 5500);
    expect(reset.params.temperature).toBe(5500);
    expect(reset.params.tint).toBe(0);
    expect(reset.params.exposure).toBe(1);
  });

  it("removes only an extension tool's bag keys", () => {
    const s = service();
    const l: Look = { params: freshParams(5500), paramBag: { "local-contrast.lightness.detail": 2, "retinex.main.gain": 3 } };
    expect(s.resetTool(l, "local-contrast", 5500).paramBag).toEqual({ "retinex.main.gain": 3 });
  });

  it("resets named keys, core and extension", () => {
    const s = service();
    const l: Look = {
      params: apply(look(), ["exposure=1", "contrast=5"]).look.params,
      paramBag: { "local-contrast.lightness.detail": 2 },
    };
    const reset = s.resetKeys(l, ["exposure", "local-contrast.detail"], 5500);
    expect(reset.params.exposure).toBe(0);
    expect(reset.params.contrast).toBe(5);
    expect(reset.paramBag).toEqual({});
    expect(() => s.resetKeys(l, ["toneCurve"], 5500)).toThrow(/Tone Curve/);
  });

  it("resets everything slu can set and keeps what it can't", () => {
    const s = service();
    const base = apply(look(), ["exposure=1", "hsl.hue.red=10", "displayTransform=agx"]).look;
    const l: Look = {
      params: { ...base.params, retouch: [{ x: 1 } as never] },
      paramBag: { "local-contrast.lightness.detail": 2, "unknown.key": 1 },
    };
    const reset = s.resetKeys(l, "all", 5500);
    expect(reset.params.exposure).toBe(0);
    expect(reset.params.hsl.hue.red).toBe(0);
    expect(reset.params.displayTransform).toBeNull();
    expect(reset.params.retouch).toHaveLength(1);
    expect(reset.paramBag).toEqual({ "unknown.key": 1 });
  });
});
