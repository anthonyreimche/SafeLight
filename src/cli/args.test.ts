// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { PHOTO_OPTIONS, parseArgs } from "./args";
import { CliError, type CommandSpec } from "./types";

const spec: CommandSpec = {
  verb: "export",
  group: "Output",
  summary: "",
  usage: "",
  examples: [],
  writes: false,
  options: [
    ...PHOTO_OPTIONS,
    { name: "output", alias: "o", kind: "string", summary: "" },
    { name: "quality", kind: "number", summary: "" },
    { name: "tools", kind: "list", summary: "" },
    { name: "try", kind: "flag", summary: "" },
  ],
  run: async () => ({ code: 0 }),
};

const usageError = (fn: () => unknown): CliError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CliError) return e;
    throw e;
  }
  throw new Error("expected a CliError");
};

describe("parseArgs", () => {
  it("takes the first word as the verb and the rest as photos", () => {
    const a = parseArgs(["set", "IMG_1.ARW", "shoot/"], null);
    expect(a.verb).toBe("set");
    expect(a.positionals).toEqual(["IMG_1.ARW", "shoot/"]);
    expect(a.assignments).toEqual([]);
    expect(a.stdinList).toBe(false);
  });

  it("has no verb for an empty command line", () => {
    expect(parseArgs([], null).verb).toBeNull();
  });

  it("reads key=value as absolute, also with a leading +", () => {
    const a = parseArgs(["set", "a.ARW", "exposure=0.5", "exposure=+0.5"], null);
    expect(a.assignments).toEqual([
      { raw: "exposure=0.5", key: "exposure", op: "=", value: "0.5" },
      { raw: "exposure=+0.5", key: "exposure", op: "=", value: "+0.5" },
    ]);
    expect(a.positionals).toEqual(["a.ARW"]);
  });

  it("reads += and -= as relative", () => {
    const a = parseArgs(["set", "a.ARW", "exposure+=0.3", "contrast-=10"], null);
    expect(a.assignments.map((x) => [x.key, x.op, x.value])).toEqual([
      ["exposure", "+=", "0.3"],
      ["contrast", "-=", "10"],
    ]);
  });

  it("keeps dotted and dashed keys, units and negative values", () => {
    const a = parseArgs(
      ["set", "a.ARW", "local-contrast.lightness.detail=1.2", "straighten=-1.2°", "temperature=5600K", "transform.flipH=on"],
      null,
    );
    expect(a.assignments.map((x) => [x.key, x.op, x.value])).toEqual([
      ["local-contrast.lightness.detail", "=", "1.2"],
      ["straighten", "=", "-1.2°"],
      ["temperature", "=", "5600K"],
      ["transform.flipH", "=", "on"],
    ]);
  });

  it("treats a Windows path with = as a photo", () => {
    const a = parseArgs(["get", "C:\\a=b\\IMG.ARW"], null);
    expect(a.positionals).toEqual(["C:\\a=b\\IMG.ARW"]);
    expect(a.assignments).toEqual([]);
  });

  it("makes everything after -- a photo, even a=b", () => {
    const a = parseArgs(["set", "exposure=1", "--", "a=b.jpg", "--json", "-"], null);
    expect(a.assignments.map((x) => x.key)).toEqual(["exposure"]);
    expect(a.afterDashDash).toEqual(["a=b.jpg", "--json", "-"]);
    expect(a.options.json).toBeUndefined();
    expect(a.stdinList).toBe(false);
  });

  it("reads a lone - as a stdin list", () => {
    const a = parseArgs(["apply", "Warm film", "-"], null);
    expect(a.stdinList).toBe(true);
    expect(a.positionals).toEqual(["Warm film"]);
  });

  it("takes --opt v and --opt=v", () => {
    const a = parseArgs(["export", "a.ARW", "--quality", "90", "--project=D:\\Photos"], spec);
    expect(a.options.quality).toBe(90);
    expect(a.options.project).toBe("D:\\Photos");
    expect(a.positionals).toEqual(["a.ARW"]);
  });

  it("takes a short alias, and its value even when it is -", () => {
    const a = parseArgs(["export", "a.ARW", "-o", "-"], spec);
    expect(a.options.output).toBe("-");
    expect(a.stdinList).toBe(false);
    expect(parseArgs(["export", "-r", "shoot/"], spec).options.recursive).toBe(true);
  });

  it("splits list options on commas and across repeats", () => {
    const a = parseArgs(["export", "--tools", "basic,detail", "--tools=hsl"], spec);
    expect(a.options.tools).toEqual(["basic", "detail", "hsl"]);
  });

  it("reads -q, -v and -vv", () => {
    expect(parseArgs(["photos", "-q"], null).options.quiet).toBe(true);
    expect(parseArgs(["photos", "-v"], null).options.verbose).toBe(1);
    expect(parseArgs(["photos", "-vv"], null).options.verbose).toBe(2);
    expect(parseArgs(["photos", "-v", "--verbose"], null).options.verbose).toBe(2);
  });

  it("reads global options before the verb", () => {
    const a = parseArgs(["--json", "--project", "D:\\Photos", "photos", "--all"], null);
    expect(a.verb).toBe("photos");
    expect(a.options).toMatchObject({ json: true, project: "D:\\Photos", all: true });
  });

  it("takes --wait alone or with seconds", () => {
    expect(parseArgs(["set", "--wait"], null).options.wait).toBe(true);
    expect(parseArgs(["set", "--wait=30", "a.ARW"], null).options.wait).toBe("30");
    expect(parseArgs(["set", "--wait", "a.ARW"], null).positionals).toEqual(["a.ARW"]);
  });

  it("reads the photo filters", () => {
    const a = parseArgs(["photos", "--rating", "3+", "--flag", "pick", "--label", "red", "--edited"], null);
    expect(a.options).toMatchObject({ rating: "3+", flag: "pick", label: "red", edited: true });
  });

  it("refuses an option the command doesn't have", () => {
    const e = usageError(() => parseArgs(["export", "--colour", "red"], spec));
    expect(e.code).toBe(1);
    expect(e.message).toContain("--colour");
  });

  it("refuses a missing or non-numeric value", () => {
    expect(usageError(() => parseArgs(["export", "--quality"], spec)).code).toBe(1);
    expect(usageError(() => parseArgs(["export", "--quality", "high"], spec)).message).toContain("--quality");
  });

  it("refuses a value on a switch that takes none", () => {
    expect(usageError(() => parseArgs(["export", "--try=yes"], spec)).code).toBe(1);
  });
});
