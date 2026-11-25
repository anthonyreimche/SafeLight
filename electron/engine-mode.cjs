// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Engine mode: what `safelight --engine` runs instead of the app, for `slu`'s
// export and preview. One hidden window on app://bundle/engine.html renders
// with the app's own bundle, extensions and graphics backend; this process
// relays between `slu` and that page.
//
//   slu --socket, JSON lines--> main --MessagePort--> engine page
//   slu <--socket, wire-------- main <--MessagePort-- engine page
//
// `slu` listens on a local socket and passes its path as --slu-pipe=<path>; the
// engine connects to it as it starts. Not stdio: on Windows, Electron's main
// process sees a stdin pipe end at once. When the socket closes, the engine
// exits 0.
//
// The first port message is { mirror: SharedSettings | null }, the app's
// settings for the page to load before it boots. After it, each socket line is
// posted as the parsed EngineRequest. The page posts EngineEvent objects, which
// go out as wire kind 0, and image bytes as { frame: number, bytes:
// ArrayBuffer | Uint8Array }, which go out as kind 1 (src/engine/protocol.ts).
// console.log and console.info go to stderr, which `slu -vv` prints.
//
// Its own Chromium profile at <app userData>/engine, so its storage and RAW
// cache never touch the app's. Everything else is the app's, read: the
// extensions in <app userData>/plugins and the graphics backend the app's next
// launch starts on. The engine never writes that backend cache, which would
// move the app onto another backend, and never probes: if the graphics process
// dies it reports an error and exits 3. No single-instance lock, no updater, no
// OS-open, no dialogs.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const nodeNet = require("node:net");
const path = require("node:path");
const readline = require("node:readline");
const util = require("node:util");
const {
  SOFTWARE_BACKEND,
  backendCacheFiles,
  backendChoices,
  backendState,
  gpuLadder,
  parseBackendCache,
} = require("./gpu-backend.cjs");
const { appendSwitches, chromiumSwitches } = require("./chromium-switches.cjs");
const { buildCSP, galleryOriginsFrom, registerAppScheme, serveAppProtocol } = require("./app-protocol.cjs");
const { guardPrivileged, isEngineUrl } = require("./window-policy.cjs");
const { createAtomicWriter } = require("./atomic-write.cjs");
const { retry } = require("./plugin-files.cjs");
const { createCrashLog, installMainErrorHandlers, isMainFrameLoadFailure } = require("./crash-recovery.cjs");
const {
  declaredConnectHosts,
  listDevManifests,
  listInstalledManifestsAsync,
  readDevFolder,
  devExtensionDirs,
} = require("./extension-origins.cjs");
const { readSocketGrantOrigins, GRANTS_FILE: SOCKET_GRANTS_FILE } = require("./socket-access.cjs");
const { createExtensionStore } = require("./extension-store/index.cjs");
const { ipcChannels, registerIpc } = require("./ipc/index.cjs");

const ENGINE_PAGE = "app://bundle/engine.html";
const ENGINE_DIR = "engine";
const MIRROR_FILE = "shared-settings.json";
const DIST = path.join(__dirname, "..", "dist");

const WIRE_JSON = 0;
const WIRE_FRAME = 1;

/** `slu` maps this exit code to "the engine failed". */
const ENGINE_FAILED = 3;

// As the app grants them (main.cjs).
const ALLOWED_PERMISSIONS = new Set([
  "fileSystem",
  "file-system-access",
  "clipboard-sanitized-write",
  "persistent-storage",
]);

/** Channels that would change the app's own settings or install a new app.
 *  The app alone writes its settings mirror, descriptors and disabled list;
 *  the engine reads them from the app's userData like every other channel. */
const ENGINE_REFUSED = new Set([
  "updates:install",
  "mirror:writeSharedSettings",
  "mirror:writeDescriptors",
  "plugins:writeDisabled",
  "devtools:sync-dev-folder",
  "programs:forget",
]);

const refuse = async () => {
  throw new Error("Not available to the engine.");
};

