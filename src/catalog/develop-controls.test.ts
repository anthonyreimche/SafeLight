import { describe, expect, it } from "vitest";
import { DEFAULT_DEVELOP_PARAMS, freshParams } from "./types";
import {
  DEVELOP_CONTROLS,
  READ_ONLY_PARAMS,
  controlDefault,
  developControl,
  readControl,
  writeControl,
} from "./develop-controls";
import { ESSENTIAL_ADJUSTMENTS } from "@/extensions/essential-params";
import { NESTED_ADJUSTMENTS } from "@/state/develop-adjustments";

const control = (key: string) => {
  const c = developControl(key);
  if (!c) throw new Error(`no control ${key}`);
  return c;
};

describe("DEVELOP_CONTROLS", () => {
  it("has unique keys", () => {
    const keys = DEVELOP_CONTROLS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers every settable value of the core tools and no read-only key", () => {
    const owned = ESSENTIAL_ADJUSTMENTS.flatMap((e) => e.params).filter((k) => !(k in READ_ONLY_PARAMS));
    for (const param of owned) {
      expect(DEVELOP_CONTROLS.some((c) => c.key === param || c.key.startsWith(`${param}.`)), param).toBe(true);
    }
    for (const c of DEVELOP_CONTROLS) {
      expect(c.key.split(".")[0] in READ_ONLY_PARAMS, c.key).toBe(false);
    }
  });

  it("keeps each default inside its range", () => {
    for (const c of DEVELOP_CONTROLS.filter((x) => x.kind === "number")) {
      const value = controlDefault(c, 5500) as number;
      expect(value, c.key).toBeGreaterThanOrEqual(c.min as number);
      expect(value, c.key).toBeLessThanOrEqual(c.max as number);
    }
  });

  it("reads every key off a fresh photo with the type its kind says", () => {
    const params = freshParams(5500);
    for (const c of DEVELOP_CONTROLS) {
      const value = readControl(params, c);
      if (c.kind === "number") expect(typeof value, c.key).toBe("number");
      if (c.kind === "switch") expect(typeof value, c.key).toBe("boolean");
      if (c.kind === "choice") expect(c.choices?.some((x) => x.value === value), c.key).toBe(true);
    }
  });

  it("takes the shipping panels limits, not the develop-params comments", () => {
    expect(control("sharpening")).toMatchObject({ min: 0, max: 150 });
    expect(control("temperature")).toMatchObject({ min: 2000, max: 50000, step: 10, unit: "K", defaultFrom: "asShot" });
    expect(control("exposure")).toMatchObject({ min: -5, max: 5, step: 0.1, unit: "EV" });
    expect(control("straighten")).toMatchObject({ min: -45, max: 45, step: 0.1, unit: "°" });
    expect(control("transform.scale")).toMatchObject({ min: 50, max: 150 });
    expect(control("colorGrading.global.hue")).toMatchObject({ min: 0, max: 360, unit: "°" });
    expect(control("hsl.saturation.blue")).toMatchObject({ min: -100, max: 100 });
  });

  it("leaves guided out of the upright choices and makes displayTransform an id", () => {
    expect(control("uprightMode").choices?.map((x) => x.value)).toEqual(["off", "level", "vertical", "auto", "full"]);
    expect(control("displayTransform").kind).toBe("id");
    expect(controlDefault(control("displayTransform"), 5500)).toBeNull();
  });

  it("reads defaults from the as-shot temperature or the default params", () => {
    expect(controlDefault(control("temperature"), 4321)).toBe(4321);
    expect(controlDefault(control("vignette.midpoint"), 0)).toBe(DEFAULT_DEVELOP_PARAMS.vignette.midpoint);
  });
});

describe("writeControl", () => {
  it("replaces a nested value and copies only the path", () => {
    const params = freshParams(5500);
    const next = writeControl(params, control("hsl.hue.red"), 20);
    expect(next.hsl.hue.red).toBe(20);
    expect(params.hsl.hue.red).toBe(0);
    expect(next.hsl.saturation).toBe(params.hsl.saturation);
    expect(next.vignette).toBe(params.vignette);
  });

  it("writes a top-level key and a switch", () => {
    const params = freshParams(5500);
    expect(writeControl(params, control("exposure"), 1.5).exposure).toBe(1.5);
    expect(writeControl(params, control("transform.flipH"), true).transform.flipH).toBe(true);
    expect(writeControl(params, control("displayTransform"), "agx").displayTransform).toBe("agx");
  });
});

describe("NESTED_ADJUSTMENTS", () => {
  it("stays what it was before it was built from the table", () => {
    const row = (key: string, label: string, group: string, min: number, max: number) => {
      const [parent, field] = key.split(".");
      return { key, label, group, parent, field, min, max, step: 1 };
    };
    expect(NESTED_ADJUSTMENTS).toEqual([
      row("vignette.amount", "Amount", "Vignette", -100, 100),
      row("vignette.midpoint", "Midpoint", "Vignette", 0, 100),
      row("vignette.roundness", "Roundness", "Vignette", -100, 100),
      row("vignette.feather", "Feather", "Vignette", 0, 100),
      row("vignette.highlights", "Highlights", "Vignette", 0, 100),
      row("grain.amount", "Amount", "Grain", 0, 100),
      row("grain.size", "Size", "Grain", 25, 100),
      row("grain.roughness", "Roughness", "Grain", 0, 100),
      row("grain.color", "Colour", "Grain", 0, 100),
    ]);
  });
});
