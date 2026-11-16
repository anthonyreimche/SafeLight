// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Native programs the person allows an extension to run (api.programs), such
// as the gmic command-line program for a G'MIC extension. The extension
// declares permissions.programs; the person picks the program in the native
// file dialogue (or has it found on PATH) and confirms in a second dialogue
// that names the extension and the full path; the extension is handed a random
// token for it, and the path stays in this file's record, so page script can
// never name a program of its own. A run happens in a fresh empty folder, with
// no shell and the arguments as given, streams what the program prints, and
// reads back the named output files. The grants file is in the app's own
// userData, the one the command-line tool's engine reads too.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");

const GRANTS_FILE = "program-grants.json";

const FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const WINDOWS_PROGRAM = /\.(?:exe|com)$/i;
const NOT_FOR_PROGRAMS = /^(?:LD_LIBRARY_PATH|APPDIR|APPIMAGE|ELECTRON_.*)$/i;
const SEARCH_NAME = /^[A-Za-z0-9._+-]{1,64}$/;
const EXTRA_SEARCH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

const MAX_ARGS = 4096;
const MAX_ARG_BYTES = 32 * 1024;
const MAX_OUTPUTS = 16;
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const OUTPUT_TAIL = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const OUTPUT_GAP_MS = 100;
const KILL_GRACE_MS = 3000;
const CLOSE_GRACE_MS = 2000;

/** Whether `name` may be a file in a run's folder: plain, short, and not
 *  something Windows treats as a device or quietly renames. */
function validFileName(name) {
  return (
    typeof name === "string" &&
    FILE_NAME.test(name) &&
    name !== "." &&
    name !== ".." &&
    !name.endsWith(".") &&
    !RESERVED_NAME.test(name.split(".")[0])
  );
}

const refusedName = (name) => new Error(`“${String(name).slice(0, 40)}” isn't a file name a program run can use.`);

/** The `outputs` of a run as { exact, prefixes }: a trailing `*` makes a name a prefix. */
function outputPatterns(outputs) {
  if (!Array.isArray(outputs) || outputs.length > 64) throw new Error("The outputs to read back must be a short list of names.");
  const exact = [];
  const prefixes = [];
  for (const entry of outputs) {
    if (typeof entry === "string" && entry.length > 1 && entry.endsWith("*")) {
      const prefix = entry.slice(0, -1);
      if (!FILE_NAME.test(prefix)) throw refusedName(entry);
      prefixes.push(prefix);
    } else {
      if (!validFileName(entry)) throw refusedName(entry);
      exact.push(entry);
    }
  }
  return { exact, prefixes };
}

/** The files of a run as [name, bytes], refusing a bad or repeated name. */
function inputFiles(files) {
  if (files == null) return [];
  if (typeof files !== "object" || Array.isArray(files)) throw new Error("The files to write must be names with bytes.");
  const seen = new Set();
  const out = [];
  for (const [name, bytes] of Object.entries(files)) {
    if (!validFileName(name)) throw refusedName(name);
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw new Error(`Two file names differ only by case: ${name}.`);
    seen.add(lower);
    if (!ArrayBuffer.isView(bytes)) throw new Error(`The contents of ${name} must be bytes.`);
    out.push([name, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]);
  }
  return out;
}

function checkedArgs(args) {
  const bad = () => new Error(`A program takes at most ${MAX_ARGS} arguments, each text up to 32 KB without a NUL.`);
  if (!Array.isArray(args) || args.length > MAX_ARGS) throw bad();
  for (const arg of args)
    if (typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > MAX_ARG_BYTES) throw bad();
  return args;
}

function childEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env))
    if (value !== undefined && !NOT_FOR_PROGRAMS.test(key)) out[key] = value;
  return out;
}

/** The grants a record holds, or null when it isn't one this build reads. */
function grantsOf(saved) {
  if (!saved || saved.version !== 1 || !saved.programs || typeof saved.programs !== "object") return null;
  const grants = new Map();
  for (const [token, entry] of Object.entries(saved.programs))
    if (entry && typeof entry.extension === "string" && typeof entry.path === "string" && path.isAbsolute(entry.path))
      grants.set(token, { extension: entry.extension, path: entry.path });
  return grants;
}

/** Keeps the last `limit` characters of what arrives. */
function createTail(limit) {
  const parts = [];
  let length = 0;
  return {
    add(text) {
      parts.push(text);
      length += text.length;
      while (parts.length > 1 && length - parts[0].length >= limit) length -= parts.shift().length;
    },
    text() {
      const all = parts.join("");
      return all.length > limit ? all.slice(all.length - limit) : all;
    },
  };
}