// A hidden window has nobody to answer a dialogue: every pick is cancelled and
// every question gets its cancel answer, which for a consent prompt is no.
const NO_DIALOG = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showMessageBox: async (...args) => ({ response: args[args.length - 1]?.cancelId ?? 0, checkboxChecked: false }),
};
const NO_SHELL = {
  openExternal: refuse,
  openPath: refuse,
  showItemInFolder: () => {},
  trashItem: refuse,
};
const NO_WINDOWS = { open: () => false, close: () => false, focusMain: () => {} };

/** [u8 kind][u32le length][payload], as encodeWire in src/engine/protocol.ts. */
function encodeWire(kind, payload) {
  const out = Buffer.alloc(5 + payload.length);
  out.writeUInt8(kind, 0);
  out.writeUInt32LE(payload.length, 1);
  out.set(payload, 5);
  return out;
}

function eventWire(event) {
  return encodeWire(WIRE_JSON, Buffer.from(JSON.stringify(event), "utf8"));
}

function frameWire(frame, bytes) {
  const view =
    bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payload = Buffer.alloc(4 + view.length);
  payload.writeUInt32LE(frame, 0);
  payload.set(view, 4);
  return encodeWire(WIRE_FRAME, payload);
}

const isFrameMessage = (data) =>
  Number.isInteger(data.frame) &&
  data.frame >= 0 &&
  (data.bytes instanceof ArrayBuffer || ArrayBuffer.isView(data.bytes));

/** The wire bytes for a message the page posted, or null for one that is
 *  neither an event nor a frame. */
function wireFor(data) {
  if (!data || typeof data !== "object") return null;
  if (isFrameMessage(data)) return frameWire(data.frame, data.bytes);
  if (typeof data.type === "string") return eventWire(data);
  return null;
}

const isRequest = (value) =>
  !!value && typeof value === "object" && Number.isInteger(value.id) && typeof value.type === "string";

/** Relays `input`'s JSON lines to `port` and `port`'s messages to `output` as
 *  wire; both are `slu`'s socket in engine mode. `end` runs once: on the input's
 *  end, after a shutdown request is passed on, or when `output` fails (`slu`
 *  went away). */
function createRelay({ input, output, port, end }) {
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    end();
  };
  const send = (bytes) => {
    if (!output.destroyed && !output.writableEnded) output.write(bytes);
  };
  output.on("error", finish);
  port.on("message", ({ data }) => {
    const wire = wireFor(data);
    if (wire) send(wire);
    else console.warn("[engine] dropped a page message that is neither an event nor a frame");
  });
  port.start();
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (ended || line.trim() === "") return;
    let request = null;
    try {
      request = JSON.parse(line);
    } catch {}
    if (!isRequest(request)) {
      send(eventWire({ id: 0, type: "log", level: "error", message: `Not a request: ${line.slice(0, 200)}` }));
      return;
    }
    port.postMessage(request);
    if (request.type === "shutdown") finish();
  });
  lines.on("close", finish);
}

/** The backend the app's next launch starts on, from its cache, which this
 *  only reads. Software stays software even when the app is due to retry the
 *  graphics card: the engine has no probe to fall back with. */
function readEngineBackend({ readFile, userData, platform, env }) {
  const isWayland = platform === "linux" && !!env.WAYLAND_DISPLAY;
  const ladder = gpuLadder(platform, isWayland);
  const choices = backendChoices(platform, isWayland);
  const { file, legacy } = backendCacheFiles(userData, platform, env);
  let cache = parseBackendCache("", choices);
  for (const candidate of [file, legacy]) {
    if (!candidate) continue;
    try {
      cache = parseBackendCache(readFile(candidate), choices);
      break;
    } catch { /* not there */ }
  }
  return { backend: cache.backend ?? ladder[0], cache, ladder, choices };
}

/** The app's settings mirror (src/state/shared-settings.ts), or null. */
function readMirror(readFile, userData) {
  try {
    const doc = JSON.parse(readFile(path.join(userData, MIRROR_FILE)));
    return doc && doc.version === 1 && doc.storage && typeof doc.storage === "object" ? doc : null;
  } catch {
    return null;
  }
}

/** The network origins the app's CSP allows this launch, read the way main.cjs
 *  reads them. */
