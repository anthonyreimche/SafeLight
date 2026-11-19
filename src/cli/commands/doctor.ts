// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { backendChoices, backendCacheFiles, parseBackendCache, SOFTWARE_BACKEND } from "../../../electron/gpu-backend.cjs";
import { readLock, STALE_MS } from "../../../electron/file-lock.cjs";
import type { SharedSettings } from "@/state/shared-settings";
import { readDescriptors, readSharedSettings } from "../mirror";
import type { DoctorCheck, DoctorItem } from "../output/types";
import { detectGraphicsMode } from "../terminal-image";
import type { CommandContext, CommandSpec, GraphicsMode, InstalledExtension } from "../types";
import { COMMAND } from "../types";

// A GUI is taken to be running while its mirror's heartbeat is this fresh (it
// rewrites the file every 60 s).
const HEARTBEAT_FRESH_MS = 3 * 60 * 1000;

const OPEN_ONCE = "Open Safelight once.";

/** The app looks to be running: its settings carry a pid and a fresh heartbeat. */
export function guiLooksRunning(shared: SharedSettings | null, now: number = Date.now()): boolean {
  return shared !== null && shared.guiPid !== null && now - shared.writtenAt < HEARTBEAT_FRESH_MS;
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 120) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

export async function gpuItem(ctx: Pick<CommandContext, "env">): Promise<DoctorItem> {
  const { userData, platform } = ctx.env;
  const file = backendCacheFiles(userData, platform, ctx.env.env).file;
  const text = file ? await readFile(file, "utf8").catch(() => null) : null;
  if (text === null) {
    return { label: "Graphics", value: "not known yet: open Safelight once", status: "info", hint: "Open Safelight once so it records its graphics backend." };
  }
  const cache = parseBackendCache(text, backendChoices(platform, false));
  const backend = cache.backend ?? cache.elsewhere;
  if (!backend) return { label: "Graphics", value: "not known yet: open Safelight once", status: "info", hint: "Open Safelight once so it records its graphics backend." };
  if (backend === SOFTWARE_BACKEND) {
    return {
      label: "Graphics", value: "software rendering (exports are slower)", status: "warn",
      hint: "A graphics driver update usually lets Safelight use the GPU.",
    };
  }
  return { label: "Graphics", value: backend, status: "ok" };
}

async function extensionItems(ctx: CommandContext): Promise<DoctorItem[]> {
  let installed: InstalledExtension[];
  try {
    installed = await ctx.extensions.installed();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [{ label: "Extensions", value: `can't list them: ${reason}`, status: "warn", hint: "Check the network; HTTPS_PROXY sets a proxy." }];
  }
  const descriptors = readDescriptors(ctx.env.userData, installed);
  const missing = installed.filter((e) => !descriptors.has(e.id));
  const hooks = installed.filter((e) => e.enabled && descriptors.get(e.id)?.hasCatalogHooks);
  const items: DoctorItem[] = [{ label: "Extensions", value: `${installed.length} installed`, status: "info" }];
  if (missing.length > 0) {
    items.push({
      label: "Extension ranges",
      value: `unknown for ${missing.map((e) => e.name).join(", ")}: open Safelight once`,
      status: "warn",
      hint: "Safelight writes each extension's ranges the first time it runs with it.",
    });
  }
  if (hooks.length > 0) {
    items.push({
      label: "Catalogue hooks",
      value: `${hooks.map((e) => e.name).join(", ")} run when Safelight saves an edit, not for ${COMMAND}`,
      status: "warn",
      hint: "Make edits that need them in Safelight.",
    });
  }
  return [...items, ...(await extensionCommandItems(ctx))];
}

/** The verbs extensions add, and each declared command that didn't become one. */
async function extensionCommandItems(ctx: CommandContext): Promise<DoctorItem[]> {
  // index.ts builds the registry from this file, so it is read once doctor runs.
  const { COMMANDS, extensionVerbs } = await import("./index");
  const { specs, skipped } = extensionVerbs(COMMANDS, ctx.env.userData);
  if (specs.length === 0 && skipped.length === 0) return [];
  const label = "Extension commands";
  return [
    { label, value: specs.length > 0 ? specs.map((s) => s.verb).join(", ") : "none", status: "info" },
    ...skipped.map((s): DoctorItem => ({
      label,
      value: `${s.extension}: ${s.reason}; not offered`,
      status: "warn",
      hint: "Turn one of the extensions off, or ask its author to rename the command.",
    })),
  ];
}

