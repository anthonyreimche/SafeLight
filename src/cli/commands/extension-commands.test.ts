// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it, vi } from "vitest";
import type { Output } from "../output/types";
import {
  CliError,
  type CommandContext,
  type ExtensionService,
  type InstalledExtension,
  type ParsedArgs,
  type SearchHit,
} from "../types";
import { disableCommand } from "./disable";
import { enableCommand } from "./enable";
import { extensionsCommand } from "./extensions";
import { confirmFor, installCommand } from "./install";
import { searchCommand } from "./search";
import { uninstallCommand } from "./uninstall";
import { updateCommand } from "./update";

const basic: InstalledExtension = {
  id: "safelight.basic", name: "Basic", version: "1.0.0", enabled: true, trust: "official", repo: "anthonyreimche/basic", permissions: [],
};
const acme: InstalledExtension = {
  id: "acme.tool", name: "Acme Tool", version: "1.0.0", enabled: false, trust: "unverified", repo: "someone/acme-tool", permissions: ["reach https://old.test"],
};

function args(positionals: string[], options: ParsedArgs["options"] = {}): ParsedArgs {
  return { verb: null, positionals, assignments: [], afterDashDash: [], stdinList: false, options };
}

function fakeService(overrides: Partial<ExtensionService> = {}): ExtensionService {
  return {
    installed: async () => [basic, acme],
    search: async () => [],
    resolve: async (name) => {
      const hit = [basic, acme].find((e) => e.id === name || e.id.endsWith(`.${name}`));
      if (hit) return { repo: hit.repo ?? "", id: hit.id };
      if (name === "kit") return { kit: "kit", repos: ["a/one", "b/two"] };
      if (name.includes("/")) return { repo: name };
      throw new CliError(5, `No extension called "${name}".`);
    },
    install: async (repo) => ({ ...acme, id: repo, name: repo, version: "2.0.0", enabled: true }),
    abandon: async () => undefined,
    uninstall: async () => undefined,
    updatesAvailable: async () => [],
    setEnabled: async () => undefined,
    guiRunning: async () => false,
    ...overrides,
  };
}

interface Rig { ctx: CommandContext; printed: string[]; errors: string[]; warned: string[]; json: unknown[] }

function rig(extensions: ExtensionService, opts: { yes?: boolean; json?: boolean; tty?: boolean } = {}): Rig {
  const printed: string[] = [];
  const errors: string[] = [];
  const warned: string[] = [];
  const json: unknown[] = [];
  const out = {
    print: (t: string) => printed.push(t),
    error: (p: { message: string }) => errors.push(p.message),
    warn: (p: { message: string }) => warned.push(p.message),
    json: (d: unknown) => json.push(d),
    searchTable: (rows: unknown[]) => `search:${rows.length}`,
    extensionTable: (rows: { id: string; update?: string }[]) => rows.map((r) => `${r.id}${r.update ? `>${r.update}` : ""}`).join(","),
  } as unknown as Output;
  const ctx = {
    env: { isTTY: { stdin: opts.tty ?? false, stdout: false, stderr: false } },
    out,
    json: opts.json ?? false,
    yes: opts.yes ?? false,
    extensions,
  } as unknown as CommandContext;
  return { ctx, printed, errors, warned, json };
}

