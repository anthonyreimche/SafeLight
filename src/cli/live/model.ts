// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The photo a live view shows, as the catalogue has it now. Each read that
// finds it changed (its look, its step, its stars, the open photos) is a new
// rev; a read that finds it as it was, after a save of some other photo, is not.

import path from "node:path";
import { currentLook, historyRows } from "@/catalog/edit-steps";
import { historyCursor } from "@/catalog/history-cursor";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import { asShotOf, photoName } from "../commands/edit-shared";
import { lookKey } from "../preview-cache";
import type { ProjectRef, ProjectService, ValueInfo, ValueService } from "../types";

/** The photo a view follows: a record of a project's catalogue. */
export interface ViewTarget { project: ProjectRef; relPath: string }

export type EngineStatus = "warming" | "ready" | "failed";

export interface LiveValue {
  tool: string; key: string; label: string; value: unknown; display: string;
  min: number | null; max: number | null; default: number | null; changed: boolean;
}

export interface LiveWorking { at: number; of: number; names: string[] }

/** What `GET /state` answers. */
export interface LiveState {
  slu: 1;
  rev: number;
  photo: {
    name: string; relPath: string; width: number; height: number;
    step: { at: number; of: number }; rating: number; flag: string; label: string;
  } | null;
  project: { name: string } | null;
  values: LiveValue[];
  history: { index: number; label: string; current: boolean }[];
  working: LiveWorking | null;
  engine: EngineStatus;
  before: boolean;
}

/** The photo as last read, for rendering it. `look` names its look (preview-cache.ts lookKey). */
export interface ViewedPhoto {
  project: ProjectRef;
  photo: CatalogPhoto;
  edit: EditState | undefined;
  look: string;
  /** The catalogue's stamp when it was read, so the engine reads the same. */
  catalogue: string | undefined;
}

export interface LiveModelDeps {
  projects: Pick<ProjectService, "openRead">;
  values: ValueService;
  formatValue(info: ValueInfo, value: unknown): string;
  catalogueStamp(workingDir: string): Promise<string | undefined>;
  /** The prompt's open photos, when the view follows them. */
  working?(): LiveWorking | null;
}

export interface LiveModel {
  readonly rev: number;
  state(): LiveState;
  viewed(): ViewedPhoto | null;
  target(): ViewTarget | null;
  /** Shows `target` from now on, read at once. */
  follow(target: ViewTarget | null): Promise<void>;
  /** Reads the catalogue again; a new rev when what is shown changed. */
  refresh(): Promise<void>;
  setEngine(status: EngineStatus): void;
  setBefore(on: boolean): void;
  subscribe(listener: (rev: number) => void): () => void;
}

type Shown = Omit<LiveState, "slu" | "rev" | "engine" | "before">;

function orientedSize(photo: CatalogPhoto): { width: number; height: number } {
  const turned = (photo.rotation ?? 0) % 180 !== 0;
  return turned ? { width: photo.height, height: photo.width } : { width: photo.width, height: photo.height };
}

function valuesOf(deps: LiveModelDeps, photo: CatalogPhoto, edit: EditState | undefined): LiveValue[] {
  const asShot = asShotOf(photo);
  const look = currentLook(edit, asShot);
  const rows: LiveValue[] = [];
  for (const tool of deps.values.tools()) {
    if (!tool.installed || !tool.enabled) continue;
    for (const info of deps.values.values(tool.id)) {
      const value = deps.values.read(look, info);
      const fallback = info.key === "temperature" ? asShot : info.default;
      rows.push({
        tool: tool.name,
        key: info.key,
        label: info.label,
        value,
        display: deps.formatValue(info, value),
        min: info.min ?? null,
        max: info.max ?? null,
        default: fallback ?? null,
        changed: !deps.values.isDefault(look, info, asShot),
      });
    }
  }
  return rows;
}

function shownOf(deps: LiveModelDeps, viewed: ViewedPhoto | null): Shown {
  const working = deps.working?.() ?? null;
  if (!viewed) return { photo: null, project: null, values: [], history: [], working };
  const { photo, edit, project } = viewed;
  const of = Math.max(edit?.stack.length ?? 0, 1);
  const at = edit && edit.stack.length > 0 ? historyCursor(edit.currentIndex, edit.stack.length) + 1 : 1;
  return {
    photo: {
      name: photoName(photo),
      relPath: photo.relPath,
      ...orientedSize(photo),
      step: { at, of },
      rating: photo.rating,
      flag: photo.flag,
      label: photo.colorLabel,
    },
    project: { name: path.basename(project.root) || project.root },
    values: valuesOf(deps, photo, edit),
    history: historyRows(edit).map(({ index, label, current }) => ({ index, label, current })),
    working,
  };
}

export function createLiveModel(deps: LiveModelDeps): LiveModel {
  let rev = 1;
  let target: ViewTarget | null = null;
  let viewed: ViewedPhoto | null = null;
  let shown: Shown = shownOf(deps, null);
  let signature = "";
  let engine: EngineStatus = "warming";
  let before = false;
  let reading: Promise<void> = Promise.resolve();
  const listeners = new Set<(rev: number) => void>();

  const bump = (): void => {
    rev++;
    for (const listener of listeners) listener(rev);
  };

  async function read(of: ViewTarget | null): Promise<ViewedPhoto | null> {
    if (!of) return null;
    const catalogue = await deps.catalogueStamp(of.project.workingDir);
    const session = await deps.projects.openRead(of.project);
    try {
      const photo = session.photoByRelPath(of.relPath);
      if (!photo) return null;
      const edit = await session.edit(photo.id);
      return { project: of.project, photo, edit, look: lookKey(photo, edit), catalogue };
    } finally {
      await session.close();
    }
  }

  /** Reads `target` as it is now; reads queue, so a later one never lands before an earlier one. */
  function reread(): Promise<void> {
    const next = reading.then(async () => {
      const of = target;
      let fresh: ViewedPhoto | null;
      try {
        fresh = await read(of);
      } catch {
        // A catalogue caught mid-save, or gone for a moment: what was shown stays.
        return;
      }
      if (of !== target) return;
      viewed = fresh;
      shown = shownOf(deps, fresh);
      const now = `${fresh?.look ?? ""}|${JSON.stringify(shown)}`;
      if (now !== signature) {
        signature = now;
        bump();
      }
    });
    reading = next;
    return next;
  }

  return {
    get rev() { return rev; },
    state: () => ({ slu: 1, rev, ...shown, engine, before }),
    viewed: () => viewed,
    target: () => target,
    follow(next) {
      target = next;
      return reread();
    },
    refresh: reread,
    setEngine(status) {
      if (status === engine) return;
      engine = status;
      bump();
    },
    setBefore(on) {
      if (on === before) return;
      before = on;
      bump();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
