// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { browserCommand, openBrowser, type BrowserSpawn } from "./browser";

const URL = "http://127.0.0.1:5123/v/0123456789abcdef0123456789abcdef/";

describe("opening the default browser", () => {
  it("uses start on Windows, open on macOS and xdg-open elsewhere", () => {
    expect(browserCommand("win32", URL)).toEqual({ command: "cmd", args: ["/c", "start", '""', URL], verbatim: true });
    expect(browserCommand("darwin", URL)).toEqual({ command: "open", args: [URL], verbatim: false });
    expect(browserCommand("linux", URL)).toEqual({ command: "xdg-open", args: [URL], verbatim: false });
    expect(browserCommand("freebsd", URL)).toEqual({ command: "xdg-open", args: [URL], verbatim: false });
  });

  it("starts the opener detached and lets it go, and a missing opener is no failure", () => {
    const calls: { command: string; args: string[]; detached?: boolean; verbatim?: boolean }[] = [];
    let unref = 0;
    let onError: ((error: Error) => void) | null = null;
    const spawn: BrowserSpawn = (command, args, options) => {
      calls.push({ command, args, detached: options.detached, verbatim: options.windowsVerbatimArguments });
      return {
        on(_event, listener) { onError = listener; },
        unref() { unref++; },
      };
    };

    openBrowser("linux", URL, spawn);

    expect(calls).toEqual([{ command: "xdg-open", args: [URL], detached: true, verbatim: false }]);
    expect(unref).toBe(1);
    expect(() => onError?.(new Error("spawn xdg-open ENOENT"))).not.toThrow();
  });
});
