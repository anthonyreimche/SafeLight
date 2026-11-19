// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { parseArgs } from "../args";
import { CliError, type CliEnv } from "../types";
import { COMMANDS } from "./index";
import { viewCommand, viewSettings } from "./view";

const env = (stdout: boolean): CliEnv => ({
  cwd: "/w", userData: "/u", appRoot: "/app", electronBinary: null, appVersion: "3.3.0", platform: "linux",
  isTTY: { stdin: stdout, stdout, stderr: stdout }, env: {},
});
const settings = (words: string[], tty = true) => viewSettings(env(tty), parseArgs(["view", ...words], viewCommand));

describe("view", () => {
  it("is a Look verb", () => {
    expect(COMMANDS.find((c) => c.verb === "view")?.group).toBe("Look");
    expect(viewCommand.usage).toBe("view [photo] [--browser | --terminal] [--port n] [--no-open]");
  });

  it("shows in the terminal when it is one, else in the browser, unless a flag says which", () => {
    expect(settings([])).toEqual({ mode: "terminal", port: 0, open: true });
    expect(settings([], false)).toEqual({ mode: "browser", port: 0, open: true });
    expect(settings(["--browser", "--port", "8123", "--no-open"])).toEqual({ mode: "browser", port: 8123, open: false });
    expect(settings(["--terminal", "--width", "60", "--graphics", "blocks"], false)).toEqual({ mode: "terminal", port: 0, open: true, widthCols: 60, graphics: "blocks" });
  });

  it("refuses both places at once, a port that isn't one, and an unknown image mode", () => {
    for (const words of [["--browser", "--terminal"], ["--port", "70000"], ["--port", "1.5"], ["--graphics", "png"], ["--width", "0"]]) {
      expect(() => settings(words), words.join(" ")).toThrow(CliError);
    }
  });
});
