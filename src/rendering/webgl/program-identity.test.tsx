// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Every process version's whole develop program stays the one it was when the
// core tools began moving onto the stage path (program-reference.ts). A
// failure here means photos of that version would render differently: fix the
// code, never the reference.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalGlsl, programSnapshot } from "./program-identity.fixtures";
import { PROGRAM_REFERENCE } from "./program-reference";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("every process version's program stays frozen", () => {
  const snapshot = programSnapshot();

  it("freezes the same programs", () => {
    expect(Object.keys(snapshot).sort()).toEqual(Object.keys(PROGRAM_REFERENCE).sort());
  });

  it("builds every program as it was", () => {
    const changed = Object.keys(PROGRAM_REFERENCE).filter((k) => sha256(snapshot[k] ?? "") !== PROGRAM_REFERENCE[k]);
    expect(changed).toEqual([]);
  });
});

// The freeze is exactly as strict as this function.
describe("canonicalGlsl", () => {
  const PROGRAM = [
    "#version 300 es",
    "uniform float uA;",
    "uniform float uB;",
    "vec3 tone(vec3 c) {",
    "  return c * uA;",
    "}",
    "void main() {",
    "  vec3 c = vec3(uB);",
    "  c = tone(c);",
    "}",
  ].join("\n");

  it("ignores the order of top-level declarations", () => {
    const moved = [
      "#version 300 es",
      "vec3 tone(vec3 c) {",
      "  return c * uA;",
      "}",
      "uniform float uB;",
      "void main() {",
      "  vec3 c = vec3(uB);",
      "  c = tone(c);",
      "}",
      "uniform float uA;",
    ].join("\n");
    expect(canonicalGlsl(moved)).toBe(canonicalGlsl(PROGRAM));
  });

  it("ignores what normalizeGlsl ignores", () => {
    expect(canonicalGlsl(`// note\n${PROGRAM.replace("c * uA", "c  *  uA")}`)).toBe(canonicalGlsl(PROGRAM));
  });

  it("sees a statement move inside a function", () => {
    const swapped = PROGRAM.replace("  vec3 c = vec3(uB);\n  c = tone(c);", "  c = tone(c);\n  vec3 c = vec3(uB);");
    expect(canonicalGlsl(swapped)).not.toBe(canonicalGlsl(PROGRAM));
  });

  it("sees a changed token, a dropped declaration and a duplicated one", () => {
    expect(canonicalGlsl(PROGRAM.replace("c * uA", "c * uB"))).not.toBe(canonicalGlsl(PROGRAM));
    expect(canonicalGlsl(PROGRAM.replace("uniform float uB;\n", ""))).not.toBe(canonicalGlsl(PROGRAM));
    expect(canonicalGlsl(PROGRAM.replace("uniform float uB;", "uniform float uB;\nuniform float uB;"))).not.toBe(
      canonicalGlsl(PROGRAM),
    );
  });

  it("keeps a function whose signature runs over lines as one item", () => {
    const wrapped = PROGRAM.replace("vec3 tone(vec3 c) {", "vec3 tone(\n  vec3 c\n) {");
    expect(canonicalGlsl(wrapped).split("\n").filter((l) => l === "uniform float uA;")).toHaveLength(1);
    expect(canonicalGlsl(wrapped)).toContain("vec3 tone(\nvec3 c\n) {\nreturn c * uA;\n}");
  });
});
