// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The prompt cache's real answers, from files only: the catalogue, the
// descriptor mirror, the folder. Never the engine.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { readLock, STALE_MS } from "../../../electron/file-lock.cjs";
import { currentLook } from "@/catalog/edit-steps";
import { historyCursor } from "@/catalog/history-cursor";
import { guiLooksRunning } from "../commands/doctor";
import { asShotOf } from "../commands/edit-shared";
import { DEFAULT_FACTORIES } from "../context";
import { installedManifests, slugOf } from "../extensions";
import { installNodeHost } from "../host";
import { readSharedSettings } from "../mirror";
import { createNodeFsBridge } from "../node-fs";
import { createProjectService } from "../project";
import type { CliEnv } from "../types";
import type { DirEntry, PhotoFact, PhotoLook } from "./context";
import type { ProjectPhotos, PromptSources } from "./data";

export function installHost(env: CliEnv): ReturnType<typeof createNodeFsBridge> {
  const bridge = createNodeFsBridge(env.userData);
  installNodeHost({ bridge, platform: env.platform, storage: readSharedSettings(env.userData)?.storage ?? {} });
  return bridge;
}

/** Safelight holds the writer lock of the catalogue in `workingDir`, and has refreshed it lately. */
export async function guiHoldsLock(workingDir: string): Promise<boolean> {
  const lock = await readLock(path.join(workingDir, "writer.lock"));
  return lock !== null && lock.app === "safelight" && Date.now() - lock.refreshedAt < STALE_MS;
}

async function projectName(env: CliEnv): Promise<string | null> {
  const ref = await createProjectService(env, createNodeFsBridge(env.userData)).find(env.cwd);
  return ref ? path.basename(ref.root) || ref.root : null;
}

async function photos(env: CliEnv): Promise<ProjectPhotos | null> {
  const projects = createProjectService(env, installHost(env));
  const ref = await projects.find(env.cwd);
  if (!ref) return null;
  const p = env.platform === "win32" ? path.win32 : path.posix;
  const fromCwd = (relPath: string): string => {
    const rel = p.relative(env.cwd, p.join(ref.root, relPath));
    return env.platform === "win32" ? rel.replace(/\\/g, "/") : rel;
  };
  const session = await projects.openRead(ref);
  let facts: PhotoFact[];
  try {
    facts = session.photos().map((photo) => ({ rel: fromCwd(photo.relPath), rating: photo.rating, flag: photo.flag, label: photo.colorLabel }));
  } finally {
    await session.close();
  }
  const values = DEFAULT_FACTORIES.values(env);
  const infos = values.values();

  const look = async (rel: string): Promise<PhotoLook | undefined> => {
    const relPath = p.relative(ref.root, p.resolve(env.cwd, rel));
    const reader = await projects.openRead(ref);
    try {
      const photo = reader.photoByRelPath(relPath);
      if (!photo) return undefined;
      const state = await reader.edit(photo.id);
      const current = currentLook(state, asShotOf(photo));
      const stack = state?.stack.length ?? 0;
      return {
        values: new Map(infos.map((info) => [info.key, values.read(current, info)])),
        step: stack > 0 ? { at: historyCursor(state?.currentIndex, stack) + 1, of: stack } : null,
      };
    } finally {
      await reader.close();
    }
  };
  const readOnly = guiLooksRunning(readSharedSettings(env.userData)) && (await guiHoldsLock(ref.workingDir).catch(() => false));
  return { photos: facts, look, root: ref.root, readOnly };
}

async function readDir(dir: string): Promise<DirEntry[]> {
  return (await readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, dir: e.isDirectory() }));
}

export const FILE_SOURCES: PromptSources = {
  projectName,
  photos,
  values(env) {
    installHost(env);
    return DEFAULT_FACTORIES.values(env).values();
  },
  extensionNames: (env) => installedManifests(env.userData).map((m) => slugOf(m.name)),
  readDir,
};