describe("install", () => {
  it("installs a name, a repository and each missing member of a kit", async () => {
    const install = vi.fn(fakeService().install);
    const r = rig(fakeService({ install }));
    const outcome = await installCommand.run(r.ctx, args(["owner/repo", "kit"]));
    expect(outcome.code).toBe(0);
    expect(install.mock.calls.map((c) => c[0])).toEqual(["owner/repo", "a/one", "b/two"]);
    expect(r.printed.join("\n")).toContain("Installed a/one 2.0.0.");
  });

  it("passes --version through and keeps going after one name fails, ending on exit 5", async () => {
    const install = vi.fn(fakeService().install);
    const r = rig(fakeService({ install }));
    const outcome = await installCommand.run(r.ctx, args(["missing", "x/y"], { version: "1.5.0" }));
    expect(outcome.code).toBe(5);
    expect(install).toHaveBeenCalledWith("x/y", expect.objectContaining({ version: "1.5.0" }));
    expect(r.errors).toEqual(['No extension called "missing".']);
  });

  it("leaves an installed extension to update, and refuses a kit with --version", async () => {
    const install = vi.fn(fakeService().install);
    const again = rig(fakeService({ install }));
    await installCommand.run(again.ctx, args(["basic"]));
    expect(install).not.toHaveBeenCalledWith("anthonyreimche/basic", expect.anything());
    expect(again.printed[0]).toContain("already installed");
    const kit = rig(fakeService({ install }));
    expect((await installCommand.run(kit.ctx, args(["kit"], { version: "1.0.0" }))).code).toBe(5);
  });

  it("needs a name", async () => {
    await expect(installCommand.run(rig(fakeService()).ctx, args([]))).rejects.toMatchObject({ code: 1 });
  });

  it("says the app picks the change up on its next start only while the app runs", async () => {
    const running = rig(fakeService({ guiRunning: async () => true }));
    await installCommand.run(running.ctx, args(["x/y"]));
    expect(running.printed.at(-1)).toMatch(/next starts/);
    const idle = rig(fakeService());
    await installCommand.run(idle.ctx, args(["x/y"]));
    expect(idle.printed.join()).not.toMatch(/next starts/);
  });

  it("prints one JSON document with --json", async () => {
    const r = rig(fakeService(), { json: true });
    await installCommand.run(r.ctx, args(["x/y"]));
    expect(r.printed).toEqual([]);
    expect(r.json).toEqual([{ slu: 1, results: [{ name: "x/y", ok: true, message: "Installed x/y 2.0.0." }] }]);
  });
});

