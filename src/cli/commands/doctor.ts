// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { backendChoices, backendCacheFiles, parseBackendCache, SOFTWARE_BACKEND } from "../../../electron/gpu-backend.cjs";
import { readLock } from "../../../electron/file-lock.cjs";
import { readDescriptors, readSharedSettings } from "../mirror";
import type { DoctorItem } from "../output/types";
import { detectGraphicsMode } from "../terminal-image";
import type { CommandContext, CommandSpec, InstalledExtension } from "../types";

// A GUI is taken to be running while its mirror's heartbeat is this fresh (it
// rewrites the file every 60 s).
const HEARTBEAT_FRESH_MS = 3 * 60 * 1000;

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 120) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

async function gpuItem(ctx: CommandContext): Promise<DoctorItem> {
  const { userData, platform } = ctx.env;
  const file = backendCacheFiles(userData, platform, ctx.env.env).file;
  const text = file ? await readFile(file, "utf8").catch(() => null) : null;
  if (text === null) {
    return { label: "Graphics", value: "not known yet: open Safelight once", status: "info" };
  }
  const cache = parseBackendCache(text, backendChoices(platform, false));
  const backend = cache.backend ?? cache.elsewhere;
  if (!backend) return { label: "Graphics", value: "not known yet: open Safelight once", status: "info" };
  if (backend === SOFTWARE_BACKEND) {
    return { label: "Graphics", value: "software rendering (exports are slower)", status: "warn" };
  }
  return { label: "Graphics", value: backend, status: "ok" };
}

async function extensionItems(ctx: CommandContext): Promise<DoctorItem[]> {
  let installed: InstalledExtension[];
  try {
    installed = await ctx.extensions.installed();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [{ label: "Extensions", value: `can't list them: ${reason}`, status: "warn" }];
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
    });
  }
  if (hooks.length > 0) {
    items.push({
      label: "Catalogue hooks",
      value: `${hooks.map((e) => e.name).join(", ")} run when Safelight saves an edit, not for slu`,
      status: "warn",
    });
  }
  return items;
}

async function lockItem(ctx: CommandContext): Promise<DoctorItem> {
  const project = await ctx.projects.find(ctx.env.cwd);
  if (!project) return { label: "Project", value: "no catalogue holds this folder", status: "info" };
  const lock = await readLock(path.join(project.workingDir, "writer.lock"));
  if (!lock) return { label: "Project", value: `${project.root}: free to write`, status: "ok" };
  const fresh = Date.now() - lock.refreshedAt < HEARTBEAT_FRESH_MS;
  return {
    label: "Project",
    value: `${project.root}: ${fresh ? `held by ${lock.app} (pid ${lock.pid})` : `stale lock from ${lock.app}, slu will take it over`}`,
    status: fresh ? "warn" : "info",
  };
}

function networkItem(ctx: CommandContext): DoctorItem {
  const { env } = ctx.env;
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  const certs = env.NODE_EXTRA_CA_CERTS;
  const parts = [
    proxy ? `proxy ${proxy}` : "no proxy set (slu ignores the system proxy; set HTTPS_PROXY if you need one)",
    certs ? `extra certificates ${certs}` : "system certificates only if NODE_USE_SYSTEM_CA=1",
  ];
  return { label: "Network", value: parts.join("; "), status: "info" };
}

export async function doctorItems(ctx: CommandContext): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [
    { label: "Version", value: `Safelight Unplugged ${ctx.env.appVersion}`, status: "info" },
    { label: "App", value: ctx.env.appRoot, status: "info" },
    { label: "Profile", value: ctx.env.userData, status: "info" },
    await gpuItem(ctx),
  ];

  const shared = readSharedSettings(ctx.env.userData);
  if (!shared) {
    items.push({ label: "Settings", value: "not shared yet: open Safelight once", status: "warn" });
  } else {
    const age = Date.now() - shared.writtenAt;
    const running = shared.guiPid !== null && age < HEARTBEAT_FRESH_MS;
    items.push({
      label: "Settings",
      value: `shared ${ago(age)}${running ? "; Safelight looks to be running" : ""}`,
      status: "ok",
    });
  }

  items.push(...(await extensionItems(ctx)));

  const mode = await detectGraphicsMode(ctx.env);
  items.push({ label: "Terminal images", value: `${mode.mode} (${mode.reason})`, status: "info" });
  items.push(await lockItem(ctx));
  items.push(networkItem(ctx));
  return items;
}

export const doctorCommand: CommandSpec = {
  verb: "doctor",
  group: "More",
  summary: "Checks the version, the app slu runs with, the GPU backend, terminal images, the project lock and extensions.",
  usage: "doctor",
  examples: [
    "slu doctor",
  ],
  options: [],
  writes: false,
  async run(ctx) {
    const items = await doctorItems(ctx);
    const failed = items.some((i) => i.status === "fail");
    if (ctx.json) return { code: failed ? 1 : 0, json: { slu: 1, items } };
    ctx.out.print(ctx.out.doctor(items));
    return { code: failed ? 1 : 0 };
  },
};
