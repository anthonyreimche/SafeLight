// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tests for the preset adjustment summary helpers.
// Type-checked by `tsc --noEmit`; the assertions run under any alias-aware
// runner (the module imports the `@/` path alias, so bare node cannot resolve it).

import { DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";
import {
  summarizePreset,
  presetFields,
  buildPartialParams,
} from "./preset-summary.ts";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}
function eq(name: string, a: unknown, b: unknown) {
  check(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, JSON.stringify(a) === JSON.stringify(b));
}
function contains(name: string, list: unknown[], item: unknown) {
  const want = JSON.stringify(item);
  check(`${name} (contains ${want})`, list.some((x) => JSON.stringify(x) === want));
}

// summarizePreset: returns nothing for default params.
eq("default params → no diffs", summarizePreset({ ...DEFAULT_DEVELOP_PARAMS }), []);

// summarizePreset: lists changed scalars with signed values.
const scalarDiffs = summarizePreset({ contrast: 25, saturation: -100 });
contains("contrast diff", scalarDiffs, { label: "Contrast", value: "+25" });
contains("saturation diff", scalarDiffs, { label: "Saturation", value: "-100" });

// summarizePreset: partial-safe (missing complex keys do not throw).
let threw = false;
try {
  summarizePreset({ exposure: 1 });
} catch {
  threw = true;
}
check("partial params do not throw", !threw);
eq("partial exposure diff", summarizePreset({ exposure: 1 }), [
  { label: "Exposure", value: "+1.00" },
]);

// summarizePreset: collapses a non-default complex field to one line.
contains(
  "masks collapse to count",
  summarizePreset({ masks: [{ id: "m" }] as never }),
  { label: "Masks", value: "1" },
);

// presetFields: flags only changed adjustments.
{
  const params = { ...DEFAULT_DEVELOP_PARAMS, clarity: 15 };
  const fields = presetFields(params);
  check("clarity flagged changed", fields.find((f) => f.id === "clarity")?.changed === true);
  check("exposure not flagged", fields.find((f) => f.id === "exposure")?.changed === false);
}

// buildPartialParams: copies only the selected fields' keys.
{
  const params = { ...DEFAULT_DEVELOP_PARAMS, clarity: 15, contrast: 30 };
  const fields = presetFields(params);
  const partial = buildPartialParams(params, fields, new Set(["clarity"]));
  eq("partial copies only clarity", partial, { clarity: 15 });
}

// presetFields: geometry field bundles crop/straighten/transform.
{
  const params = { ...DEFAULT_DEVELOP_PARAMS, straighten: 5 };
  const fields = presetFields(params);
  const geom = fields.find((f) => f.id === "geometry");
  check("geometry flagged changed", geom?.changed === true);
  const partial = buildPartialParams(params, fields, new Set(["geometry"]));
  check("geometry copies straighten", partial.straighten === 5);
  check("geometry copies crop", partial.crop !== undefined);
  check("geometry copies transform", partial.transform !== undefined);
}

console.log(`preset-summary: ${passed} passed, ${failed} failed`);
if (failed) throw new Error(`${failed} preset-summary test(s) failed`);
