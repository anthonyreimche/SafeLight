// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Windows installer's own copy of Afacad and the art build/installer.nsh
// loads: names, line metrics and the scales the script and make-icon agree on.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALLER_SCALES } from "./make-icon.cjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FONTS = path.join(ROOT, "build", "installer-font");

function tables(font: Buffer): Map<string, number> {
  const count = font.readUInt16BE(4);
  const out = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const rec = 12 + i * 16;
    out.set(font.toString("latin1", rec, rec + 4), font.readUInt32BE(rec + 8));
  }
  return out;
}

function familyName(font: Buffer, at: number): string {
  const count = font.readUInt16BE(at + 2);
  const strings = at + font.readUInt16BE(at + 4);
  for (let i = 0; i < count; i++) {
    const rec = at + 6 + i * 12;
    if (font.readUInt16BE(rec) === 3 && font.readUInt16BE(rec + 6) === 1) {
      const length = font.readUInt16BE(rec + 8);
      const start = strings + font.readUInt16BE(rec + 10);
      return Buffer.from(font.subarray(start, start + length)).swap16().toString("utf16le");
    }
  }
  return "";
}

describe("installer font", () => {
  for (const style of ["Regular", "Bold"]) {
    it(`AfacadSetup-${style} is named apart and has the tightened line box`, () => {
      const font = readFileSync(path.join(FONTS, `AfacadSetup-${style}.ttf`));
      const t = tables(font);
      const os2 = t.get("OS/2") as number;
      const hhea = t.get("hhea") as number;
      expect(familyName(font, t.get("name") as number)).toBe("Afacad Setup");
      expect([font.readUInt16BE(os2 + 74), font.readUInt16BE(os2 + 76)]).toEqual([1260, 380]);
      expect([font.readInt16BE(hhea + 4), font.readInt16BE(hhea + 6), font.readInt16BE(hhea + 8)]).toEqual([1260, -380, 0]);
    });
  }

  it("ships the licence beside the fonts", () => {
    expect(readFileSync(path.join(FONTS, "OFL.txt"), "utf8")).toMatch(/SIL OPEN FONT LICENSE/i);
  });
});

describe("installer.nsh", () => {
  const nsh = readFileSync(path.join(ROOT, "build", "installer.nsh"), "utf8");

  it("loads art for exactly the scales make-icon draws", () => {
    const scales = [...nsh.matchAll(/!insertmacro slArtFor (\d+)/g)].map((m) => Number(m[1]));
    expect(scales.sort((a, b) => a - b)).toEqual(INSTALLER_SCALES);
  });

  it("uses Afacad only for the languages it covers", () => {
    const start = nsh.indexOf("!macro slPickFont");
    const block = nsh.slice(start, nsh.indexOf("!macroend", start));
    const codes = [...block.matchAll(/\$\{Case\} (\d+)/g)].map((m) => Number(m[1]));
    expect(codes).toEqual([1033, 1031, 1036, 3082, 1040, 1043, 1030, 1053, 1044, 1035, 2070, 1046, 1045, 1029, 1051, 1038, 1055, 1066]);
  });

  it("reads the font files the font script writes", () => {
    for (const style of ["Regular", "Bold"]) {
      expect(nsh).toContain(`"\${SL_FONTS}\\AfacadSetup-${style}.ttf"`);
      expect(existsSync(path.join(FONTS, `AfacadSetup-${style}.ttf`))).toBe(true);
    }
  });
});
