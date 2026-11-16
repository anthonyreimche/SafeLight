// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An extension that declares permissions.programs may run one program the
// person picked for it (api.programs): the grant is a random token kept per
// extension, a run happens in a fresh folder with no shell, and what the
// program prints streams back. These tests run node itself as the program.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgramAccess } from "./program-access.cjs";

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-programs-test-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const writer = {
  write: async (p: string, bytes: Uint8Array) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
  },
};

type Manifest = { id: string; name: string; permissions?: { programs?: boolean } };
const GMIC: Manifest = { id: "gmic", name: "G'MIC", permissions: { programs: true } };

class FakeSender extends EventEmitter {
  static next = 1;
  id = FakeSender.next++;
  sent: { channel: string; payload: { runId: string; stream: string; text: string } }[] = [];
  destroyed = false;
  isDestroyed() {
    return this.destroyed;
  }
  send(channel: string, payload: { runId: string; stream: string; text: string }) {
    this.sent.push({ channel, payload });
  }
  text(stream: string) {
    return this.sent.filter((s) => s.payload.stream === stream).map((s) => s.payload.text).join("");
  }
}
const eventOf = (sender: FakeSender = new FakeSender()) => ({ sender });

type Options = {
  manifests?: Manifest[];
  consent?: boolean;
  picked?: string | null;
  userData?: string;
  tmp?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
};

function rig(opts: Options = {}) {
  const userData = opts.userData ?? tempDir();
  const tmp = opts.tmp ?? tempDir();
  const manifests = opts.manifests ?? [GMIC];
  const showConsent = vi.fn(async () => opts.consent ?? true);
  const pickPath = vi.fn(async () => opts.picked ?? process.execPath);
  const access = createProgramAccess({
    userData: () => userData,
    fileWriter: writer,
    findManifest: async (id: string) => manifests.find((m) => m.id === id) ?? null,
    showConsent,
    pickPath,
    tmpDir: () => tmp,
    env: opts.env ?? process.env,
    platform: opts.platform ?? process.platform,
  });
  return { access, showConsent, pickPath, userData, tmp, file: path.join(userData, "program-grants.json") };
}

/** A kept node for extension "gmic". */
async function kept(r = rig()) {
  const program = await r.access.pick(eventOf(), "gmic", {});
  expect(program).not.toBeNull();
  return { ...r, token: program!.token };
}

const node = (script: string) => ["-e", script];

