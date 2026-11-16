// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An extension's verb at the prompt: its words are its own, never options or
// keys, photos come after --, and its subcommands complete as the first word.

import { describe, expect, it } from "vitest";
import { complete } from "../complete";
import type { CommandSpec } from "../types";
import { analyze } from "./grammar";
import { highlight } from "./highlight";
import { COMMANDS, context } from "./test-fixtures";

const GMIC: CommandSpec = {
  verb: "gmic",
  group: "Extensions",
  summary: "Runs G'MIC.",
  usage: "gmic <pipeline…>\nsafelight gmic filters [search]",
  examples: [],
  options: [],
  writes: false,
  rawArgs: true,
  subcommands: [
    { name: "filters", summary: "Lists G'MIC's filters." },
    { name: "filter", summary: "Runs one filter." },
    { name: "status", summary: "Says which G'MIC runs." },
  ],
  run: async () => ({ code: 0 }),
};

const ctx = () => context({ commands: [...COMMANDS, GMIC] });
const texts = (line: string) => complete(line, line.length, ctx()).items.map((c) => c.text);

describe("an extension's verb at the prompt", () => {
  it("reads every word before -- as the verb's own, and photos after it", () => {
    const line = "gmic -blur 3 --x exposure=1 -- DSC_0412.NEF";
    const roles = analyze(line, line.length, ctx()).words.map((w) => [w.text, w.role.kind === "slot" ? w.role.slot.kind : w.role.kind]);
    expect(roles).toEqual([
      ["gmic", "verb"],
      ["-blur", "text"],
      ["3", "text"],
      ["--x", "text"],
      ["exposure=1", "text"],
      ["--", "option"],
      ["DSC_0412.NEF", "photo"],
    ]);
  });

  it("highlights its words plainly, never as a wrong option or value", () => {
    const line = "gmic -blur 3 -- DSC_0412.NEF";
    const kinds = highlight(line, line.length, ctx()).filter((t) => line.slice(t.start, t.end).trim() !== "").map((t) => [line.slice(t.start, t.end), t.kind]);
    expect(kinds.slice(0, 3)).toEqual([["gmic", "verb"], ["-blur", "plain"], ["3", "plain"]]);
  });

  it("completes its subcommands as the first word, and nothing as an option", () => {
    expect(texts("gmic f")).toEqual(["filters", "filter"]);
    expect(complete("gmic ", 5, ctx()).items.map((c) => [c.text, c.detail])).toContainEqual(["status", "Says which G'MIC runs."]);
    expect(texts("gmic filters x")).toEqual([]);
    expect(texts("gmic -b")).toEqual([]);
  });

  it("completes photos after --", () => {
    expect(texts("gmic blur -- DSC_04")).toContain("DSC_0412.NEF");
  });
});
