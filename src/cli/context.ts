// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Builds the CommandContext a verb runs with. Services are made on first use,
// so a verb that never touches one never pays for it (or fails on it).

import type { NativeFsBridge } from "@/extensions/api/native-bridge";
import type { EngineClient } from "./engine-client";
import { createEngineClient } from "./engine-client";
import { createExtensionService, disabledIdsSync, installedManifests } from "./extensions";
import { readDescriptors, seedParamRegistry } from "./mirror";
import type { Output } from "./output/types";
import { createPreviewService, tryOverrides, type ResolveTry } from "./preview";
import { createProjectService } from "./project";
import { createPhotoSelector } from "./select";
import type {
  CliEnv,
  CommandContext,
  ExtensionService,
  PhotoSelector,
  PreviewService,
  ProjectService,
  ReadSession,
  ValueService,
  Verbosity,
} from "./types";
import { createValueService } from "./values";

export interface ServiceFactories {
  projects(env: CliEnv, bridge: NativeFsBridge): ProjectService;
  select(projects: ProjectService, env: CliEnv): PhotoSelector;
  values(env: CliEnv): ValueService;
  extensions(env: CliEnv): ExtensionService;
  engine(env: CliEnv, out: Output): EngineClient;
  preview(env: CliEnv, out: Output, engine: () => EngineClient, resolveTry: ResolveTry): PreviewService;
}

/** The values of the core tools, and of the installed extensions as their descriptor files describe them. */
function valuesFromMirror(env: CliEnv): ValueService {
  const disabled = disabledIdsSync(env.userData);
  const installed = installedManifests(env.userData).map((m) => ({
    id: m.id, name: m.name, version: m.version, enabled: !disabled.includes(m.id),
  }));
  const descriptors = readDescriptors(env.userData, installed);
  seedParamRegistry(descriptors.values());
  return createValueService(descriptors, installed, disabled);
}

export const DEFAULT_FACTORIES: ServiceFactories = {
  projects: (env, bridge) => createProjectService(env, bridge),
  select: (projects, env) => createPhotoSelector(projects, env),
  values: valuesFromMirror,
  extensions: (env) => createExtensionService(env),
  engine: (env, out) => createEngineClient(env, out),
  preview: (env, out, engine, resolveTry) => createPreviewService(env, out, engine, resolveTry),
};

export interface ContextOptions {
  env: CliEnv;
  out: Output;
  json: boolean;
  verbosity: Verbosity;
  strict: boolean;
  yes: boolean;
  waitSeconds: number | null;
  stdin: NodeJS.ReadableStream;
  ask?: (question: string) => Promise<string>;
  /** The fs bridge the host shims hand to core (host.ts). */
  bridge: NativeFsBridge;
}

/** A context, plus what main needs to stop it early. */
export interface CliContext extends CommandContext {
  /** Closes every catalogue still open (each flushes what was stored and gives its
   *  lock back), stops the engine if one started and rolls back an install that was
   *  waiting on its question. For Ctrl+C. */
  dispose(): Promise<void>;
}

function once<T>(make: () => T): { get(): T; made(): boolean } {
  let made = false;
  let value: T;
  return {
    get() {
      if (!made) {
        value = make();
        made = true;
      }
      return value;
    },
    made: () => made,
  };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) text += chunk;
  return text;
}

/** `service` with every session it opens kept in `open` until closed. */
function tracked(service: ProjectService, open: Set<ReadSession>, signal: AbortSignal): ProjectService {
  const keep = <S extends ReadSession>(session: S): S => {
    open.add(session);
    const close = session.close.bind(session);
    session.close = async () => {
      open.delete(session);
      await close();
    };
    return session;
  };
  return {
    find: (absPath) => service.find(absPath),
    openRead: async (project) => keep(await service.openRead(project)),
    openWrite: async (project, waitSeconds) => keep(await service.openWrite(project, waitSeconds, signal)),
  };
}

export function createContext(opts: ContextOptions, factories: ServiceFactories = DEFAULT_FACTORIES): CliContext {
  const { env, out } = opts;
  const sessions = new Set<ReadSession>();
  const stopping = new AbortController();
  const projects = once(() => tracked(factories.projects(env, opts.bridge), sessions, stopping.signal));
  const select = once(() => factories.select(projects.get(), env));
  const values = once(() => factories.values(env));
  const extensions = once(() => factories.extensions(env));
  const engine = once(() => factories.engine(env, out));
  const resolveTry: ResolveTry = (project, photo, assigns) =>
    tryOverrides({ projects: projects.get(), values: values.get(), out, strict: opts.strict }, project, photo, assigns);
  const preview = once(() => factories.preview(env, out, engine.get, resolveTry));
  const stdinText = once(() => readAll(opts.stdin));

  return {
    env,
    out,
    json: opts.json,
    verbosity: opts.verbosity,
    strict: opts.strict,
    yes: opts.yes,
    waitSeconds: opts.waitSeconds,
    get projects() { return projects.get(); },
    get select() { return select.get(); },
    get values() { return values.get(); },
    get extensions() { return extensions.get(); },
    engine: engine.get,
    get preview() { return preview.get(); },
    readStdin: stdinText.get,
    ask: opts.ask,
    async dispose() {
      stopping.abort();
      await Promise.allSettled([
        ...[...sessions].map((s) => s.close()),
        ...(engine.made() ? [engine.get().shutdown()] : []),
        ...(extensions.made() ? [extensions.get().abandon()] : []),
      ]);
    },
  };
}