describe("pick", () => {
  it("asks the person, naming the extension and the full path, and keeps the answer", async () => {
    const r = rig();
    const event = eventOf();
    const program = await r.access.pick(event, "gmic", { title: "Find G'MIC" });
    expect(r.pickPath).toHaveBeenCalledWith(event, { title: "Find G'MIC", defaultPath: null, programsOnly: process.platform === "win32" });
    expect(r.showConsent).toHaveBeenCalledWith(event, { name: "G'MIC", path: process.execPath });
    expect(program).toEqual({ token: expect.any(String), path: process.execPath, name: path.basename(process.execPath) });
    expect(await r.access.list("gmic")).toEqual([program]);
    const saved = JSON.parse(fs.readFileSync(r.file, "utf8"));
    expect(saved).toEqual({ version: 1, programs: { [program!.token]: { extension: "gmic", path: process.execPath } } });
  });

  it("keeps nothing when the person says no or cancels the file dialogue", async () => {
    const no = rig({ consent: false });
    expect(await no.access.pick(eventOf(), "gmic", {})).toBeNull();
    expect(fs.existsSync(no.file)).toBe(false);
    const cancelled = rig();
    cancelled.pickPath.mockResolvedValue(null as never);
    expect(await cancelled.access.pick(eventOf(), "gmic", {})).toBeNull();
    expect(cancelled.showConsent).not.toHaveBeenCalled();
  });

  it("asks nothing for an extension that doesn't declare programs", async () => {
    const r = rig({ manifests: [{ id: "gmic", name: "G'MIC", permissions: {} }] });
    expect(await r.access.pick(eventOf(), "gmic", {})).toBeNull();
    expect(await r.access.pick(eventOf(), "unknown", {})).toBeNull();
    expect(r.pickPath).not.toHaveBeenCalled();
    expect(r.showConsent).not.toHaveBeenCalled();
  });

  it("takes only a file", async () => {
    const dir = tempDir();
    expect(await rig({ picked: dir }).access.pick(eventOf(), "gmic", {})).toBeNull();
    expect(await rig({ picked: path.join(dir, "missing") }).access.pick(eventOf(), "gmic", {})).toBeNull();
    expect(await rig({ picked: "gmic" }).access.pick(eventOf(), "gmic", {})).toBeNull();
  });

  it("takes only .exe and .com on Windows", async () => {
    const dir = tempDir();
    const script = path.join(dir, "tool.sh");
    const exe = path.join(dir, "TOOL.EXE");
    fs.writeFileSync(script, "");
    fs.writeFileSync(exe, "");
    expect(await rig({ picked: script, platform: "win32" }).access.pick(eventOf(), "gmic", {})).toBeNull();
    expect(await rig({ picked: exe, platform: "win32" }).access.pick(eventOf(), "gmic", {})).toMatchObject({ name: "TOOL.EXE" });
  });

  it("turns down a second pick while its dialogue is still open", async () => {
    const r = rig();
    let answer: (yes: boolean) => void = () => {};
    r.showConsent.mockImplementation(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const first = r.access.pick(eventOf(), "gmic", {});
    await vi.waitFor(() => expect(r.showConsent).toHaveBeenCalledTimes(1));
    expect(await r.access.pick(eventOf(), "gmic", {})).toBeNull();
    answer(true);
    expect(await first).not.toBeNull();
    expect(r.showConsent).toHaveBeenCalledTimes(1);
  });

  it("keeps a program picked twice as one grant, without asking again", async () => {
    const r = rig();
    const a = await r.access.pick(eventOf(), "gmic", {});
    const b = await r.access.pick(eventOf(), "gmic", {});
    expect(b).toEqual(a);
    expect(r.showConsent).toHaveBeenCalledTimes(1);
  });

  it("drops the grant a new pick replaces, and opens the dialogue where it was", async () => {
    const dir = tempDir();
    const other = path.join(dir, process.platform === "win32" ? "other.exe" : "other");
    fs.writeFileSync(other, "");
    const r = rig();
    const first = (await r.access.pick(eventOf(), "gmic", {}))!;
    r.pickPath.mockResolvedValue(other as never);
    const second = (await r.access.pick(eventOf(), "gmic", { replacing: first.token }))!;
    expect(r.pickPath.mock.calls[1][1]).toMatchObject({ defaultPath: process.execPath });
    expect(await r.access.list("gmic")).toEqual([second]);
  });

  it("keeps no grant that failed to reach the disk", async () => {
    const userData = tempDir();
    const access = createProgramAccess({
      userData: () => userData,
      fileWriter: { write: async () => Promise.reject(new Error("disk full")) },
      findManifest: async () => GMIC,
      showConsent: async () => true,
      pickPath: async () => process.execPath,
    });
    await expect(access.pick(eventOf(), "gmic", {})).rejects.toThrow("disk full");
    expect(await access.list("gmic")).toEqual([]);
  });

  it("moves a damaged record aside before writing a new one", async () => {
    const userData = tempDir();
    fs.writeFileSync(path.join(userData, "program-grants.json"), "{not json");
    const r = rig({ userData });
    await r.access.pick(eventOf(), "gmic", {});
    expect(fs.readFileSync(`${r.file}.bad`, "utf8")).toBe("{not json");
  });
});

describe("locate", () => {
  const exe = process.platform === "win32" ? "fakeprog.exe" : "fakeprog";
  function pathWith(dir: string) {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    env[process.platform === "win32" ? "Path" : "PATH"] = [dir, "relative/dir"].join(path.delimiter);
    return env;
  }

  it("finds a program on PATH and asks consent for it as pick does", async () => {
    const dir = tempDir();
    const file = path.join(dir, exe);
    fs.writeFileSync(file, "");
    fs.chmodSync(file, 0o755);
    const r = rig({ env: pathWith(dir) });
    const event = eventOf();
    const found = await r.access.locate(event, "gmic", "fakeprog");
    expect(found).toMatchObject({ path: file, name: exe });
    expect(r.showConsent).toHaveBeenCalledWith(event, { name: "G'MIC", path: file });
    expect(await r.access.list("gmic")).toEqual([found]);
  });

  it("says null for a program that isn't there, a refusal, or a name with a path in it", async () => {
    const dir = tempDir();
    const file = path.join(dir, exe);
    fs.writeFileSync(file, "");
    fs.chmodSync(file, 0o755);
    const r = rig({ env: pathWith(dir) });
    expect(await r.access.locate(eventOf(), "gmic", "nothing-here")).toBeNull();
    expect(await r.access.locate(eventOf(), "gmic", `..${path.sep}${exe}`)).toBeNull();
    expect(await r.access.locate(eventOf(), "gmic", "")).toBeNull();
    expect(r.showConsent).not.toHaveBeenCalled();
    const no = rig({ env: pathWith(dir), consent: false });
    expect(await no.access.locate(eventOf(), "gmic", "fakeprog")).toBeNull();
    expect(await no.access.list("gmic")).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("passes over a file that can't be run", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "fakeprog"), "");
    fs.chmodSync(path.join(dir, "fakeprog"), 0o644);
    const r = rig({ env: pathWith(dir) });
    expect(await r.access.locate(eventOf(), "gmic", "fakeprog")).toBeNull();
  });

  it("looks in the usual folders on macOS and Linux, even when PATH is bare", async () => {
    const r = rig({ env: { PATH: "" }, platform: "linux" });
    const probe = vi.spyOn(fs.promises, "stat");
    await r.access.locate(eventOf(), "gmic", "no-such-program-here");
    const looked = probe.mock.calls.map((c) => String(c[0]).replace(/\\/g, "/"));
    probe.mockRestore();
    for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) expect(looked).toContain(`${dir}/no-such-program-here`);
  });
});

