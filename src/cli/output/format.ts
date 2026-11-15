// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Numbers and text as the panels show them, plus the wrapping every builder shares.

import type { ValueInfo } from "../types";
import type { Glyphs } from "./palette";

const length = (text: string): number => [...text].length;

/** As few decimals as the number needs, four at most. */
function natural(n: number): string {
  return String(Number(Math.abs(n).toFixed(4)));
}

function stepDecimals(step: number | undefined): number | undefined {
  if (step === undefined || !(step > 0)) return undefined;
  const text = String(step);
  if (text.includes("e")) return undefined;
  return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
}

export function formatNumber(n: number, decimals: number | undefined, plus: boolean, glyphs: Glyphs): string {
  if (!Number.isFinite(n)) return String(n);
  const text = decimals === undefined ? natural(n) : Math.abs(n).toFixed(decimals);
  if (Number(text) === 0) return text;
  if (n < 0) return `${glyphs.minus}${text}`;
  return plus ? `+${text}` : text;
}

export interface ValueParts {
  text: string;
  /** With its own leading space where one belongs: " EV", " K", "°". */
  unit: string;
  numeric: boolean;
}

export function valueParts(info: ValueInfo, value: unknown, glyphs: Glyphs): ValueParts {
  const words = (text: string): ValueParts => ({ text, unit: "", numeric: false });
  switch (info.kind) {
    case "switch":
      return words(value ? "on" : "off");
    case "choice":
      return words(info.choices?.find((c) => c.value === value)?.label ?? String(value));
    case "id":
      return words(value === null || value === undefined ? "default" : String(value));
    case "number": {
      if (typeof value !== "number") return words(String(value));
      const decimals = info.decimals ?? stepDecimals(info.step);
      const text = formatNumber(value, decimals, (info.min ?? 0) < 0, glyphs);
      const unit = info.unit === undefined ? "" : info.unit === "°" ? "°" : ` ${info.unit}`;
      return { text, unit, numeric: true };
    }
  }
}

export function formatValue(info: ValueInfo, value: unknown, glyphs: Glyphs): string {
  const parts = valueParts(info, value, glyphs);
  return parts.text + parts.unit;
}

export function formatRange(info: ValueInfo, glyphs: Glyphs): string {
  if (info.rangeUnknown) return "ranges unknown";
  if (info.kind === "choice") return (info.choices ?? []).map((c) => c.value).join(" | ");
  if (info.kind === "switch") return "on | off";
  if (info.min === undefined || info.max === undefined) return "";
  return `${formatNumber(info.min, undefined, false, glyphs)}${glyphs.ellipsis}${formatNumber(info.max, undefined, false, glyphs)}`;
}

export function formatBytes(bytes: number): string {
  const KB = 1024;
  if (bytes >= KB ** 3) return `${(bytes / KB ** 3).toFixed(1)} GB`;
  if (bytes >= KB ** 2) return `${(bytes / KB ** 2).toFixed(1)} MB`;
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
  return `${bytes} B`;
}

export function formatMegapixels(megapixels: number): string {
  return `${megapixels < 10 ? Number(megapixels.toFixed(1)) : Math.round(megapixels)} MP`;
}

/** Local time, written so it sorts and means the same in every locale. */
export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function truncateEnd(text: string, width: number, glyphs: Glyphs): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  const keep = Math.max(0, width - length(glyphs.ellipsis));
  return chars.slice(0, keep).join("").trimEnd() + glyphs.ellipsis;
}

/** Keeps the end, which is where a path's file name is. */
export function truncateStart(text: string, width: number, glyphs: Glyphs): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  const keep = Math.max(0, width - length(glyphs.ellipsis));
  return glyphs.ellipsis + chars.slice(chars.length - keep).join("").trimStart();
}

/**
 * Lays chunks out in lines no wider than `width`, breaking only between
 * chunks. A chunk wider than the line gets a line to itself.
 */
export function flowChunks(chunks: readonly string[], separator: string, width: number): string[][] {
  const gap = length(separator);
  const lines: string[][] = [];
  let line: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    const size = length(chunk);
    if (line.length > 0 && used + gap + size > width) {
      lines.push(line);
      line = [];
      used = 0;
    }
    used += (line.length > 0 ? gap : 0) + size;
    line.push(chunk);
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

/** Word-wraps to `width`. A newline in the text always starts a new line. */
export function wrapText(text: string, width: number): string[] {
  return text.split("\n").flatMap((paragraph) => {
    const words = paragraph.split(" ").filter((word) => word !== "");
    if (words.length === 0) return [""];
    return flowChunks(words, " ", width).map((line) => line.join(" "));
  });
}
