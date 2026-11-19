// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the prompt knows about the folder it is in, kept per folder and read in
// the background: the project's name and photos, a photo's values when the
// line names it, folder listings for `cd`. The editor reads only this cache,
// so a keypress never waits on a file; when an answer arrives it repaints.

import type { CliEnv, CommandSpec, ValueInfo, WorkingSet } from "../types";
import { createPromptContext, type BuiltinSpec, type DirEntry, type PhotoFact, type PhotoLook, type PromptContext } from "./context";
import { workingInfo } from "./working";

export interface ProjectPhotos {
  photos: PhotoFact[];
  look(rel: string): Promise<PhotoLook | undefined>;
  /** The project's folder. */
  root?: string;
  /** Safelight has the project open, so writes are refused. */
  readOnly?: boolean;
}

/** Where the cache's answers come from; tests swap these for fakes. */
export interface PromptSources {
  /** The name of the project holding `env.cwd`, or null. Quick: no catalogue read. */
  projectName(env: CliEnv): Promise<string | null>;
  photos(env: CliEnv): Promise<ProjectPhotos | null>;
  values(env: CliEnv): readonly ValueInfo[];
  extensionNames(env: CliEnv): readonly string[];
  readDir(dir: string): Promise<DirEntry[]>;
}

export interface PromptDataDeps {
  env(): CliEnv;
  commands: readonly CommandSpec[];
  builtins: readonly BuiltinSpec[];
  history(): readonly string[];
  sources: PromptSources;
  /** The photos `open` holds, or null. */
  working?(): WorkingSet | null;
  /** The line that fixes the last error, or null. */
  fix?(): string | null;
  /** The folder the last `ls` listed, from the prompt's folder, or null. */
  listed?(): string | null;
}

export interface PromptData {
  context(): PromptContext;
  /** Reads the project for the current folder again: resolves once its name is known; photos follow. */
  refresh(): Promise<void>;
  /** Value keys and extension names may have changed. */
  reloadValues(): void;
  /** History, the open set, the fix or the last listing changed. */
  touch(): void;
}

export function createPromptData(deps: PromptDataDeps, onChange: () => void): PromptData {
  let projectName: string | null = null;
  let project: ProjectPhotos | null = null;
  let values: readonly ValueInfo[] | null = null;
  let extensionNames: readonly string[] = [];
  let generation = 0;
  const looks = new Map<string, PhotoLook | null>();
  const dirs = new Map<string, readonly DirEntry[] | null>();
  let snapshot: PromptContext | null = null;

  const changed = (): void => {
    snapshot = null;
    onChange();
  };

  function look(rel: string): PhotoLook | undefined {
    if (looks.has(rel)) return looks.get(rel) ?? undefined;
    const from = project;
    if (!from) return undefined;
    looks.set(rel, null);
    const asked = generation;
    from.look(rel).then(
      (found) => {
        if (asked !== generation || !found) return;
        looks.set(rel, found);
        onChange();
      },
      () => {},
    );
    return undefined;
  }

  function dir(abs: string): readonly DirEntry[] | undefined {
    if (dirs.has(abs)) return dirs.get(abs) ?? undefined;
    dirs.set(abs, null);
    const asked = generation;
    deps.sources.readDir(abs).then(
      (entries) => {
        if (asked !== generation) return;
        dirs.set(abs, entries);
        changed();
      },
      () => {
        if (asked === generation) dirs.set(abs, []);
      },
    );
    return undefined;
  }

  function loadValues(): void {
    const env = deps.env();
    try {
      values = deps.sources.values(env);
    } catch {
      values = [];
    }
    try {
      extensionNames = deps.sources.extensionNames(env);
    } catch {
      extensionNames = [];
    }
  }

  return {
    context() {
      if (snapshot) return snapshot;
      const { platform, cwd } = deps.env();
      const set = deps.working?.() ?? null;
      snapshot = createPromptContext({
        platform,
        cwd,
        commands: deps.commands,
        builtins: deps.builtins,
        history: deps.history(),
        projectName,
        photos: project?.photos ?? null,
        values: values ?? [],
        extensionNames,
        look,
        dir,
        working: set ? workingInfo(set, cwd, platform) : null,
        fix: deps.fix?.() ?? null,
        listed: deps.listed?.() ?? null,
        root: project?.root ?? null,
        readOnly: project?.readOnly === true,
      });
      return snapshot;
    },

    async refresh() {
      const asked = ++generation;
      const env = deps.env();
      looks.clear();
      dirs.clear();
      project = null;
      projectName = await deps.sources.projectName(env).catch(() => null);
      if (asked !== generation) return;
      changed();
      void (async () => {
        // After the prompt is up: the values service reads the descriptor mirror.
        await new Promise((resolve) => setImmediate(resolve));
        if (values === null) loadValues();
        const found = projectName === null ? null : await deps.sources.photos(env).catch(() => null);
        if (asked !== generation) return;
        project = found;
        changed();
      })();
    },

    reloadValues() {
      values = null;
      changed();
    },

    touch: changed,
  };
}