describe("ownership", () => {
  it("lists, forgets and runs only an extension's own programs", async () => {
    const other: Manifest = { id: "other", name: "Other", permissions: { programs: true } };
    const r = await kept(rig({ manifests: [GMIC, other] }));
    expect(await r.access.list("other")).toEqual([]);
    await r.access.forget("other", r.token);
    expect(await r.access.list("gmic")).toHaveLength(1);
    await expect(r.access.run(eventOf(), "other", "r1", r.token, [], {})).rejects.toThrow(/isn't one this extension kept/);
    await r.access.forget("gmic", r.token);
    expect(await r.access.list("gmic")).toEqual([]);
    expect(JSON.parse(fs.readFileSync(r.file, "utf8")).programs).toEqual({});
  });

  it("forgets everything for an uninstalled extension", async () => {
    const r = await kept();
    await r.access.forgetExtension("gmic");
    expect(await r.access.list("gmic")).toEqual([]);
    await expect(r.access.run(eventOf(), "gmic", "r1", r.token, [], {})).rejects.toThrow();
  });

  it("reads the file again for a token granted since it last looked", async () => {
    const userData = tempDir();
    const app = rig({ userData });
    const engine = rig({ userData });
    expect(await engine.access.list("gmic")).toEqual([]);
    const program = (await app.access.pick(eventOf(), "gmic", {}))!;
    const result = await engine.access.run(eventOf(), "gmic", "r1", program.token, node("process.stdout.write('hi')"), {});
    expect(result.stdout).toBe("hi");
  });
});

describe("run", () => {
  it("reports the exit code and what the program printed", async () => {
    const r = await kept();
    const ok = await r.access.run(eventOf(), "gmic", "r1", r.token, node("process.stdout.write('out');process.stderr.write('err')"), {});
    expect(ok).toEqual({ exitCode: 0, killed: null, stdout: "out", stderr: "err", files: {} });
    const bad = await r.access.run(eventOf(), "gmic", "r2", r.token, node("process.stderr.write('boom');process.exit(7)"), {});
    expect(bad).toMatchObject({ exitCode: 7, killed: null, stderr: "boom" });
  });

  it("runs in a fresh folder holding the files, and takes the named outputs back", async () => {
    const r = await kept();
    const script = `
      const fs = require("fs");
      const input = fs.readFileSync("in.bin");
      fs.writeFileSync("out.bin", Buffer.concat([input, Buffer.from([9])]));
      fs.writeFileSync("out_1.txt", "a");
      fs.writeFileSync("out_2.txt", "b");
      fs.writeFileSync("skip.txt", "c");
      process.stdout.write(process.cwd());
    `;
    const result = await r.access.run(eventOf(), "gmic", "r1", r.token, node(script), {
      files: { "in.bin": new Uint8Array([1, 2, 3]) },
      outputs: ["out.bin", "out_*", "missing.bin"],
    });
    expect(Object.keys(result.files).sort()).toEqual(["out.bin", "out_1.txt", "out_2.txt"]);
    expect([...result.files["out.bin"]]).toEqual([1, 2, 3, 9]);
    expect(path.basename(result.stdout)).toMatch(/^safelight-run-/);
    expect(fs.realpathSync(path.dirname(result.stdout))).toBe(fs.realpathSync(r.tmp));
    expect(fs.readdirSync(r.tmp)).toEqual([]);
  });

  it("removes its folder after a failure too", async () => {
    const r = await kept();
    await r.access.run(eventOf(), "gmic", "r1", r.token, node("require('fs').writeFileSync('x','y');process.exit(1)"), {});
    expect(fs.readdirSync(r.tmp)).toEqual([]);
  });

  it("refuses to start for a file name that could leave the folder or mean a device", async () => {
    const r = await kept();
    const bad = [
      "../escape.txt", "a/b.txt", "a\\b.txt", ".", "..", "", "CON", "con.txt", "nul", "Aux.png", "COM1", "lpt9.bin", "trailing.", "sp ace.txt", "x".repeat(129), "é.txt",
    ];
    for (const name of bad) {
      await expect(r.access.run(eventOf(), "gmic", "r", r.token, node("0"), { files: { [name]: new Uint8Array(1) } }), name).rejects.toThrow(/file name/i);
      await expect(r.access.run(eventOf(), "gmic", "r", r.token, node("0"), { outputs: [name] }), name).rejects.toThrow(/file name/i);
    }
    expect(fs.readdirSync(r.tmp)).toEqual([]);
  });

  it("refuses names that differ only by case, and a bare or odd prefix", async () => {
    const r = await kept();
    await expect(
      r.access.run(eventOf(), "gmic", "r", r.token, node("0"), { files: { "A.txt": new Uint8Array(1), "a.txt": new Uint8Array(1) } }),
    ).rejects.toThrow(/differ only by case/i);
    await expect(r.access.run(eventOf(), "gmic", "r", r.token, node("0"), { outputs: ["*"] })).rejects.toThrow(/file name/i);
    await expect(r.access.run(eventOf(), "gmic", "r", r.token, node("0"), { outputs: ["../*"] })).rejects.toThrow(/file name/i);
  });

  it("refuses files that aren't bytes", async () => {
    const r = await kept();
    await expect(
      r.access.run(eventOf(), "gmic", "r", r.token, node("0"), { files: { "a.txt": "text" as unknown as Uint8Array } }),
    ).rejects.toThrow(/bytes/i);
  });

  it("checks the arguments", async () => {
    const r = await kept();
    const run = (args: unknown) => r.access.run(eventOf(), "gmic", "r", r.token, args as string[], {});
    await expect(run(new Array(4097).fill("a"))).rejects.toThrow(/arguments/i);
    await expect(run(["x".repeat(32 * 1024 + 1)])).rejects.toThrow(/arguments/i);
    await expect(run(["a\0b"])).rejects.toThrow(/arguments/i);
    await expect(run([1])).rejects.toThrow(/arguments/i);
    await expect(run("-e")).rejects.toThrow(/arguments/i);
    const edge = await run(node(`process.stdout.write(String(process.argv.length))`).concat(new Array(4094).fill("x")));
    expect(edge.stdout).toBe("4095");
  });

  it("hands arguments over untouched, with no shell", async () => {
    const r = await kept();
    const tricky = ['a b', '"q"', '& echo hi', '$(x)', '%PATH%', '*', 'é€'];
    const result = await r.access.run(eventOf(), "gmic", "r", r.token, [...node("process.stdout.write(JSON.stringify(process.argv.slice(1)))"), ...tricky], {});
    expect(JSON.parse(result.stdout)).toEqual(tricky);
  });

  it("refuses when the extension stopped declaring programs, or the file is gone", async () => {
    const manifests = [GMIC];
    const userData = tempDir();
    const first = rig({ userData, manifests });
    const program = (await first.access.pick(eventOf(), "gmic", {}))!;
    manifests[0] = { id: "gmic", name: "G'MIC", permissions: {} };
    await expect(first.access.run(eventOf(), "gmic", "r", program.token, node("0"), {})).rejects.toThrow(/permission/i);

    const dir = tempDir();
    const file = path.join(dir, process.platform === "win32" ? "t.exe" : "t");
    fs.writeFileSync(file, "");
    const second = rig({ picked: file });
    const token = (await second.access.pick(eventOf(), "gmic", {}))!.token;
    fs.rmSync(file);
    await expect(second.access.run(eventOf(), "gmic", "r", token, [], {})).rejects.toThrow(/gone|isn't there/i);
  });

  it("rejects a program that can't start", async () => {
    const dir = tempDir();
    const file = path.join(dir, process.platform === "win32" ? "broken.exe" : "broken");
    fs.writeFileSync(file, "not a program");
    fs.chmodSync(file, 0o755);
    const r = rig({ picked: file });
    const token = (await r.access.pick(eventOf(), "gmic", {}))!.token;
    await expect(r.access.run(eventOf(), "gmic", "r", token, [], {})).rejects.toThrow(/start/i);
    expect(fs.readdirSync(r.tmp)).toEqual([]);
  });

  it("gives the program the app's environment minus what would point it into the app", async () => {
    const env = { ...process.env, LD_LIBRARY_PATH: "/app/lib", APPDIR: "/app", APPIMAGE: "/app.AppImage", ELECTRON_RUN_AS_NODE: "1", ELECTRON_FOO: "x", KEEP_ME: "yes" };
    const r = await kept(rig({ env }));
    const result = await r.access.run(eventOf(), "gmic", "r", r.token, node("process.stdout.write(JSON.stringify(process.env))"), {});
    const seen = JSON.parse(result.stdout);
    expect(seen.KEEP_ME).toBe("yes");
    for (const key of ["LD_LIBRARY_PATH", "APPDIR", "APPIMAGE", "ELECTRON_RUN_AS_NODE", "ELECTRON_FOO"]) expect(seen[key]).toBeUndefined();
  });

  it("keeps the last 4 MB of each stream", async () => {
    const r = await kept();
    const script = `
      const line = "x".repeat(1023) + "\\n";
      for (let i = 0; i < 5 * 1024; i++) process.stdout.write(line);
      process.stdout.write("THE END");
    `;
    const result = await r.access.run(eventOf(), "gmic", "r", r.token, node(script), {});
    expect(result.stdout.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(result.stdout.length).toBeGreaterThan(4 * 1024 * 1024 - 2048);
    expect(result.stdout.endsWith("THE END")).toBe(true);
  }, 20_000);
});

describe("output streaming", () => {
  it("sends text to the asking window as it arrives, tagged with the run, and only when asked", async () => {
    const r = await kept();
    const sender = new FakeSender();
    const script = `process.stdout.write("one\\n");process.stderr.write("warn\\n");setTimeout(()=>process.stdout.write("two\\n"),150)`;
    await r.access.run({ sender }, "gmic", "run-1", r.token, node(script), { stream: true });
    expect(sender.sent.every((s) => s.channel === "programs:output" && s.payload.runId === "run-1")).toBe(true);
    expect(sender.text("stdout")).toBe("one\ntwo\n");
    expect(sender.text("stderr")).toBe("warn\n");
    const quiet = new FakeSender();
    await r.access.run({ sender: quiet }, "gmic", "run-2", r.token, node(script), {});
    expect(quiet.sent).toEqual([]);
  });

  it("decodes UTF-8 across chunk boundaries", async () => {
    const r = await kept();
    const sender = new FakeSender();
    const script = `
      process.stdout.write(Buffer.from([0xe2, 0x82]));
      setTimeout(() => process.stdout.write(Buffer.from([0xac, 0x21])), 120);
    `;
    const result = await r.access.run({ sender }, "gmic", "r", r.token, node(script), { stream: true });
    expect(result.stdout).toBe("€!");
    expect(sender.text("stdout")).toBe("€!");
  });

  it("coalesces a flood into a few events", async () => {
    const r = await kept();
    const sender = new FakeSender();
    const script = `
      let n = 0;
      const t = setInterval(() => { process.stdout.write("line " + n + "\\n"); if (++n === 80) clearInterval(t); }, 5);
    `;
    const started = Date.now();
    const result = await r.access.run({ sender }, "gmic", "r", r.token, node(script), { stream: true });
    const seconds = (Date.now() - started) / 1000;
    expect(sender.text("stdout")).toBe(result.stdout);
    expect(sender.sent.length).toBeLessThanOrEqual(Math.ceil(seconds * 10) + 3);
    expect(sender.sent.length).toBeLessThan(40);
  });

  it("sends nothing to a window that has gone", async () => {
    const r = await kept();
    const sender = new FakeSender();
    sender.destroyed = true;
    const result = await r.access.run({ sender }, "gmic", "r", r.token, node("process.stdout.write('x')"), { stream: true });
    expect(result.stdout).toBe("x");
    expect(sender.sent).toEqual([]);
  });
});

const LONG = "setInterval(() => {}, 1000); process.stdout.write('up');";

describe("stopping a run", () => {
  it("kills the program at the timeout", async () => {
    const r = await kept();
    const result = await r.access.run(eventOf(), "gmic", "r", r.token, node(LONG), { timeoutMs: 400 });
    expect(result).toMatchObject({ exitCode: null, killed: "timeout", files: {} });
    expect(fs.readdirSync(r.tmp)).toEqual([]);
  }, 15_000);

  it("kills it when the extension cancels, and answers once it has stopped", async () => {
    const r = await kept();
    const event = eventOf();
    const run = r.access.run(event, "gmic", "run-9", r.token, node(LONG), { stream: true });
    await vi.waitFor(() => expect(event.sender.text("stdout")).toBe("up"), { timeout: 5000 });
    await r.access.cancel(event, "run-9");
    expect(await run).toMatchObject({ exitCode: null, killed: "cancelled", stdout: "up" });
    expect(fs.readdirSync(r.tmp)).toEqual([]);
  }, 15_000);

  it("honours a cancel that arrives before the program has started", async () => {
    const r = await kept();
    const event = eventOf();
    const run = r.access.run(event, "gmic", "run-9", r.token, node(LONG), {});
    await r.access.cancel(event, "run-9");
    expect(await run).toMatchObject({ exitCode: null, killed: "cancelled" });
    expect(fs.readdirSync(r.tmp)).toEqual([]);
  }, 15_000);

  it("ignores a cancel from another window, and for a run it doesn't know", async () => {
    const r = await kept();
    const event = eventOf();
    const run = r.access.run(event, "gmic", "run-9", r.token, node("setTimeout(() => process.stdout.write('done'), 400)"), {});
    await r.access.cancel(eventOf(), "run-9");
    await r.access.cancel(event, "nope");
    expect(await run).toMatchObject({ exitCode: 0, killed: null, stdout: "done" });
  });

  it("refuses a second run under the same id", async () => {
    const r = await kept();
    const event = eventOf();
    const run = r.access.run(event, "gmic", "same", r.token, node(LONG), {});
    await expect(r.access.run(event, "gmic", "same", r.token, node("0"), {})).rejects.toThrow(/run id/i);
    await r.access.cancel(event, "same");
    await run;
  }, 15_000);

  it("kills a window's runs when the window goes", async () => {
    const r = await kept();
    const sender = new FakeSender();
    const run = r.access.run({ sender }, "gmic", "a", r.token, node(LONG), { stream: true });
    await vi.waitFor(() => expect(sender.text("stdout")).toBe("up"), { timeout: 5000 });
    sender.emit("render-process-gone", {}, { reason: "crashed" });
    expect(await run).toMatchObject({ killed: "cancelled" });
    const again = r.access.run({ sender }, "gmic", "b", r.token, node(LONG), { stream: true });
    await vi.waitFor(() => expect(sender.text("stdout")).toBe("upup"), { timeout: 5000 });
    sender.emit("destroyed");
    expect(await again).toMatchObject({ killed: "cancelled" });
  }, 20_000);

  it("kills every run when the app is quitting", async () => {
    const r = await kept();
    const event = eventOf();
    const runs = ["a", "b"].map((id) => r.access.run(event, "gmic", id, r.token, node(LONG), { stream: true }));
    await vi.waitFor(() => expect(event.sender.text("stdout")).toBe("upup"), { timeout: 5000 });
    r.access.killAll();
    for (const run of await Promise.all(runs)) expect(run).toMatchObject({ exitCode: null, killed: "cancelled" });
  }, 20_000);
});

describe("outputs", () => {
  it("refuses more than 16 files", async () => {
    const r = await kept();
    const script = `for (let i = 0; i < 17; i++) require("fs").writeFileSync("o" + i, "x")`;
    await expect(r.access.run(eventOf(), "gmic", "r", r.token, node(script), { outputs: ["o*"] })).rejects.toThrow(/16 files/);
    expect(fs.readdirSync(r.tmp)).toEqual([]);
  });

  it("takes exactly 16", async () => {
    const r = await kept();
    const script = `for (let i = 0; i < 16; i++) require("fs").writeFileSync("o" + i, "x")`;
    const result = await r.access.run(eventOf(), "gmic", "r", r.token, node(script), { outputs: ["o*"] });
    expect(Object.keys(result.files)).toHaveLength(16);
  });

  it("matches a prefix only inside its own folder", async () => {
    const r = await kept();
    const script = `require("fs").mkdirSync("o-dir"); require("fs").writeFileSync("o-dir/x", "x"); require("fs").writeFileSync("o1", "y")`;
    const result = await r.access.run(eventOf(), "gmic", "r", r.token, node(script), { outputs: ["o*"] });
    expect(Object.keys(result.files)).toEqual(["o1"]);
  });

  it.skipIf(process.platform === "win32")("doesn't follow a link the program leaves in place of an output", async () => {
    const secret = path.join(tempDir(), "secret.txt");
    fs.writeFileSync(secret, "private");
    const r = await kept();
    const script = `require("fs").symlinkSync(${JSON.stringify(secret)}, "out.txt")`;
    const result = await r.access.run(eventOf(), "gmic", "r", r.token, node(script), { outputs: ["out.txt", "out*"] });
    expect(result.files).toEqual({});
  });
});
