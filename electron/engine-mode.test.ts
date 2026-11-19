// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Engine mode (engine-mode.cjs): `slu` starts Safelight with --engine and
// talks to its hidden page through this process. Electron is faked; the
// app's userData is a temp folder.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enginePipePath, listenForEngine } from "../src/cli/engine-pipe";
import { WireDecoder, encodeWire as protocolEncodeWire } from "../src/engine/protocol";
import { SHARED_SETTINGS_FILE } from "../src/state/shared-settings";
import { chromiumSwitches } from "./chromium-switches.cjs";
import {
  ENGINE_PAGE,
  createRelay,
  encodeWire,
  engineChannels,
  readEngineBackend,
  readMirror,
  run,
  wireFor,
} from "./engine-mode.cjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PRELOAD = readFileSync(join(HERE, "preload.cjs"), "utf8");

type Message = { data: unknown };

class FakePort extends EventEmitter {
  posted: unknown[] = [];
  started = false;
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  start() {
    this.started = true;
  }
}

/** Everything written to it, decoded as engine wire. */
function wireSink() {
  const decoder = new WireDecoder();
  const out: Array<{ kind: 0 | 1; payload: Uint8Array }> = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      out.push(...decoder.push(new Uint8Array(chunk)));
      cb();
    },
  });
  const events = () => out.filter((m) => m.kind === 0).map((m) => JSON.parse(Buffer.from(m.payload).toString("utf8")));
  return { stream, out, events };
}

/** The CLI's end of the engine's socket, decoding what arrives as engine wire. */
function wireFrom(socket: Socket) {
  const decoder = new WireDecoder();
  const out: Array<{ kind: 0 | 1; payload: Uint8Array }> = [];
  socket.on("data", (chunk: Buffer) => void out.push(...decoder.push(new Uint8Array(chunk))));
  const events = () => out.filter((m) => m.kind === 0).map((m) => JSON.parse(Buffer.from(m.payload).toString("utf8")));
  return { socket, out, events };
}

/** A connected local socket pair, as the CLI and the engine hold it. */
async function socketPair() {
  const listening = await listenForEngine(enginePipePath());
  const engineSide = connect(listening.path);
  const cliSide = await listening.connection;
  return { engineSide, cliSide };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
};

describe("wire encoding", () => {
  it("matches the protocol's encoder", () => {
    const payload = new TextEncoder().encode('{"id":0,"type":"done"}');
    expect(new Uint8Array(encodeWire(0, payload))).toEqual(protocolEncodeWire(0, payload));
    expect(new Uint8Array(encodeWire(1, new Uint8Array([1, 2, 3])))).toEqual(protocolEncodeWire(1, new Uint8Array([1, 2, 3])));
  });

  it("sends events as kind 0 and frames as kind 1 with the frame number first", () => {
    const decoder = new WireDecoder();
    const event = { id: 3, type: "frame", frame: 7, width: 2, height: 1, encoding: "rgba" };
    const [json] = decoder.push(new Uint8Array(wireFor(event)!));
    expect(json.kind).toBe(0);
    expect(JSON.parse(Buffer.from(json.payload).toString("utf8"))).toEqual(event);

    for (const bytes of [new Uint8Array([9, 8, 7, 6]), new Uint8Array([9, 8, 7, 6]).buffer, new Uint8Array([0, 9, 8, 7, 6]).subarray(1)]) {
      const [frame] = decoder.push(new Uint8Array(wireFor({ frame: 7, bytes })!));
      expect(frame.kind).toBe(1);
      expect(Array.from(frame.payload)).toEqual([7, 0, 0, 0, 9, 8, 7, 6]);
    }
  });

  it("drops a message that is neither", () => {
    expect(wireFor(null)).toBeNull();
    expect(wireFor("ready")).toBeNull();
    expect(wireFor({ frame: 1 })).toBeNull();
    expect(wireFor({ frame: -1, bytes: new Uint8Array(1) })).toBeNull();
  });
});

