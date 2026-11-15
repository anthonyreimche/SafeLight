// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Opens a URL in the default browser, as each platform's own opener does.

import { spawn } from "node:child_process";

export interface BrowserCommand { command: string; args: string[]; verbatim: boolean }

/** The live view's URL is only digits, hex and slashes, so nothing in it needs quoting for cmd. */
export function browserCommand(platform: NodeJS.Platform, url: string): BrowserCommand {
  // start's first quoted word is a window title, so the URL needs an empty one before it.
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", '""', url], verbatim: true };
  if (platform === "darwin") return { command: "open", args: [url], verbatim: false };
  return { command: "xdg-open", args: [url], verbatim: false };
}

export type BrowserSpawn = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore"; windowsHide: boolean; windowsVerbatimArguments: boolean },
) => { on(event: "error", listener: (error: Error) => void): unknown; unref(): void };

const spawnOpener: BrowserSpawn = (command, args, options) => spawn(command, args, options);

/** Starts the opener and lets it go. One that is missing says nothing: the URL is printed anyway. */
export function openBrowser(platform: NodeJS.Platform, url: string, spawnFn: BrowserSpawn = spawnOpener): void {
  const { command, args, verbatim } = browserCommand(platform, url);
  const child = spawnFn(command, args, { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: verbatim });
  child.on("error", () => {});
  child.unref();
}
