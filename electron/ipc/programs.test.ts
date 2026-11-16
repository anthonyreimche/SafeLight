// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The programs:* channels: every one is privileged, the dialogues are native
// and default to "Don't allow", and what is kept is forgotten with the
// extension.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { programChannels } from "./programs.cjs";
import { ENGINE_REFUSED, engineChannels } from "../engine-mode.cjs";

const temps: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-programs-ipc-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const writer = {
  write: async (p: string, bytes: Uint8Array) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
  },
};

class Sender extends EventEmitter {
  id = 1;
  sent: unknown[] = [];
  isDestroyed = () => false;
  send(_channel: string, payload: unknown) {
    this.sent.push(payload);
  }
}

function rig(response = 0) {
  const showMessageBox = vi.fn(async () => ({ response }));
  const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: [process.execPath] }));
  let forget: (id: string) => Promise<void> = async () => {};
  let shutdown: () => void = () => {};
  const channels = programChannels({
    BrowserWindow: { fromWebContents: () => null },
    dialog: { showMessageBox, showOpenDialog },
    userData: () => userData,
    fileWriter: writer,
    listPlugins: async () => [{ id: "gmic", name: "G'MIC", permissions: { programs: true } }],
    devFolderFile: () => path.join(userData, "dev-folder.json"),
    onUninstalled: (f: (id: string) => Promise<void>) => void (forget = f),
    onShutdown: (f: () => void) => void (shutdown = f),
  } as never);
  const userData = tempDir();
  const call = (channel: string, ...args: unknown[]) =>
    (channels.find((c) => c.channel === channel)!.handler as (...a: unknown[]) => Promise<never>)({ sender: new Sender() }, ...args);
  return { channels, call, showMessageBox, showOpenDialog, forget: (id: string) => forget(id), shutdown: () => shutdown() };
}

describe("programChannels", () => {
  it("answers six channels, every one privileged", () => {
    const { channels } = rig();
    expect(channels.map((c) => c.channel).sort()).toEqual([
      "programs:cancel",
      "programs:forget",
      "programs:list",
      "programs:locate",
      "programs:pick",
      "programs:run",
    ]);
    expect(channels.every((c) => c.privileged)).toBe(true);
  });

  it("asks in a native dialogue whose default and cancel are Don't allow, naming the extension and the path", async () => {
    const r = rig(1);
    expect(await r.call("programs:pick", "gmic", {})).toBeNull();
    const [options] = r.showMessageBox.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(options).toMatchObject({ buttons: ["Allow", "Don't allow"], defaultId: 1, cancelId: 1, noLink: true });
    expect(options.message).toContain("G'MIC");
    expect(options.message).toContain(process.execPath);
    const detail = String(options.detail);
    expect(detail).toMatch(/read, change and delete your files/);
    expect(detail).toMatch(/such as Terminal/);
    expect(detail).toContain("G'MIC");
  });

  it("keeps an allowed program, runs it, and forgets it with the extension", async () => {
    const r = rig();
    const program = (await r.call("programs:pick", "gmic", { title: "Find it" })) as { token: string };
    expect(program).toMatchObject({ path: process.execPath });
    expect(r.showOpenDialog.mock.calls[0][0]).toMatchObject({ properties: ["openFile"], title: "Find it" });
    expect(await r.call("programs:list", "gmic")).toEqual([program]);
    const result = await r.call("programs:run", "gmic", "run-1", program.token, ["-e", "process.stdout.write('hi')"], {});
    expect(result).toMatchObject({ exitCode: 0, stdout: "hi" });
    await r.forget("gmic");
    expect(await r.call("programs:list", "gmic")).toEqual([]);
  });

  it("forgets one program on request", async () => {
    const r = rig();
    const program = (await r.call("programs:pick", "gmic", {})) as { token: string };
    await r.call("programs:forget", "gmic", program.token);
    expect(await r.call("programs:list", "gmic")).toEqual([]);
  });

  it("kills what is running when the app shuts down", async () => {
    const r = rig();
    const program = (await r.call("programs:pick", "gmic", {})) as { token: string };
    const run = r.call("programs:run", "gmic", "run-1", program.token, ["-e", "setInterval(() => {}, 1000)"], {});
    await new Promise((resolve) => setTimeout(resolve, 600));
    r.shutdown();
    expect(await run).toMatchObject({ exitCode: null, killed: "cancelled" });
  });

  it("is refused forgetting in the engine, which can't ask anyone", () => {
    expect(ENGINE_REFUSED.has("programs:forget")).toBe(true);
    const { channels } = rig();
    const refused = engineChannels(channels).find((c) => c.channel === "programs:forget")!;
    return expect((refused.handler as () => Promise<void>)()).rejects.toThrow("Not available to the engine.");
  });
});