describe("createRelay", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  function relay() {
    const input = new PassThrough();
    const sink = wireSink();
    const port = new FakePort();
    const end = vi.fn();
    createRelay({ input, output: sink.stream, port, end });
    return { input, sink, port, end };
  }

  it("posts each stdin line to the page as a request, in order, across chunk splits", async () => {
    const { input, port } = relay();
    expect(port.started).toBe(true);
    input.write('{"id":1,"type":"preview","photoId":"a"}\n{"id":2,');
    input.write('"type":"export"}\r\n\n');
    await tick();
    expect(port.posted).toEqual([
      { id: 1, type: "preview", photoId: "a" },
      { id: 2, type: "export" },
    ]);
  });

  it("answers a line that isn't a request with an error log and posts nothing", async () => {
    const { input, port, sink } = relay();
    input.write("not json\n");
    input.write('{"type":"export"}\n');
    await tick();
    expect(port.posted).toEqual([]);
    expect(sink.events()).toEqual([
      { id: 0, type: "log", level: "error", message: "Not a request: not json" },
      { id: 0, type: "log", level: "error", message: 'Not a request: {"type":"export"}' },
    ]);
  });

  it("passes a shutdown on, then ends once, ignoring what follows", async () => {
    const { input, port, end } = relay();
    input.write('{"id":5,"type":"shutdown"}\n{"id":6,"type":"export"}\n');
    input.end();
    await tick();
    expect(port.posted).toEqual([{ id: 5, type: "shutdown" }]);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("ends on stdin EOF", async () => {
    const { input, end } = relay();
    input.end();
    await tick();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("writes the page's events and frames to stdout as wire", () => {
    const { port, sink } = relay();
    port.emit("message", { data: { id: 0, type: "ready", protocol: 1 } } satisfies Message);
    port.emit("message", { data: { frame: 2, bytes: new Uint8Array([255, 0]) } } satisfies Message);
    port.emit("message", { data: 42 } satisfies Message);
    expect(sink.out.map((m) => m.kind)).toEqual([0, 1]);
    expect(sink.events()).toEqual([{ id: 0, type: "ready", protocol: 1 }]);
    expect(Array.from(sink.out[1].payload)).toEqual([2, 0, 0, 0, 255, 0]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("relays both ways over one local socket, and ends when the CLI closes it", async () => {
    const { engineSide, cliSide } = await socketPair();
    const port = new FakePort();
    const end = vi.fn();
    createRelay({ input: engineSide, output: engineSide, port, end });
    const cli = wireFrom(cliSide);

    cliSide.write('{"id":1,"type":"preview","photoId":"a"}\n');
    await waitFor(() => port.posted.length === 1);
    expect(port.posted).toEqual([{ id: 1, type: "preview", photoId: "a" }]);

    port.emit("message", { data: { id: 1, type: "frame", frame: 4 } } satisfies Message);
    port.emit("message", { data: { frame: 4, bytes: new Uint8Array([1, 2]) } } satisfies Message);
    await waitFor(() => cli.out.length === 2);
    expect(cli.events()).toEqual([{ id: 1, type: "frame", frame: 4 }]);
    expect(Array.from(cli.out[1].payload)).toEqual([4, 0, 0, 0, 1, 2]);

    cliSide.end();
    await waitFor(() => end.mock.calls.length > 0);
    expect(end).toHaveBeenCalledTimes(1);
  });

  // The page can still post its last events while stop() is ending the socket.
  it("drops what the page sends once its side of the socket has ended", async () => {
    const { port, sink } = relay();
    const errors: Error[] = [];
    sink.stream.on("error", (e: Error) => errors.push(e));
    sink.stream.end();
    port.emit("message", { data: { id: 1, type: "done" } } satisfies Message);
    await tick();
    expect(errors).toEqual([]);
    expect(sink.out).toEqual([]);
  });
});

describe("readEngineBackend", () => {
  const read = (files: Record<string, string>) => (file: string) => {
    if (!(file in files)) throw new Error("ENOENT");
    return files[file];
  };
  const userData = "C:\\Users\\a\\AppData\\Roaming\\Safelight";
  const cacheFile = `${userData}\\gpu-backend`;

  it("starts on the backend the app's cache names", () => {
    expect(readEngineBackend({ readFile: read({ [cacheFile]: "d3d11on12\nchosen\n" }), userData, platform: "win32", env: {} }).backend).toBe("d3d11on12");
  });

  it("stays in software even when the app is due to retry the graphics card", () => {
    const old = `swiftshader\ngpu-crashes\n1 99\n1.0.0\n`;
    expect(readEngineBackend({ readFile: read({ [cacheFile]: old }), userData, platform: "win32", env: {} }).backend).toBe("swiftshader");
  });

  it("starts on the ladder's first rung with no cache", () => {
    expect(readEngineBackend({ readFile: read({}), userData, platform: "win32", env: {} }).backend).toBe("d3d11");
    expect(readEngineBackend({ readFile: read({}), userData: "/home/a/.config/Safelight", platform: "linux", env: {} }).backend).toBe("gl");
  });
});

describe("readMirror", () => {
  it("reads the app's settings mirror, or null", () => {
    const doc = { version: 1, appVersion: "3.3.0", writtenAt: 1, guiPid: null, recentProjects: [], storage: { a: "1" } };
    const userData = "/u";
    const file = join(userData, SHARED_SETTINGS_FILE);
    expect(readMirror((f: string) => (f === file ? JSON.stringify(doc) : ""), userData)).toEqual(doc);
    expect(readMirror(() => JSON.stringify({ version: 2, storage: {} }), userData)).toBeNull();
    expect(readMirror(() => "{", userData)).toBeNull();
    expect(readMirror(() => {
      throw new Error("ENOENT");
    }, userData)).toBeNull();
  });
});

describe("engineChannels", () => {
  it("refuses the channels that change the app's own settings, and leaves the rest", async () => {
    const keep = vi.fn(() => "kept");
    const write = vi.fn();
    const out = engineChannels([
      { channel: "fs:read", privileged: true, handler: keep },
      { channel: "mirror:writeSharedSettings", privileged: true, handler: write },
      { channel: "mirror:writeDescriptors", privileged: true, handler: write },
      { channel: "plugins:writeDisabled", privileged: true, handler: write },
      { channel: "updates:install", privileged: true, handler: write },
      { channel: "devtools:sync-dev-folder", privileged: true, handler: write },
    ]);
    expect(out[0].handler).toBe(keep);
    for (const c of out.slice(1)) {
      expect(c.privileged).toBe(true);
      await expect(c.handler({} as never)).rejects.toThrow("Not available to the engine.");
    }
    expect(write).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The whole start, against a faked Electron.

class FakeContents extends EventEmitter {
  urls: string[] = [];
  sent: unknown[][] = [];
  setWindowOpenHandler = vi.fn();
  loadURL(url: string) {
    this.urls.push(url);
    return Promise.resolve();
  }
  postMessage(...args: unknown[]) {
    this.sent.push(args);
  }
}

function fakeElectron(appUserData: string) {
  const switches: string[][] = [];
  const paths: Record<string, string> = { userData: appUserData };
  const appEvents = new EventEmitter();
  let ready = () => {};
  const readyPromise = new Promise<void>((resolve) => (ready = resolve));
  const windows: Array<{ options: Record<string, unknown>; webContents: FakeContents }> = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ports = { port1: new FakePort(), port2: { name: "port2" } };
  const exits: number[] = [];
  const dialog = { showOpenDialog: vi.fn(), showMessageBox: vi.fn(), showErrorBox: vi.fn() };
  const shell = { openExternal: vi.fn(), openPath: vi.fn(), trashItem: vi.fn() };
  const app = {
    getPath: vi.fn((name: string) => paths[name]),
    setPath: vi.fn((name: string, value: string) => {
      paths[name] = value;
    }),
    getVersion: () => "3.3.0",
    commandLine: { appendSwitch: (...args: string[]) => void switches.push(args) },
    whenReady: () => readyPromise,
    on: (event: string, fn: (...args: unknown[]) => void) => void appEvents.on(event, fn),
    exit: vi.fn((code: number) => void exits.push(code)),
    quit: vi.fn(),
    relaunch: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    dock: { hide: vi.fn() },
    getGPUFeatureStatus: () => ({}),
    getAppMetrics: () => [],
  };
  class BrowserWindow {
    options: Record<string, unknown>;
    webContents = new FakeContents();
    constructor(options: Record<string, unknown>) {
      this.options = options;
      windows.push(this);
      appEvents.emit("web-contents-created", {}, this.webContents);
    }
    loadURL(url: string) {
      return this.webContents.loadURL(url);
    }
    static fromWebContents() {
      return null;
    }
    static getAllWindows() {
      return windows;
    }
  }
  const electron = {
    app,
    BrowserWindow,
    MessageChannelMain: class {
      port1 = ports.port1;
      port2 = ports.port2;
    },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn) },
    net: { fetch: vi.fn() },
    session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
    safeStorage: { isEncryptionAvailable: () => false },
    dialog,
    shell,
  };
  return { electron, app, appEvents, ready, switches, paths, windows, handlers, ports, exits, dialog, shell };
}

function fakeProcess(env: Record<string, string | undefined>, args: string[]) {
  const stdin = new PassThrough();
  const sink = wireSink();
  const stderr: string[] = [];
  const events = new EventEmitter();
  return {
    proc: {
      env,
      argv: ["safelight.exe", "/app", "--engine", "--slu-protocol=2", ...args],
      platform: process.platform,
      execPath: "safelight.exe",
      stdin,
      stdout: sink.stream,
      stderr: { write: (text: string) => void stderr.push(text) },
      on: (event: string, fn: (...args: unknown[]) => void) => void events.on(event, fn),
    },
    stdin,
    sink,
    stderr,
    events,
  };
}

const fakeConsole = () => ({ log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** A backend Preferences offers on this platform that isn't Automatic's first
 *  rung, so starting on it shows the app's cache was read. The fake process runs
 *  on the real platform: its cache path is built for it. */
const CHOSEN = ({ win32: "d3d11on12", darwin: "gl" } as Partial<Record<NodeJS.Platform, string>>)[process.platform] ?? "gles";

describe("run", () => {
  let root: string;
  let appUserData: string;
  let dist: string;
  const backendFile = () => join(appUserData, "gpu-backend");
  const mirror = { version: 1, appVersion: "3.3.0", writtenAt: 5, guiPid: 9, recentProjects: [], storage: { sl_settings_v1: "{}" } };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sl-engine-"));
    appUserData = join(root, "Safelight");
    dist = join(root, "dist");
    mkdirSync(appUserData);
    mkdirSync(dist);
    writeFileSync(join(dist, "engine.html"), "<!doctype html>");
    writeFileSync(backendFile(), `${CHOSEN}\nchosen\n`);
    writeFileSync(join(appUserData, SHARED_SETTINGS_FILE), JSON.stringify(mirror));
  });
  const sockets: Socket[] = [];
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  /** Starts engine mode the way the CLI does: listening first, its socket on the command line. */
  async function start(env: Record<string, string | undefined> = { SLU_USER_DATA: appUserData }) {
    const fx = fakeElectron(appUserData);
    const listening = await listenForEngine(enginePipePath());
    const p = fakeProcess(env, [`--slu-pipe=${listening.path}`]);
    const con = fakeConsole();
    const started = run({ electron: fx.electron, proc: p.proc, con, dist, preload: "/x/preload.cjs" });
    const socket = await listening.connection;
    sockets.push(socket);
    return { fx, p, con, started, cli: wireFrom(socket) };
  }

  it("moves to its own profile under the app's userData before ready, on the app's backend and switches", async () => {
    const { fx, started } = await start({});
    expect(fx.app.getPath).toHaveBeenCalledWith("userData");
    expect(fx.app.setPath).toHaveBeenCalledWith("userData", join(appUserData, "engine"));
    expect(fx.app.setPath).toHaveBeenCalledWith("sessionData", join(appUserData, "engine"));
    expect(fx.switches).toEqual(chromiumSwitches(CHOSEN, process.platform));
    expect(fx.app.requestSingleInstanceLock).not.toHaveBeenCalled();
    expect(fx.app.dock.hide).toHaveBeenCalled();
    expect(fx.windows).toEqual([]);
    fx.ready();
    await started;
  });

  it("takes the app's userData from SLU_USER_DATA as slu does", async () => {
    const { fx, started } = await start();
    expect(fx.app.getPath).not.toHaveBeenCalled();
    expect(fx.paths.userData).toBe(join(appUserData, "engine"));
    fx.ready();
    await started;
  });

  it("sends console.log and console.info to stderr, never stdout", async () => {
    const { fx, p, con, started } = await start();
    con.log("hello %d", 1);
    con.info("info");
    expect(p.stderr).toEqual(["hello 1\n", "info\n"]);
    expect(p.sink.out).toEqual([]);
    fx.ready();
    await started;
  });

  it("opens one hidden, unthrottled window on the engine page and hands it the port and the mirror", async () => {
    const { fx, p, started, cli } = await start();
    fx.ready();
    await started;
    expect(fx.windows).toHaveLength(1);
    const [win] = fx.windows;
    expect(win.options).toMatchObject({
      show: false,
      webPreferences: { preload: "/x/preload.cjs", contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    expect(win.webContents.urls).toEqual([ENGINE_PAGE]);
    expect(fx.electron.protocol.handle).toHaveBeenCalledWith("app", expect.any(Function));

    win.webContents.emit("did-finish-load");
    expect(win.webContents.sent).toEqual([["engine:port", null, [fx.ports.port2]]]);
    expect(fx.ports.port1.posted).toEqual([{ mirror }]);

    cli.socket.write('{"id":1,"type":"preview","photoId":"p","width":4,"height":4,"encoding":"png"}\n');
    await waitFor(() => fx.ports.port1.posted.length > 1);
    expect(fx.ports.port1.posted[1]).toMatchObject({ id: 1, type: "preview" });
    fx.ports.port1.emit("message", { data: { id: 1, type: "done" } });
    await waitFor(() => cli.out.length > 0);
    expect(cli.events()).toEqual([{ id: 1, type: "done" }]);
    expect(p.sink.out).toEqual([]);

    cli.socket.end();
    await waitFor(() => fx.exits.length > 0);
    expect(fx.exits).toEqual([0]);
  });

  it("stops with exit 0 when the CLI's connection closes before the page has loaded", async () => {
    const { fx, started, cli } = await start();
    fx.ready();
    await started;
    cli.socket.destroy();
    await waitFor(() => fx.exits.length > 0);
    expect(fx.exits).toEqual([0]);
  });

  it("refuses to start without a socket to talk on, saying so on stderr only", async () => {
    const fx = fakeElectron(appUserData);
    const p = fakeProcess({ SLU_USER_DATA: appUserData }, []);
    const con = fakeConsole();
    const started = run({ electron: fx.electron, proc: p.proc, con, dist, preload: "/x/preload.cjs" });
    fx.ready();
    await started;
    await waitFor(() => fx.exits.length > 0);
    expect(fx.exits).toEqual([3]);
    expect(fx.windows).toEqual([]);
    expect(con.error).toHaveBeenCalledWith(expect.stringContaining("--slu-pipe"));
    expect(p.sink.out).toEqual([]);
  });

  it("answers privileged channels for the engine page only, and never writes the app's backend cache", async () => {
    const before = { text: readFileSync(backendFile(), "utf8"), mtime: statSync(backendFile()).mtimeMs };
    const writes = [
      vi.spyOn(fs, "writeFileSync"),
      vi.spyOn(fs, "renameSync"),
      vi.spyOn(fs, "rmSync"),
      vi.spyOn(fs, "unlinkSync"),
      vi.spyOn(fs.promises, "writeFile"),
      vi.spyOn(fs.promises, "rename"),
      vi.spyOn(fs.promises, "rm"),
    ];
    const reads = vi.spyOn(fs, "readFileSync");
    const { fx, started } = await start();
    fx.ready();
    await started;
    expect(reads.mock.calls.some(([file]) => file === backendFile())).toBe(true);

    const [win] = fx.windows;
    win.webContents.emit("did-navigate", {}, ENGINE_PAGE);
    const fromEngine = { senderFrame: { url: ENGINE_PAGE, parent: null }, sender: win.webContents };
    const call = (channel: string, ...args: unknown[]) => fx.handlers.get(channel)!(fromEngine, ...args);

    expect(await call("gpu:backend")).toMatchObject({ backend: CHOSEN, software: false });
    await call("gpu:setSoftware", true);
    await call("gpu:setBackend", "gl");
    await call("gpu:rendererFailed", "stock program failed to link");
    await call("gpu:keepChange");
    await call("gpu:revertChange");
    await call("gpu:restart");
    await expect(call("mirror:writeSharedSettings", mirror)).rejects.toThrow("Not available to the engine.");

    const other = new FakeContents();
    const fromIndex = { senderFrame: { url: "app://bundle/index.html", parent: null }, sender: other };
    await expect(fx.handlers.get("fs:exists")!(fromIndex, appUserData)).rejects.toThrow("Not allowed");
    await expect(call("fs:exists", appUserData)).resolves.toBe(true);

    expect(readFileSync(backendFile(), "utf8")).toBe(before.text);
    expect(statSync(backendFile()).mtimeMs).toBe(before.mtime);
    const touched = writes.flatMap((spy) => spy.mock.calls.map(([file]) => String(file)));
    expect(touched.filter((file) => file.includes("gpu-backend"))).toEqual([]);
    expect(fx.app.relaunch).not.toHaveBeenCalled();
    expect(fx.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(fx.dialog.showErrorBox).not.toHaveBeenCalled();
  });

  // The engine must start the extensions the app starts, and the app alone owns
  // its disabled list, settings mirror and extension descriptors.
  it("reads the app's disabled list and writes none of the app's extension state", async () => {
    writeFileSync(join(appUserData, "extension-state.json"), JSON.stringify({ version: 1, disabled: ["off.one"] }));
    const { fx, started } = await start();
    fx.ready();
    await started;
    const [win] = fx.windows;
    win.webContents.emit("did-navigate", {}, ENGINE_PAGE);
    const fromEngine = { senderFrame: { url: ENGINE_PAGE, parent: null }, sender: win.webContents };
    const call = (channel: string, ...args: unknown[]) => fx.handlers.get(channel)!(fromEngine, ...args);

    await expect(call("plugins:readDisabled")).resolves.toEqual(["off.one"]);
    const descriptors = { version: 1, id: "a.b", extVersion: "1.0.0", name: "A", writtenAt: 1, stages: [], uniforms: [], panels: [], hasCatalogHooks: false };
    for (const [channel, arg] of [
      ["plugins:writeDisabled", []],
      ["mirror:writeSharedSettings", mirror],
      ["mirror:writeDescriptors", descriptors],
    ] as const) {
      await expect(call(channel, arg)).rejects.toThrow("Not available to the engine.");
    }
    expect(JSON.parse(readFileSync(join(appUserData, "extension-state.json"), "utf8")).disabled).toEqual(["off.one"]);
    expect(JSON.parse(readFileSync(join(appUserData, SHARED_SETTINGS_FILE), "utf8"))).toEqual(mirror);
    expect(fs.existsSync(join(appUserData, "extension-descriptors"))).toBe(false);
  });

  it("reports a missing engine page and exits 3 without opening a window", async () => {
    rmSync(join(dist, "engine.html"));
    const { fx, p, started, cli } = await start();
    fx.ready();
    await started;
    expect(fx.windows).toEqual([]);
    await waitFor(() => cli.out.length > 0);
    expect(p.sink.out).toEqual([]);
    expect(cli.events()).toEqual([
      { id: 0, type: "error", code: "internal", message: "This copy of Safelight has no engine page." },
    ]);
    await waitFor(() => fx.exits.length > 0);
    expect(fx.exits).toEqual([3]);
  });

  it("reports the graphics process dying and exits 3, without a probe relaunch", async () => {
    const { fx, p, started, cli } = await start();
    fx.ready();
    await started;
    fx.appEvents.emit("child-process-gone", {}, { type: "Utility", reason: "crashed" });
    await tick();
    expect(cli.out).toEqual([]);
    fx.appEvents.emit("child-process-gone", {}, { type: "GPU", reason: "crashed" });
    fx.appEvents.emit("child-process-gone", {}, { type: "GPU", reason: "crashed" });
    await waitFor(() => cli.out.length > 0);
    expect(p.sink.out).toEqual([]);
    expect(cli.events()).toEqual([
      { id: 0, type: "error", code: "render", message: "The graphics process stopped (crashed)." },
    ]);
    await waitFor(() => fx.exits.length > 0);
    expect(fx.exits).toEqual([3]);
    expect(fx.app.relaunch).not.toHaveBeenCalled();
    expect(readFileSync(backendFile(), "utf8")).toBe(`${CHOSEN}\nchosen\n`);
  });

  it("keeps the window on its page: no navigation, no window.open", async () => {
    const { fx, p, started, cli } = await start();
    fx.ready();
    await started;
    const [win] = fx.windows;
    const event = { preventDefault: vi.fn() };
    win.webContents.emit("will-navigate", event, "app://bundle/index.html");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]({ url: "https://x" })).toEqual({ action: "deny" });
    win.webContents.emit("did-navigate", {}, "app://bundle/index.html");
    await waitFor(() => cli.out.length > 0);
    expect(p.sink.out).toEqual([]);
    expect(cli.events()[0]).toMatchObject({ type: "error", code: "internal" });
  });
});

// ---------------------------------------------------------------------------
// preload.cjs, run in a VM with a faked Electron.

function loadPreload(href: string) {
  const exposed: Record<string, Record<string, unknown>> = {};
  const listeners = new Map<string, (event: unknown) => void>();
  const electron = {
    contextBridge: { exposeInMainWorld: (key: string, api: Record<string, unknown>) => void (exposed[key] = api) },
    ipcRenderer: {
      invoke: vi.fn(),
      on: (channel: string, fn: (event: unknown) => void) => void listeners.set(channel, fn),
      removeListener: vi.fn(),
    },
  };
  vm.runInNewContext(PRELOAD, {
    require: (name: string) => {
      if (name !== "electron") throw new Error(`unexpected require ${name}`);
      return electron;
    },
    process: { platform: "win32", versions: {}, arch: "x64", getSystemVersion: () => "10" },
    location: new URL(href),
  });
  return { native: exposed.safelightNative, listeners };
}

/** A DOM MessagePort: messages wait until start(). */
function fakeDomPort() {
  const handlers: Array<(e: { data: unknown }) => void> = [];
  const queued: unknown[] = [];
  let started = false;
  return {
    sent: [] as unknown[],
    addEventListener: (_type: string, fn: (e: { data: unknown }) => void) => void handlers.push(fn),
    start() {
      started = true;
      for (const data of queued.splice(0)) for (const fn of handlers) fn({ data });
    },
    postMessage(message: unknown) {
      this.sent.push(message);
    },
    close: vi.fn(),
    deliver(data: unknown) {
      if (started) for (const fn of handlers) fn({ data });
      else queued.push(data);
    },
  };
}

describe("the engine page's port in the preload", () => {
  type Engine = { onPort(cb: (port: unknown) => void): void };
  type StandIn = {
    postMessage(m: unknown): void;
    addEventListener(type: string, fn: (e: { data: unknown }) => void): void;
    close(): void;
  };

  it("is offered on the engine page only", () => {
    expect(loadPreload("app://bundle/index.html").native.engine).toBeUndefined();
    expect(loadPreload("app://bundle/index.html").listeners.has("engine:port")).toBe(false);
    expect(loadPreload(ENGINE_PAGE).native.engine).toBeDefined();
  });

  it("hands one taker a stand-in that relays both ways and loses no early message", () => {
    const { native, listeners } = loadPreload(ENGINE_PAGE);
    const engine = native.engine as Engine;
    const port = fakeDomPort();
    port.deliver({ mirror: null });
    listeners.get("engine:port")!({ ports: [port] });

    const taken: StandIn[] = [];
    engine.onPort((p) => void taken.push(p as StandIn));
    expect(taken).toHaveLength(1);
    expect(() => engine.onPort(() => {})).toThrow("already taken");

    const received: unknown[] = [];
    taken[0].addEventListener("message", (e) => void received.push(e.data));
    port.deliver({ id: 1, type: "export" });
    expect(received).toEqual([{ mirror: null }, { id: 1, type: "export" }]);

    taken[0].postMessage({ id: 1, type: "done" });
    expect(port.sent).toEqual([{ id: 1, type: "done" }]);
    taken[0].close();
    expect(port.close).toHaveBeenCalled();
  });

  it("waits for the port when the taker asks first", () => {
    const { native, listeners } = loadPreload(ENGINE_PAGE);
    const taker = vi.fn();
    (native.engine as Engine).onPort(taker);
    expect(taker).not.toHaveBeenCalled();
    listeners.get("engine:port")!({ ports: [fakeDomPort()] });
    expect(taker).toHaveBeenCalledTimes(1);
  });
});