describe("the unverified question", () => {
  const risk = { name: "Acme Tool", trust: "unverified" as const, permissions: ["reach https://api.acme.test"] };

  it("is answered by --yes without asking", async () => {
    const ask = vi.fn(async () => "");
    expect(await confirmFor(rig(fakeService(), { yes: true }).ctx, ask)(risk)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("refuses when there is no terminal and no --yes", async () => {
    const ask = vi.fn(async () => "y");
    expect(await confirmFor(rig(fakeService()).ctx, ask)(risk)).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks on a terminal, naming what the extension may reach", async () => {
    const ask = vi.fn(async (_question: string) => "Yes");
    const confirm = confirmFor(rig(fakeService(), { tty: true }).ctx, ask);
    expect(await confirm(risk)).toBe(true);
    expect(ask.mock.calls[0][0]).toContain("reach https://api.acme.test");
    expect(await confirmFor(rig(fakeService(), { tty: true }).ctx, async () => "")(risk)).toBe(false);
  });
});

describe("uninstall, enable and disable", () => {
  it("removes the extension that the name means", async () => {
    const uninstall = vi.fn(async () => undefined);
    const r = rig(fakeService({ uninstall }));
    expect((await uninstallCommand.run(r.ctx, args(["tool"]))).code).toBe(0);
    expect(uninstall).toHaveBeenCalledWith("acme.tool");
  });

  it("answers exit 5 for a name that isn't installed", async () => {
    const r = rig(fakeService({ resolve: async () => ({ repo: "other/thing" }) }));
    expect((await uninstallCommand.run(r.ctx, args(["thing"]))).code).toBe(5);
    expect(r.errors[0]).toMatch(/isn't installed/);
  });

  it("switches each named extension, saying which already were that way", async () => {
    const setEnabled = vi.fn(async () => undefined);
    const r = rig(fakeService({ setEnabled }));
    await enableCommand.run(r.ctx, args(["tool", "basic"]));
    expect(setEnabled.mock.calls).toEqual([["acme.tool", true], ["safelight.basic", true]]);
    expect(r.printed).toEqual(["Acme Tool is now on.", "Basic is already on."]);
    await disableCommand.run(r.ctx, args(["basic", "tool"]));
    expect(setEnabled).toHaveBeenLastCalledWith("acme.tool", false);
    expect(r.printed.slice(2)).toEqual(["Basic is now off.", "Acme Tool is already off."]);
  });

  it("answers exit 5 for every name while slu can't tell which extensions are on", async () => {
    const unknown = new CliError(5, "Open Safelight once so slu can see which extensions are on.");
    const r = rig(fakeService({ setEnabled: async () => { throw unknown; } }));
    expect((await enableCommand.run(r.ctx, args(["basic"]))).code).toBe(5);
    expect((await disableCommand.run(r.ctx, args(["tool"]))).code).toBe(5);
    expect(r.errors).toEqual([unknown.message, unknown.message]);
    expect(r.printed).toEqual([]);
  });
});

describe("update", () => {
  it("installs each newer release, quietly confirming ones already accepted", async () => {
    const install = vi.fn(fakeService().install);
    const r = rig(fakeService({
      install,
      updatesAvailable: async () => [{ id: "acme.tool", from: "1.0.0", to: "2.0.0" }],
    }));
    expect((await updateCommand.run(r.ctx, args([]))).code).toBe(0);
    expect(install).toHaveBeenCalledWith("someone/acme-tool", expect.anything());
    expect(r.printed[0]).toContain("from 1.0.0 to 2.0.0");
  });

  describe("new permissions", () => {
    const newcomer = { name: "Acme Tool", trust: "unverified" as const, permissions: ["reach https://old.test", "reach https://new.test"] };
    const updating = (confirmed: { value: boolean | null }) => fakeService({
      updatesAvailable: async () => [{ id: "acme.tool", from: "1.0.0", to: "2.0.0" }],
      install: async (_repo, opts) => {
        confirmed.value = await opts.confirm(newcomer);
        if (!confirmed.value) throw new CliError(5, "Didn't install Acme Tool.");
        return { ...acme, version: "2.0.0" };
      },
    });

    it("refuses without a terminal or --yes", async () => {
      const confirmed = { value: null as boolean | null };
      const r = rig(updating(confirmed));
      expect((await updateCommand.run(r.ctx, args([]))).code).toBe(5);
      expect(confirmed.value).toBe(false);
    });

    it("goes ahead with --yes", async () => {
      const confirmed = { value: null as boolean | null };
      const r = rig(updating(confirmed), { yes: true });
      expect((await updateCommand.run(r.ctx, args([]))).code).toBe(0);
      expect(confirmed.value).toBe(true);
    });

    it("doesn't ask when the permissions are the ones already accepted", async () => {
      const same = { ...newcomer, permissions: ["reach https://old.test"] };
      const r = rig(fakeService({
        updatesAvailable: async () => [{ id: "acme.tool", from: "1.0.0", to: "2.0.0" }],
        install: async (_repo, opts) => {
          expect(await opts.confirm(same)).toBe(true);
          return { ...acme, version: "2.0.0" };
        },
      }), { tty: true });
      expect((await updateCommand.run(r.ctx, args([]))).code).toBe(0);
    });
  });

  it("says when everything is current, and limits itself to the names given", async () => {
    const updatesAvailable = vi.fn(async () => []);
    const r = rig(fakeService({ updatesAvailable }));
    expect((await updateCommand.run(r.ctx, args(["tool"]))).code).toBe(0);
    expect(updatesAvailable).toHaveBeenCalledWith(["acme.tool"]);
    expect(r.printed).toEqual(["Everything is up to date."]);
  });
});

describe("search and extensions", () => {
  it("lists hits and warns when the list stopped at its limit", async () => {
    const hit = (n: number): SearchHit => ({
      id: `x${n}`, name: `X${n}`, version: "1.0.0", category: "", trust: "unverified", repo: `o/x${n}`, installName: `x${n}`,
    });
    const r = rig(fakeService({ search: async () => Array.from({ length: 25 }, (_, i) => hit(i)) }));
    await searchCommand.run(r.ctx, args(["x"]));
    expect(r.printed).toEqual(["search:25"]);
    expect(r.warned[0]).toMatch(/first 25/);
    await expect(searchCommand.run(r.ctx, args([]))).rejects.toMatchObject({ code: 1 });
  });

  it("gives enabled: null in --json while the app hasn't said which extensions are on", async () => {
    const unknown = { ...basic, enabled: null };
    const r = rig(fakeService({ installed: async () => [unknown] }), { json: true });
    await extensionsCommand.run(r.ctx, args([]));
    expect(r.json).toEqual([{ slu: 1, extensions: [expect.objectContaining({ id: "safelight.basic", enabled: null, update: null })] }]);
  });

  it("shows the update beside each installed extension, and carries on when the check fails", async () => {
    const ok = rig(fakeService({ updatesAvailable: async () => [{ id: "acme.tool", from: "1.0.0", to: "1.1.0" }] }));
    await extensionsCommand.run(ok.ctx, args([]));
    expect(ok.printed).toEqual(["safelight.basic,acme.tool>1.1.0"]);
    const offline = rig(fakeService({
      updatesAvailable: async () => {
        throw new CliError(5, "Couldn't reach GitHub.");
      },
    }));
    expect((await extensionsCommand.run(offline.ctx, args([]))).code).toBe(0);
    expect(offline.warned[0]).toContain("Couldn't reach GitHub.");
    expect(offline.printed).toHaveLength(1);
  });
});