async function launchHosts(userData, pluginsDir) {
  const manifests = [
    ...(await listInstalledManifestsAsync(pluginsDir)),
    ...(await listDevManifests(await readDevFolder(path.join(userData, "dev-folder.json")))),
  ];
  const allowedSockets = await readSocketGrantOrigins(path.join(userData, SOCKET_GRANTS_FILE), manifests);
  return [...new Set([...declaredConnectHosts(manifests), ...allowedSockets])];
}

/** The app's IPC table with ENGINE_REFUSED answering an error. */
function engineChannels(channels) {
  return channels.map((c) => (ENGINE_REFUSED.has(c.channel) ? { ...c, handler: refuse } : c));
}

function sendConsoleToStderr(con, stderr) {
  const toStderr = (...args) => {
    stderr.write(`${util.format(...args)}\n`);
  };
  con.log = toStderr;
  con.info = toStderr;
  con.debug = toStderr;
}

const PIPE_ARG = "--slu-pipe=";

/** The socket path `slu` passed, or null. */
function pipeArg(argv) {
  const arg = argv.find((a) => a.startsWith(PIPE_ARG));
  return arg ? arg.slice(PIPE_ARG.length) : null;
}

const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);

/** Starts engine mode. Must run before app `ready`. Resolves once the engine
 *  page is loading, or once startup has failed. */