/**
 * @param {{
 *   userData: () => string,
 *   fileWriter: { write: (p: string, bytes: Uint8Array) => Promise<void> },
 *   findManifest: (id: string) => Promise<{ id: string, name: string, permissions?: { programs?: boolean } } | null>,
 *   showConsent: (event: unknown, ask: { name: string, path: string }) => Promise<boolean>,
 *   pickPath: (event: unknown, ask: { title: string | null, defaultPath: string | null, programsOnly: boolean }) => Promise<string | null>,
 *   tmpDir?: () => string,
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   spawn?: typeof childProcess.spawn,
 *   spawnSync?: typeof childProcess.spawnSync,
 * }} deps
 */
function createProgramAccess({
  userData,
  fileWriter,
  findManifest,
  showConsent,
  pickPath,
  tmpDir = () => os.tmpdir(),
  env = process.env,
  platform = process.platform,
  spawn = childProcess.spawn,
  spawnSync = childProcess.spawnSync,
}) {
  const file = () => path.join(userData(), GRANTS_FILE);
  /** token → the extension it was kept for and the program's path. */
  let grants = null;
  /** The record on disk couldn't be made sense of: it is moved aside before
   *  the first write, so nothing in it is lost without a trace. */
  let damaged = false;

  // A read refused for a moment (antivirus or backup holding the file) throws
  // and caches nothing, so no write ever replaces a record that wasn't read.
  function load() {
    if (grants) return grants;
    damaged = false;
    let text;
    try {
      text = fs.readFileSync(file(), "utf8");
    } catch (e) {
      if (e && e.code === "ENOENT") return (grants = new Map());
      throw e;
    }
    let read = null;
    try {
      read = grantsOf(JSON.parse(text));
    } catch {
      /* damaged, below */
    }
    if (!read) damaged = true;
    return (grants = read ?? new Map());
  }

  let saving = Promise.resolve();

  /** Change the grants to what `change` makes of a copy of what is on disk
   *  now (the app and the engine share the file), keeping the change only
   *  once it is written. Writes run one at a time. */
  function commit(change) {
    const run = saving.then(async () => {
      grants = null;
      const next = new Map(load());
      change(next);
      const out = { version: 1, programs: Object.fromEntries(next) };
      if (damaged) {
        await fs.promises.rename(file(), `${file()}.bad`);
        damaged = false;
      }
      await fileWriter.write(file(), new TextEncoder().encode(JSON.stringify(out)));
      grants = next;
    });
    saving = run.catch(() => {});
    return run;
  }

  /** The grant `token` names, if extension `id` holds it. A token the record
   *  in memory lacks may have been granted by the app since this process read
   *  the file, so the file is read again before it is turned down. */
  function owned(id, token) {
    const key = String(token);
    let entry = load().get(key);
    if (!entry) {
      grants = null;
      entry = load().get(key);
    }
    return entry && entry.extension === String(id) ? entry : null;
  }

  const sameFile = (a, b) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const keptOf = (token, entry) => ({ token, path: entry.path, name: path.basename(entry.path) });

  async function declares(id) {
    const manifest = await findManifest(String(id));
    return manifest && manifest.permissions && manifest.permissions.programs === true ? manifest : null;
  }

  /** `p` when it is an absolute path to a file this platform can run. */
  async function usable(p) {
    if (typeof p !== "string" || !path.isAbsolute(p)) return null;
    if (platform === "win32" && !WINDOWS_PROGRAM.test(p)) return null;
    try {
      return (await fs.promises.stat(p)).isFile() ? p : null;
    } catch {
      return null;
    }
  }

  /** Extensions with a dialogue open now. */
  const asking = new Set();

  /** Ask the person whether extension `id` may run `chosen`, unless it may
   *  already, and keep the answer. `replacing` is a token this one takes the
   *  place of. */
  async function keep(event, id, manifest, chosen, replacing) {
    const program = await usable(chosen);
    if (!program) return null;
    for (const [token, entry] of load())
      if (entry.extension === id && sameFile(entry.path, program)) return keptOf(token, entry);
    if (!(await showConsent(event, { name: String(manifest.name), path: program }))) return null;
    const token = crypto.randomUUID();
    await commit((all) => {
      if (replacing && all.get(replacing)?.extension === id) all.delete(replacing);
      all.set(token, { extension: id, path: program });
    });
    return keptOf(token, { path: program });
  }

  /** Run `ask` as the one dialogue extension `id` has open; asking again
   *  while one is open is turned down rather than stacked. */
  async function oneDialogue(id, ask) {
    const manifest = await declares(id);
    if (!manifest || asking.has(id)) return null;
    asking.add(id);
    try {
      return await ask(manifest);
    } finally {
      asking.delete(id);
    }
  }

  async function pick(event, id, options) {
    const key = String(id);
    load();
    const title = options && typeof options.title === "string" ? options.title.slice(0, 200) : null;
    const replacing = options && options.replacing != null ? String(options.replacing) : null;
    return oneDialogue(key, async (manifest) => {
      const previous = replacing ? owned(key, replacing) : null;
      const chosen = await pickPath(event, {
        title,
        defaultPath: previous ? previous.path : null,
        programsOnly: platform === "win32",
      });
      return chosen ? keep(event, key, manifest, chosen, previous ? replacing : null) : null;
    });
  }

  function searchDirs() {
    const key = Object.keys(env).find((k) => k.toLowerCase() === "path");
    const dirs = String((key && env[key]) || "")
      .split(path.delimiter)
      .filter((dir) => dir && path.isAbsolute(dir));
    return platform === "win32" ? dirs : [...dirs, ...EXTRA_SEARCH_DIRS];
  }

  async function find(name) {
    const names = platform === "win32" ? (WINDOWS_PROGRAM.test(name) ? [name] : [`${name}.exe`, `${name}.com`]) : [name];
    for (const dir of searchDirs()) {
      for (const candidate of names) {
        const full = path.join(dir, candidate);
        try {
          if (!(await fs.promises.stat(full)).isFile()) continue;
          if (platform !== "win32") await fs.promises.access(full, fs.constants.X_OK);
          return full;
        } catch {
          /* not here, or not runnable */
        }
      }
    }
    return null;
  }

  async function locate(event, id, name) {
    const key = String(id);
    load();
    const wanted = String(name);
    if (!SEARCH_NAME.test(wanted) || wanted === "." || wanted === "..") return null;
    return oneDialogue(key, async (manifest) => {
      const found = await find(wanted);
      return found ? keep(event, key, manifest, found, null) : null;
    });
  }

  async function list(id) {
    return [...load()].filter(([, entry]) => entry.extension === String(id)).map(([token, entry]) => keptOf(token, entry));
  }

  async function forget(id, token) {
    if (!owned(id, token)) return;
    await commit((all) => void all.delete(String(token)));
  }

  /** Forget every program extension `id` was allowed: it was uninstalled, and
   *  another extension installed later under its id must not inherit them. */
  async function forgetExtension(id) {
    if (![...load().values()].some((entry) => entry.extension === String(id))) return;
    await commit((all) => {
      for (const [token, entry] of all) if (entry.extension === String(id)) all.delete(token);
    });
  }

  /** run id → what is known of the run, from its first line until it ends. */
  const runs = new Map();
  const watched = new WeakSet();

  function signalGroup(pid, signal) {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  }

  /** Stop the program of `run` and everything it started. `hard` is for a
   *  quitting app: nothing is waited for. */
  function stop(run, reason, hard = false) {
    if (run.reason) return;
    run.reason = reason;
    const child = run.child;
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    if (platform === "win32") {
      const taskkill = path.join(env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
      const args = ["/pid", String(child.pid), "/t", "/f"];
      if (hard) spawnSync(taskkill, args, { windowsHide: true, stdio: "ignore", timeout: 3000 });
      else spawn(taskkill, args, { windowsHide: true, stdio: "ignore" }).once("error", () => child.kill());
      return;
    }
    signalGroup(child.pid, hard ? "SIGKILL" : "SIGTERM");
    if (hard) return;
    const timer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  }

  /** Stop the runs of the window `senderId` when it goes. */
  function watch(sender) {
    if (!sender || watched.has(sender)) return;
    watched.add(sender);
    const senderId = sender.id;
    const end = () => {
      for (const run of runs.values()) if (run.senderId === senderId) stop(run, "cancelled");
    };
    sender.once("destroyed", end);
    sender.on("render-process-gone", end);
  }

  /** What the program prints, sent to the window as it comes, at most twice
   *  (once per stream) every OUTPUT_GAP_MS. */
  function createOutputSender(sender, runId) {
    const pending = { stdout: "", stderr: "" };
    let last = 0;
    let timer = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      last = Date.now();
      for (const stream of ["stdout", "stderr"]) {
        const text = pending[stream];
        pending[stream] = "";
        if (!text) continue;
        try {
          if (!sender.isDestroyed()) sender.send("programs:output", { runId, stream, text });
        } catch {
          /* the window went between the check and the send */
        }
      }
    };
    return {
      push(stream, text) {
        if (!text) return;
        pending[stream] += text;
        if (!timer) timer = setTimeout(flush, Math.max(0, OUTPUT_GAP_MS - (Date.now() - last)));
      },
      end: flush,
    };
  }

  async function readOutputs(dir, outputs) {
    const { exact, prefixes } = outputPatterns(outputs);
    const names = new Set(exact);
    if (prefixes.length) {
      for (const name of await fs.promises.readdir(dir))
        if (validFileName(name) && prefixes.some((prefix) => name.startsWith(prefix))) names.add(name);
    }
    const found = [];
    let total = 0;
    for (const name of [...names].sort()) {
      let stat;
      try {
        stat = await fs.promises.lstat(path.join(dir, name));
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      total += stat.size;
      found.push(name);
      if (found.length > MAX_OUTPUTS) throw new Error(`The program left more than ${MAX_OUTPUTS} files to read back.`);
      if (total > MAX_OUTPUT_BYTES) throw new Error("The files the program left are over 1 GB.");
    }
    const files = {};
    for (const name of found) {
      const bytes = await fs.promises.readFile(path.join(dir, name));
      files[name] = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    return files;
  }

  const stopped = (run) => ({ exitCode: null, killed: run.reason, stdout: "", stderr: "", files: {} });

  function execute(run, program, args, dir, options, sender) {
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.min(Math.max(Math.floor(options.timeoutMs), 1), MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
    const output = options.stream === true && sender ? createOutputSender(sender, run.id) : null;
    const tails = { stdout: createTail(OUTPUT_TAIL), stderr: createTail(OUTPUT_TAIL) };
    const decoders = { stdout: new TextDecoder("utf-8"), stderr: new TextDecoder("utf-8") };
    const take = (stream, text) => {
      if (!text) return;
      tails[stream].add(text);
      if (output) output.push(stream, text);
    };
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(program, args, {
          cwd: dir,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: childEnv(env),
          detached: platform !== "win32",
        });
      } catch (e) {
        reject(new Error(`The program couldn't start: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
      run.child = child;
      let started = false;
      let timeout = null;
      let grace = null;
      child.once("spawn", () => {
        started = true;
        timeout = setTimeout(() => stop(run, "timeout"), timeoutMs);
      });
      child.once("error", (e) => {
        if (started) return;
        clearTimeout(timeout);
        reject(new Error(`The program couldn't start: ${e.message}`));
      });
      for (const stream of ["stdout", "stderr"])
        child[stream].on("data", (chunk) => take(stream, decoders[stream].decode(chunk, { stream: true })));
      child.once("exit", () => {
        grace = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        }, CLOSE_GRACE_MS);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        clearTimeout(grace);
        for (const stream of ["stdout", "stderr"]) take(stream, decoders[stream].decode());
        if (output) output.end();
        if (!started) return;
        resolve({ code, stdout: tails.stdout.text(), stderr: tails.stderr.text() });
      });
    });
  }

  /** Run program `token` of extension `id` with `args` in a fresh folder
   *  holding `options.files`, and read back `options.outputs`. Resolves once
   *  the program has stopped, with its exit code, its output and the files. */
  async function run(event, id, runId, token, args, options) {
    const key = String(id);
    const runKey = String(runId);
    const sender = event && event.sender ? event.sender : null;
    if (!runKey || runKey.length > 128 || runs.has(runKey)) throw new Error("That run id is already in use.");
    const opts = options && typeof options === "object" ? options : {};
    const state = { id: runKey, senderId: sender ? sender.id : null, child: null, reason: null };
    runs.set(runKey, state);
    watch(sender);
    let dir = null;
    try {
      const argv = checkedArgs(args);
      const entry = owned(key, token);
      if (!entry) throw new Error("That isn't one this extension kept.");
      if (!(await declares(key))) throw new Error("This extension doesn't declare the programs permission.");
      const program = await usable(entry.path);
      if (!program) throw new Error("The program is gone: its file isn't there or can't be run.");
      const files = inputFiles(opts.files);
      outputPatterns(opts.outputs ?? []);
      if (state.reason) return stopped(state);
      dir = await fs.promises.mkdtemp(path.join(tmpDir(), "safelight-run-"));
      for (const [name, bytes] of files) await fs.promises.writeFile(path.join(dir, name), bytes, { flag: "wx" });
      if (state.reason) return stopped(state);
      const ran = await execute(state, program, argv, dir, opts, sender);
      if (state.reason) return { exitCode: null, killed: state.reason, stdout: ran.stdout, stderr: ran.stderr, files: {} };
      const read = opts.outputs && opts.outputs.length ? await readOutputs(dir, opts.outputs) : {};
      return { exitCode: ran.code, killed: null, stdout: ran.stdout, stderr: ran.stderr, files: read };
    } finally {
      runs.delete(runKey);
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    }
  }

  /** Stop run `runId` if the window asking started it. */
  async function cancel(event, runId) {
    const state = runs.get(String(runId));
    if (state && event && event.sender && state.senderId === event.sender.id) stop(state, "cancelled");
  }

  /** Stop every run, at once: the app is quitting. */
  function killAll() {
    for (const state of runs.values()) stop(state, "cancelled", true);
  }

  return { pick, locate, list, forget, forgetExtension, run, cancel, killAll };
}

module.exports = { createProgramAccess, validFileName, GRANTS_FILE };
