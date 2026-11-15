// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import type { Output } from "../output/types";
import type { CliEnv, ProjectRef, ProjectService, ValueService, WorkingSet } from "../types";
import type { ViewTarget } from "./model";
import { createPromptView, type PromptViewHost } from "./prompt";
import type { LiveView, LiveViewDeps, LiveViewOptions } from "./view";

const PROJECT: ProjectRef = { root: "/shoot", workingDir: "/shoot/.safelight", location: "in-folder" };
const at = (relPath: string): ViewTarget => ({ project: PROJECT, relPath });

function harness(working: WorkingSet | null = { paths: ["/shoot/a.ARW", "/shoot/b.ARW"], index: 0, root: "/shoot" }) {
  const log: string[] = [];
  const views: { options: LiveViewOptions; deps: LiveViewDeps; followed: (ViewTarget | null)[]; stopped: boolean; changes: number; moves: number }[] = [];
  let set = working;
  const host: PromptViewHost = {
    env: () => ({ platform: "linux", isTTY: { stdin: true, stdout: true, stderr: true } }) as CliEnv,
    out: () => ({
      print: (text: string) => log.push(`print ${text}`),
      error: (p: { message: string }) => log.push(`error ${p.message}`),
    }) as unknown as Output,
    engine: () => { throw new Error("no engine in this test"); },
    projects: () => ({ find: async () => PROJECT }) as unknown as ProjectService,
    values: () => ({}) as ValueService,
    working: () => set,
    async step(by) {
      if (!set) return false;
      set = { ...set, index: set.index + by };
      return true;
    },
    around: (draw) => { draw(); return true; },
    resolve: async (words) => at(words[1]),
    async start(deps, options, target) {
      const record = { options, deps, followed: [target], stopped: false, changes: 0, moves: 0 };
      views.push(record);
      const view: LiveView = {
        mode: options.mode,
        url: options.mode === "browser" ? "http://127.0.0.1:1/v/t/" : null,
        model: null as unknown as LiveView["model"],
        follow: async (next) => { record.followed.push(next); },
        changed: async () => { record.changes++; },
        moved: () => { record.moves++; },
        settled: async () => {},
        stop: async () => { record.stopped = true; },
      };
      return view;
    },
  };
  return { prompt: createPromptView(host), views, log, setWorking: (next: WorkingSet | null) => { set = next; } };
}

describe("view at the prompt", () => {
  it("shows the open photo, follows it through next and prev, and turns off with view off", async () => {
    const { prompt, views, log } = harness();
    await prompt.command(["view", "--browser", "--no-open"]);
    expect(views).toHaveLength(1);
    expect(views[0].options).toEqual({ mode: "browser", port: 0, open: false });
    expect(views[0].followed).toEqual([at("a.ARW")]);
    expect(log).toContain("print Live view: http://127.0.0.1:1/v/t/");

    await views[0].deps.step?.(1);
    expect(views[0].followed.at(-1)).toEqual(at("b.ARW"));

    await prompt.after("set");
    expect(views[0].changes).toBe(1);
    expect(views[0].moves).toBe(1);

    await prompt.command(["view", "off"]);
    expect(views[0].stopped).toBe(true);
    expect(log).toContain("print Live view off.");
  });

  it("keeps to a named photo when the open one changes, and toggles off with a bare view", async () => {
    const { prompt, views, setWorking } = harness();
    await prompt.command(["view", "c.ARW"]);
    expect(views[0].options.mode).toBe("terminal");
    expect(views[0].followed).toEqual([at("c.ARW")]);
    setWorking({ paths: ["/shoot/a.ARW", "/shoot/b.ARW"], index: 1, root: "/shoot" });
    await prompt.after("next");
    expect(views[0].followed).toEqual([at("c.ARW")]);

    await prompt.command(["view"]);
    expect(views[0].stopped).toBe(true);
  });

  it("follows the open photo after next, stops with close, and says so when there is no photo", async () => {
    const { prompt, views, log, setWorking } = harness();
    await prompt.command(["view"]);
    setWorking({ paths: ["/shoot/a.ARW", "/shoot/b.ARW"], index: 1, root: "/shoot" });
    await prompt.after("next");
    expect(views[0].followed.at(-1)).toEqual(at("b.ARW"));
    setWorking(null);
    await prompt.after("close");
    expect(views[0].stopped).toBe(true);

    await prompt.command(["view"]);
    expect(views).toHaveLength(1);
    expect(log).toContain("error No photo is open.");
  });

  it("starts again when asked for the other place, and stops when the prompt ends", async () => {
    const { prompt, views } = harness();
    await prompt.command(["view", "--terminal"]);
    await prompt.command(["view", "--browser"]);
    expect(views.map((v) => [v.options.mode, v.stopped])).toEqual([["terminal", true], ["browser", false]]);
    await prompt.stop();
    expect(views[1].stopped).toBe(true);
  });
});