function run({
  electron = require("electron"),
  proc = process,
  con = console,
  dist = DIST,
  preload = path.join(__dirname, "preload.cjs"),
} = {}) {
  const { app, protocol, BrowserWindow, MessageChannelMain, ipcMain, net, session, safeStorage } = electron;
  sendConsoleToStderr(con, proc.stderr);
  const crashLog = createCrashLog();
  installMainErrorHandlers(proc, crashLog, con.error);

  const appUserData = proc.env.SLU_USER_DATA ? path.resolve(proc.env.SLU_USER_DATA) : app.getPath("userData");
  const engineUserData = path.join(appUserData, ENGINE_DIR);
  app.setPath("userData", engineUserData);
  app.setPath("sessionData", engineUserData);
  const pluginsDir = () => path.join(appUserData, "plugins");
  const readFile = (file) => fs.readFileSync(file, "utf8");

  const gpu = readEngineBackend({ readFile, userData: appUserData, platform: proc.platform, env: proc.env });
  appendSwitches(app.commandLine, chromiumSwitches(gpu.backend, proc.platform));
  registerAppScheme(protocol);
  app.dock?.hide();

  const fileWriter = createAtomicWriter({
    fsp: fs.promises,
    randomId: () => crypto.randomBytes(8).toString("hex"),
    retry,
  });

  /** `slu`'s socket, which carries the wire both ways. */
  let link = null;
  const linkOpen = () => link !== null && !link.destroyed;
  const endLink = () =>
    new Promise((resolve) => {
      if (linkOpen()) link.end(resolve);
      else resolve();
    });

  const shutdownHooks = [];
  let stopping = false;
  const stop = async (code) => {
    if (stopping) return;
    stopping = true;
    for (const hook of shutdownHooks) hook();
    await within(fileWriter.drain(), 5000);
    await within(endLink(), 2000);
    app.exit(code);
  };
  const fail = (code, message) => {
    if (stopping) return;
    con.error(`[engine] ${message}`);
    if (linkOpen()) link.write(eventWire({ id: 0, type: "error", code, message }));
    void stop(ENGINE_FAILED);
  };

  const pipe = pipeArg(proc.argv);
  if (!pipe) {
    fail("internal", "Started without --slu-pipe: the engine runs only for the safelight command.");
    return Promise.resolve();
  }
  link = nodeNet.connect(pipe);
  link.on("error", (e) => con.error(`[engine] the connection to safelight failed: ${e.message}`));
  link.on("close", () => void stop(0));

  // Electron's default for an uncaught exception is a dialogue nobody can see.
  proc.on("uncaughtException", (e) => fail("internal", e instanceof Error ? e.message : String(e)));

  app.on("child-process-gone", (_e, details) => {
    crashLog.record(details.type, details);
    if (details.type === "GPU" && details.reason !== "clean-exit") {
      fail("render", `The graphics process stopped (${details.reason}).`);
    }
  });

  const committedUrls = new WeakMap();
  app.on("web-contents-created", (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("did-navigate", (_event, url) => {
      committedUrls.set(contents, url);
      if (!isEngineUrl(url)) fail("internal", `The engine window left its page for ${url}.`);
    });
    contents.on("render-process-gone", (_event, details) => {
      crashLog.record("renderer", details);
      fail("render", `The engine page stopped (${details.reason}).`);
    });
  });
  app.on("window-all-closed", () => fail("internal", "The engine window closed."));

  const gpuState = () =>
    backendState(gpu.backend, gpu.cache, gpu.ladder, Date.now(), app.getVersion(), gpu.choices);
  const isSoftware = () => gpu.backend === SOFTWARE_BACKEND;

  return app
    .whenReady()
    .then(async () => {
      session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
      session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
      // The protocol serves the app's index for a file it lacks, which would
      // boot the whole app in this window with the engine's privileges.
      if (!fs.existsSync(path.join(dist, "engine.html"))) {
        fail("internal", "This copy of Safelight has no engine page.");
        return;
      }

      const hosts = await launchHosts(appUserData, pluginsDir());
      const csp = buildCSP(galleryOriginsFrom(proc.env), hosts);
      const devExtensions = devExtensionDirs();
      devExtensions.setFolder(await readDevFolder(path.join(appUserData, "dev-folder.json")));
      serveAppProtocol({ protocol, net, dist, pluginsDir, devExtensionDir: devExtensions.dirFor, csp: () => csp });

      const userData = () => appUserData;
      const channels = ipcChannels({
        app,
        BrowserWindow,
        shell: NO_SHELL,
        dialog: NO_DIALOG,
        safeStorage,
        appVersion: () => app.getVersion(),
        takeOsOpen: () => null,
        store: createExtensionStore({
          net,
          userData,
          fileWriter,
          appVersion: () => app.getVersion(),
          pluginsDir,
          pluginWorkDir: () => path.join(appUserData, "plugins-update"),
        }),
        listPlugins: () => listInstalledManifestsAsync(pluginsDir()),
        installReleaseOnce: refuse,
        updateHost: () => ({ platform: proc.platform, execPath: proc.execPath, env: proc.env, osRelease: "" }),
        userData,
        fileWriter,
        crashLog,
        devFolderFile: () => path.join(appUserData, "dev-folder.json"),
        extensionConnectHosts: () => hosts,
        gpuBackendState: gpuState,
        saveMaterial: () => {},
        isSoftware,
        setSoftwareRendering: gpuState,
        setGraphicsBackend: gpuState,
        rendererFailed: (detail) => {
          con.error(`[engine] the develop renderer couldn't start (${detail})`);
          return gpuState();
        },
        keepChange: gpuState,
        revertChange: gpuState,
        restartApp: () => {},
        appWindows: NO_WINDOWS,
        onShutdown: (hook) => void shutdownHooks.push(hook),
      });
      registerIpc(engineChannels(channels), {
        ipcMain,
        handlePrivileged: (channel, handler) =>
          ipcMain.handle(channel, guardPrivileged(channel, handler, { committedUrls, engine: true })),
      });

      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          preload,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      const { port1, port2 } = new MessageChannelMain();
      win.webContents.once("did-finish-load", () => {
        win.webContents.postMessage("engine:port", null, [port2]);
        port1.postMessage({ mirror: readMirror(readFile, appUserData) });
        createRelay({ input: link, output: link, port: port1, end: () => void stop(0) });
      });
      win.webContents.on("did-fail-load", (_e, errorCode, description, url, isMainFrame) => {
        if (isMainFrameLoadFailure(errorCode, isMainFrame)) fail("internal", `${url} did not load (${errorCode} ${description}).`);
      });
      // did-fail-load reports a failed load.
      win.loadURL(ENGINE_PAGE).catch(() => {});
    })
    .catch((e) => fail("internal", `The engine could not start: ${e instanceof Error ? e.message : String(e)}`));
}

module.exports = {
  ENGINE_PAGE,
  ENGINE_REFUSED,
  encodeWire,
  wireFor,
  createRelay,
  readEngineBackend,
  readMirror,
  engineChannels,
  run,
};