async function lockItem(ctx: CommandContext): Promise<DoctorItem> {
  const project = await ctx.projects.find(ctx.env.cwd);
  if (!project) return { label: "Project", value: "no catalogue holds this folder", status: "info" };
  const lock = await readLock(path.join(project.workingDir, "writer.lock"));
  if (!lock) return { label: "Project", value: `${project.root}: free to write`, status: "ok" };
  const fresh = Date.now() - lock.refreshedAt < STALE_MS;
  return {
    label: "Project",
    value: `${project.root}: ${fresh ? `held by ${lock.app} (pid ${lock.pid})` : `stale lock from ${lock.app}, ${COMMAND} will take it over`}`,
    status: fresh ? "warn" : "info",
    ...(fresh && { hint: "Close the folder in Safelight, or add --wait to a command." }),
  };
}

function networkItem(ctx: CommandContext): DoctorItem {
  const { env } = ctx.env;
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  const certs = env.NODE_EXTRA_CA_CERTS;
  const parts = [
    proxy ? `proxy ${proxy}` : `no proxy set (${COMMAND} ignores the system proxy; set HTTPS_PROXY if you need one)`,
    certs ? `extra certificates ${certs}` : "system certificates only if NODE_USE_SYSTEM_CA=1",
  ];
  return { label: "Network", value: parts.join("; "), status: "info" };
}

/** Where real pictures come from, for a terminal that is left with blocks. */
function picturesHint(ctx: CommandContext, mode: GraphicsMode): { hint: string } | Record<string, never> {
  if (mode !== "blocks") return {};
  if (ctx.env.platform === "win32" && ctx.env.env.WT_SESSION) return { hint: "Windows Terminal 1.22 or newer shows real pictures." };
  return { hint: "A terminal with kitty, iTerm2 or sixel pictures shows real ones; --graphics picks a mode." };
}

function settingsItem(ctx: CommandContext): DoctorItem {
  const shared = readSharedSettings(ctx.env.userData);
  if (!shared) return { label: "Settings", value: "not shared yet: open Safelight once", status: "warn", hint: OPEN_ONCE };
  const running = guiLooksRunning(shared);
  return { label: "Settings", value: `shared ${ago(Date.now() - shared.writtenAt)}${running ? "; Safelight looks to be running" : ""}`, status: "ok" };
}

/** What doctor checks, in order; each settles into one item or a few. */
export function doctorChecks(ctx: CommandContext): DoctorCheck[] {
  return [
    {
      label: "Safelight",
      run: async () => [
        { label: "Version", value: `Safelight Unplugged ${ctx.env.appVersion}`, status: "info" },
        { label: "App", value: ctx.env.appRoot, status: "info" },
        ctx.env.electronBinary === null
          ? { label: "Engine", value: "not found: build the app first, or set SAFELIGHT_ELECTRON", status: "fail", hint: "Build the app, or set SAFELIGHT_ELECTRON to its Electron binary." }
          : { label: "Engine", value: ctx.env.electronBinary, status: "info" },
        { label: "Profile", value: ctx.env.userData, status: "info" },
      ],
    },
    { label: "Graphics", run: () => gpuItem(ctx) },
    { label: "Settings", run: async () => settingsItem(ctx) },
    { label: "Extensions", run: () => extensionItems(ctx) },
    {
      label: "Terminal images",
      run: async () => {
        const mode = await detectGraphicsMode(ctx.env);
        return { label: "Terminal images", value: `${mode.mode} (${mode.reason})`, status: "info", ...picturesHint(ctx, mode.mode) };
      },
    },
    { label: "Project", run: () => lockItem(ctx) },
    { label: "Network", run: async () => networkItem(ctx) },
  ];
}

export async function doctorItems(ctx: CommandContext): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  for (const check of doctorChecks(ctx)) items.push(...[await check.run()].flat());
  return items;
}

export const doctorCommand: CommandSpec = {
  verb: "doctor",
  group: "More",
  summary: `Checks the version, the app ${COMMAND} runs with, the GPU backend, terminal images, the project lock and extensions.`,
  usage: "doctor",
  examples: [
    `${COMMAND} doctor`,
  ],
  options: [],
  writes: false,
  async run(ctx) {
    const items = ctx.json ? await doctorItems(ctx) : await ctx.out.checklist(doctorChecks(ctx));
    const code = items.some((i) => i.status === "fail") ? 1 : 0;
    return ctx.json ? { code, json: { slu: 1, items } } : { code };
  },
};
