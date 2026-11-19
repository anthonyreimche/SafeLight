// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the output tests share: streams that record what was written, options
// for the designed look in the tagged theme (so a snapshot reads
// ‹amber›like this‹/›), and a few values with ranges.

import { Writable } from "node:stream";
import type { ToolRef, ValueInfo } from "../types";
import type { Capabilities } from "./capabilities";
import { lookOf } from "./look";
import type { Look } from "./look";
import type { OutputOptions } from "./types";

export function sink(isTTY: boolean, columns = 80, rows = 40) {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return {
    stream: Object.assign(stream, { isTTY, columns, rows }) as unknown as NodeJS.WriteStream,
    text: () => chunks.join(""),
    chunks,
  };
}

export const TAGGED: Capabilities = {
  theme: "dark", tier: "tagged", glyphs: "full", motion: "reduced", clockScale: 1,
  links: false, sync: false, curly: false, rich: { stdout: true, stderr: true },
};

export function richOptions(width = 96, caps: Partial<Capabilities> = {}, verbosity: OutputOptions["verbosity"] = "normal"): OutputOptions {
  return { colour: { stdout: true, stderr: true }, unicode: true, width, trueColour: true, verbosity, caps: { ...TAGGED, ...caps } };
}

export function taggedLook(width = 96, caps: Partial<Capabilities> = {}): Look {
  return lookOf({ ...TAGGED, ...caps }, width);
}

/** Tags off, for checking a layout's shape without its colours. */
export const untag = (text: string): string => text.replace(/‹\/?[a-zA-Z.]*›/g, "");

export const tool = (name: string, order: number): ToolRef => ({
  id: name.toLowerCase().replace(/ /g, "-"), name, kind: "core", installed: true, enabled: true, settable: true, order, hasCommitHooks: false,
});
export const WB = tool("White Balance", 1);
export const BASIC = tool("Basic", 2);
export const DETAIL = tool("Detail", 3);
export const CURVE = tool("Tone Curve", 4);

export const number = (t: ToolRef, key: string, min: number, max: number, more: Partial<ValueInfo> = {}): ValueInfo => ({
  key, label: key[0].toUpperCase() + key.slice(1), tool: t, kind: "number", min, max, settable: true, ...more,
});

export const TEMPERATURE = number(WB, "temperature", 2000, 50000, { unit: "K", position: (k) => Math.log(k / 2000) / Math.log(25) });
export const TINT = number(WB, "tint", -150, 150, { default: 0 });
export const EXPOSURE = number(BASIC, "exposure", -5, 5, { unit: "EV", decimals: 2, default: 0 });
export const CONTRAST = number(BASIC, "contrast", -100, 100, { default: 0 });
export const HIGHLIGHTS = number(BASIC, "highlights", -100, 100, { default: 0 });
export const SHADOWS = number(BASIC, "shadows", -100, 100, { default: 0 });
export const SHARPENING = number(DETAIL, "sharpening", 0, 150, { default: 25 });
export const COLOR_NR = number(DETAIL, "colorNR", 0, 100, { default: 25 });
export const CURVE_POINTS: ValueInfo = {
  key: "toneCurve", label: "Tone curve", tool: CURVE, kind: "id", settable: false, notSettableReason: "edit in Safelight",
};
