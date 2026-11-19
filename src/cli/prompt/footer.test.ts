import { describe, expect, it } from "vitest";
import { footerFor } from "./footer";
import { ghostFor } from "./ghost";
import { context, EXPOSURE, UPRIGHT } from "./test-fixtures";

const footer = (line: string, cursor = line.length, ctx = context()) => footerFor(line, cursor, ctx);
const ghost = (line: string, ctx = context()) => ghostFor(line, line.length, ctx);

describe("footer", () => {
  it("shows hints on an empty line", () => {
    expect(footer("")).toEqual({ kind: "hints" });
  });

  it("shows a verb's usage while it is typed, and after it", () => {
    expect(footer("se")).toEqual({ kind: "verb", usage: "set <photos> key=value…", summary: "Sets values." });
    expect(footer("set ")).toMatchObject({ kind: "verb", usage: "set <photos> key=value…" });
    expect(footer("cd")).toMatchObject({ kind: "verb", usage: "cd [folder]" });
  });

  it("names an unknown verb with the fix", () => {
    expect(footer("sett x")).toEqual({ kind: "problem", message: "\"sett\" isn't a command. Did you mean set?", fix: "set" });
  });

  it("describes the photo under the cursor", () => {
    expect(footer("set DSC_0412.NEF")).toEqual({ kind: "photo", name: "DSC_0412.NEF", rating: 4, flag: "pick", step: { at: 4, of: 6 } });
    expect(footer("tools DSC_0413.NEF")).toEqual({ kind: "photo", name: "DSC_0413.NEF", rating: 2, flag: "none" });
  });

  it("counts what a glob or folder matches", () => {
    expect(footer("set *.NEF")).toEqual({ kind: "matches", count: 3 });
    expect(footer("photos Italy")).toEqual({ kind: "matches", count: 1 });
  });

  it("says a missing photo isn't there", () => {
    expect(footer("tools DSC_9999.NEF ", 18)).toEqual({ kind: "problem", message: "DSC_9999.NEF isn't in this project." });
  });

  it("shows the key's slider at the photo's value", () => {
    expect(footer("set DSC_0412.NEF expo")).toEqual({ kind: "slider", info: EXPOSURE, now: 0.5 });
    expect(footer("set DSC_0412.NEF exposure=")).toEqual({ kind: "slider", info: EXPOSURE, now: 0.5 });
  });

  it("moves the slider as the number is typed", () => {
    expect(footer("set DSC_0412.NEF exposure=+0.7")).toEqual({ kind: "slider", info: EXPOSURE, now: 0.5, next: 0.7 });
    expect(footer("set DSC_0412.NEF exposure+=1")).toEqual({ kind: "slider", info: EXPOSURE, now: 0.5, next: 1.5 });
    expect(footer("set *.NEF exposure=1")).toEqual({ kind: "slider", info: EXPOSURE, now: 0, next: 1 });
  });

  it("says where a value past its range stops", () => {
    expect(footer("set DSC_0412.NEF exposure=7")).toEqual({ kind: "stops", info: EXPOSURE, limit: 5 });
  });

  it("explains a value of the wrong kind", () => {
    expect(footer("set x.NEF exposure=5600K")).toEqual({ kind: "problem", message: "Exposure is in EV, not \"K\"." });
  });

  it("offers the fix for a misspelt key", () => {
    expect(footer("set x.NEF expsure=")).toEqual({ kind: "problem", message: "\"expsure\" isn't a value. Did you mean exposure?", fix: "exposure" });
  });

  it("gives choices a slider at the choice's position", () => {
    expect(footer("set DSC_0412.NEF uprightMode=level")).toEqual({ kind: "slider", info: UPRIGHT, now: 0, next: 1 });
  });

  it("describes an option", () => {
    expect(footer("tools x --all")).toEqual({ kind: "verb", usage: "--all", summary: "Also list idle tools." });
    expect(footer("tools x --nope")).toEqual({ kind: "problem", message: "--nope isn't an option of tools." });
  });
});

describe("ghost", () => {
  it("comes from the newest history line that starts with the line", () => {
    const ctx = context({ history: ["set a.NEF exposure=1", "set b.NEF exposure=2", "tools"] });
    expect(ghost("set ", ctx)).toBe("b.NEF exposure=2");
    expect(ghost("set a", ctx)).toBe(".NEF exposure=1");
  });

  it("only shows at the end of the line", () => {
    const ctx = context({ history: ["set a.NEF"] });
    expect(ghostFor("set ", 2, ctx)).toBeNull();
    expect(ghost("")).toBeNull();
  });

  it("then comes from the grammar when exactly one thing fits", () => {
    expect(ghost("too")).toBe("ls");
    expect(ghost("set DSC_0412.NEF expo")).toBe("sure=");
    expect(ghost("tools It")).toBe("aly/");
    expect(ghost("tools DSC_041")).toBeNull();
  });

  it("then shows the photo's value after key=", () => {
    expect(ghost("set DSC_0412.NEF exposure=")).toBe("+0.50");
    expect(ghost("set DSC_0412.NEF temperature=")).toBe("5150");
    expect(ghost("set *.NEF exposure=")).toBeNull();
  });

  it("prefers history over the grammar", () => {
    expect(ghost("too", context({ history: ["tools DSC_0412.NEF"] }))).toBe("ls DSC_0412.NEF");
  });
});
