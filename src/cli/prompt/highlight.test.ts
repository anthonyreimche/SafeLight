import { describe, expect, it } from "vitest";
import type { TokenKind } from "./view";
import { highlight } from "./highlight";
import { context } from "./test-fixtures";

/** The line's runs as "text:kind", skipping plain whitespace. */
function runs(line: string, cursor = line.length, ctx = context()): string[] {
  return highlight(line, cursor, ctx)
    .filter((t) => !(t.kind === "plain" && line.slice(t.start, t.end).trim() === ""))
    .map((t) => `${line.slice(t.start, t.end)}:${t.kind}`);
}

const kinds = (line: string, cursor?: number): TokenKind[] =>
  highlight(line, cursor ?? line.length, context()).map((t) => t.kind);

describe("highlight", () => {
  it("covers the whole line with no gaps", () => {
    const line = "set  DSC_0412.NEF exposure=+0.7 ";
    const tokens = highlight(line, line.length, context());
    expect(tokens[0].start).toBe(0);
    for (let i = 1; i < tokens.length; i++) expect(tokens[i].start).toBe(tokens[i - 1].end);
    expect(tokens.at(-1)?.end).toBe(line.length);
  });

  it("marks a known verb, and an unknown one only once a space follows", () => {
    expect(runs("set")).toEqual(["set:verb"]);
    expect(runs("sett")).toEqual(["sett:plain"]);
    expect(runs("sett ")).toEqual(["sett:verb-unknown"]);
    expect(runs("cd")).toEqual(["cd:verb"]);
    expect(runs("safelight set")).toEqual(["safelight:verb", "set:verb"]);
  });

  it("marks photos that exist, globs and folders, and photos that don't", () => {
    expect(runs("tools DSC_0412.NEF")).toEqual(["tools:verb", "DSC_0412.NEF:photo"]);
    expect(runs("set *.NEF ")).toEqual(["set:verb", "*.NEF:glob"]);
    expect(runs("photos Italy ")).toEqual(["photos:verb", "Italy:glob"]);
    expect(runs("tools DSC_9999.NEF ")).toEqual(["tools:verb", "DSC_9999.NEF:photo-missing"]);
    expect(runs(`tools "My Shoot/A 1.NEF"`)).toEqual(["tools:verb", `"My Shoot/A 1.NEF":photo`]);
  });

  it("leaves a photo name plain while it is still being typed", () => {
    expect(runs("tools DSC_04")).toEqual(["tools:verb", "DSC_04:plain"]);
    expect(runs("tools DSC_04 ", 13)).toEqual(["tools:verb", "DSC_04:photo-missing"]);
  });

  it("leaves photos plain outside a project", () => {
    expect(runs("tools DSC_9999.NEF ", undefined, context({ photos: null }))).toEqual(["tools:verb", "DSC_9999.NEF:plain"]);
  });

  it("splits key=value into key, operator, value and unit", () => {
    expect(runs("set DSC_0412.NEF exposure=+0.7")).toEqual(["set:verb", "DSC_0412.NEF:photo", "exposure:key", "=:operator", "+0.7:value"]);
    expect(runs("set x.NEF exposure+=1EV")).toContain("+=:operator");
    expect(runs("set x.NEF exposure+=1EV")).toEqual(expect.arrayContaining(["1:value", "EV:unit"]));
    expect(runs("set x.NEF temperature=5600K")).toEqual(expect.arrayContaining(["5600:value", "K:unit"]));
  });

  it("marks a value past its range, and one of the wrong kind or unit", () => {
    expect(runs("set x.NEF exposure=7")).toContain("7:value-past");
    expect(runs("set DSC_0412.NEF exposure+=5")).toContain("5:value-past");
    expect(runs("set x.NEF exposure=5600K")).toContain("5600K:value-wrong");
    expect(runs("set x.NEF exposure=abc")).toContain("abc:value-wrong");
    expect(runs("set x.NEF uprightMode=sideways")).toContain("sideways:value-wrong");
    expect(runs("set x.NEF uprightMode=level")).toContain("level:value");
    expect(runs("set x.NEF uprightMode=lev")).toContain("lev:plain");
    expect(runs("set x.NEF exposure=default")).toContain("default:value");
  });

  it("marks an unknown key as wrong", () => {
    expect(runs("set x.NEF expsure=1")).toContain("expsure:value-wrong");
  });

  it("marks options and their values, choices and verbs in help", () => {
    expect(runs("tools x.NEF --all")).toContain("--all:option");
    expect(runs("export x.NEF -o out")).toEqual(["export:verb", "x.NEF:photo-missing", "-o:option", "out:plain"]);
    expect(runs("flag DSC_0412.NEF pick")).toEqual(["flag:verb", "DSC_0412.NEF:photo", "pick:value"]);
    expect(runs("flag DSC_0412.NEF pik ")).toContain("pik:value-wrong");
    expect(runs("rate DSC_0412.NEF 7 ")).toContain("7:value-wrong");
    expect(runs("help set")).toEqual(["help:verb", "set:verb"]);
    expect(runs("get DSC_0412.NEF exposure contrast")).toEqual(["get:verb", "DSC_0412.NEF:photo", "exposure:key", "contrast:key"]);
  });

  it("marks quoted text that isn't a photo as quoted", () => {
    expect(runs(`search "warm film"`)).toEqual(["search:verb", `"warm film":quoted`]);
  });

  it("has a kind for every token", () => {
    expect(kinds("set DSC_0412.NEF exposure=+0.7").every((k) => typeof k === "string")).toBe(true);
  });
});
