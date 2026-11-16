// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `import`: brings the catalogue up to date with the folder, as Safelight does
// when it opens it. Node works out the scope and copies files in; the engine
// runs the GUI's own open walk as the catalogue's writer, under the lock as `slu`.

import path from "node:path";
import type { EngineEvent, ImportScope } from "@/engine/protocol";
import { importEvents, lockHeldError, type ImportEvent } from "../engine-client";
import { copyIn, dryRun, heldLock, planImport, type ImportPlan } from "../import-plan";
import { newRequestId, withLamp } from "../preview";
import { CliError, type CommandContext, type CommandOutcome, type CommandSpec, type ParsedArgs, type Stops, COMMAND } from "../types";

const LOCK_POLL_MS = 200;


type Done = Extract<EngineEvent, { type: "import-done" }>;

interface ImportedJson { path: string; relPath: string; id: string; preview: boolean }
interface FailedJson { path: string; relPath: string; error: string }

function stringOption(args: ParsedArgs, name: string): string | null {
  const value = args.options[name];
  if (value === undefined) return null;
  if (typeof value !== "string" || value === "") throw new CliError(1, `--${name} needs a folder.`);
  return value;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves once nobody holds the writer lock of the project at `root`, waiting as --wait allows. False when
 *  Ctrl+C stopped the wait. */
export async function waitForWriterLock(ctx: Pick<CommandContext, "waitSeconds">, root: string, workingDir: string, signal: AbortSignal | undefined): Promise<boolean> {
  const deadline = Date.now() + (ctx.waitSeconds ?? 0) * 1000;
  for (;;) {
    if (signal?.aborted) return false;
    const holder = await heldLock(workingDir);
    if (holder === null) return true;
    if (Date.now() >= deadline) throw lockHeldError(root, holder);
    await sleep(Math.min(LOCK_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

const waitForLock = (ctx: CommandContext, plan: ImportPlan, signal: AbortSignal | undefined): Promise<boolean> =>
  waitForWriterLock(ctx, plan.root, plan.existing?.workingDir ?? path.join(plan.root, ".safelight"), signal);

async function dryRunOutcome(ctx: CommandContext, plan: ImportPlan): Promise<CommandOutcome> {
  const report = await dryRun(plan, ctx.env.platform);
  const project = plan.existing
    ? { root: plan.root, workingDir: plan.existing.workingDir, location: plan.existing.location, created: false }
    : { root: plan.root, workingDir: path.join(plan.root, ".safelight"), location: "in-folder" as const, created: true };
  if (!ctx.json) {
    ctx.out.print(ctx.out.importPlan({
      project: plan.name,
      newFiles: report.new.length,
      gone: report.gone.length,
      dryRun: true,
      ...(project.created && { started: { workingDir: project.workingDir, external: false } }),
    }));
  }
  return { code: 0, json: { slu: 1, dryRun: true, project, new: report.new, gone: report.gone, otherFiles: report.otherFiles } };
}

/** The import with what stops it: Ctrl+C asks the engine to stop (`signal`), a second one kills it (`force`). */
export async function importPhotos(ctx: CommandContext, args: ParsedArgs, stops: Partial<Stops> = {}): Promise<CommandOutcome> {
  const plan = await planImport(
    {
      cwd: ctx.env.cwd,
      platform: ctx.env.platform,
      specs: [...args.positionals, ...args.afterDashDash],
      recursive: args.options.recursive === true,
      copy: args.options.copy === true,
      into: stringOption(args, "into"),
      project: stringOption(args, "project"),
    },
    (absPath) => ctx.projects.find(absPath),
  );
  const failed: FailedJson[] = plan.refused.map((r) => ({ path: path.resolve(ctx.env.cwd, r.spec), relPath: r.spec, error: r.message }));
  const nothingNamed = plan.scope.kind === "some" && plan.scope.files.length === 0 && plan.scope.folders.length === 0 && plan.copies.length === 0;
  plan.refused.forEach((r, i) => {
    if (!(nothingNamed && i === plan.refused.length - 1)) ctx.out.error({ message: r.message, hint: r.hint });
  });
  if (nothingNamed) {
    const last = plan.refused[plan.refused.length - 1];
    throw new CliError(2, last?.message ?? "Nothing to import.", last?.hint);
  }
  for (const folder of plan.nested) ctx.out.warn({ message: `${folder} has a catalogue of its own; its photos will be in both.` });
  if (args.options["dry-run"] === true) return dryRunOutcome(ctx, plan);

  if (!(await waitForLock(ctx, plan, stops.signal))) {
    ctx.out.error({ message: "Stopped." });
    return { code: 130 };
  }

  const copied: { from: string; to: string }[] = [];
  const copiedRel: string[] = [];
  for (const job of plan.copies) {
    if (stops.signal?.aborted) break;
    try {
      await copyIn(job);
      copied.push({ from: job.from, to: job.to });
      copiedRel.push(job.relPath);
    } catch (error) {
      const message = `Couldn't copy ${path.basename(job.from)}: ${error instanceof Error ? error.message : String(error)}`;
      failed.push({ path: job.from, relPath: job.relPath, error: message });
      ctx.out.error({ message });
    }
  }
  const scope: ImportScope = plan.scope.kind === "all" ? plan.scope : { ...plan.scope, files: [...plan.scope.files, ...copiedRel] };
  if (scope.kind === "some" && scope.files.length === 0 && scope.folders.length === 0) {
    return { code: 2, json: { slu: 1, ok: false, failed, copied } };
  }

  const imported: ImportedJson[] = [];
  const unread: string[] = [];
  const startedAt = Date.now();
  let project = {
    root: plan.root,
    workingDir: plan.existing?.workingDir ?? path.join(plan.root, ".safelight"),
    location: plan.existing?.location ?? ("in-folder" as "in-folder" | "external"),
    created: plan.existing === null,
  };
  let total = 0;
  const result: { done: Done | null } = { done: null };
  const absOf = (relPath: string) => path.join(plan.root, ...relPath.split("/"));

  const onEvent = (event: ImportEvent): void => {
    switch (event.type) {
      case "import-plan": {
        // The engine's page names paths with "/", whatever the system.
        const workingDir = path.normalize(event.workingDir);
        project = { root: plan.root, workingDir, location: event.location, created: event.created };
        total = event.newFiles;
        if (!ctx.json) {
          ctx.out.print(ctx.out.importPlan({
            project: plan.name,
            newFiles: event.newFiles,
            ...(event.created && { started: { workingDir, external: event.location === "external" } }),
          }));
        }
        break;
      }
      case "import-file":
        if (event.state === "failed") {
          failed.push({ path: absOf(event.relPath), relPath: event.relPath, error: event.error ?? "couldn't be read" });
          unread.push(event.relPath);
        } else {
          imported.push({ path: absOf(event.relPath), relPath: event.relPath, id: event.photoId ?? "", preview: event.state === "ok" });
        }
        if (!ctx.json) ctx.out.finished(ctx.out.importedFile({ path: event.relPath, state: event.state, ...(event.error !== undefined && { error: event.error }) }));
        break;
      case "progress":
        if (event.phase === "camera-data") {
          ctx.out.importProgress({ phase: "camera-data", done: event.done, total: event.total, startedAt });
        } else {
          total = event.total;
          ctx.out.importProgress({ phase: "files", done: event.done, total: event.total, reading: [], startedAt });
        }
        break;
      case "import-done":
        result.done = event;
        break;
    }
  };

  try {
    const events = importEvents(
      ctx.engine(),
      { id: newRequestId(), type: "import", project: { root: plan.root }, scope, metadata: args.options.quick !== true, keepBackup: true },
      stops,
    );
    for await (const event of withLamp(ctx.out, "Starting the engine…", events)) onEvent(event);
  } finally {
    ctx.out.importProgress(null);
    await ctx.engine().shutdown();
  }

  const { done } = result;
  const stopped = done?.stopped ?? (stops.signal?.aborted ? "interrupted" : null);
  const json = {
    slu: 1,
    project,
    imported,
    failed,
    copied,
    moved: done?.moved ?? [],
    dropped: done?.dropped ?? [],
    pending: done?.pending ?? 0,
    stopped,
  };
  if (!ctx.json) {
    ctx.out.print(ctx.out.importSummary({
      project: plan.name,
      imported: imported.length,
      total,
      ms: Date.now() - startedAt,
      failed: unread,
      moved: json.moved,
      dropped: json.dropped,
      pending: json.pending,
      stopped,
    }));
  }
  if (stopped === "interrupted") return { code: 130, json };
  if (stopped === "safelight-opened") return { code: 4, json };
  return { code: failed.length > 0 ? 6 : 0, json };
}

export const importCommand: CommandSpec = {
  verb: "import",
  group: "Library",
  summary: "Brings the catalogue up to date with the folder, as Safelight does when it opens it.",
  usage: "import [photos|folders…] [-r] [--copy [--into <folder>]] [--project <folder>] [--dry-run] [--quick]",
  examples: [
    `${COMMAND} import`,
    `${COMMAND} import Day2/ -r`,
    `${COMMAND} import --copy ../card/*.NEF --into Day3`,
  ],
  options: [
    { name: "recursive", alias: "r", kind: "flag", summary: "Go into the subfolders of a folder named." },
    { name: "copy", kind: "flag", summary: "Copy photos from outside the project in first; never moves or overwrites." },
    { name: "into", kind: "string", summary: "With --copy: the project folder they go to." },
    { name: "project", kind: "string", summary: "The folder a new catalogue starts in." },
    { name: "dry-run", kind: "flag", summary: "Say what it would do, and change nothing." },
    { name: "quick", kind: "flag", summary: "Leave the RAW camera data for Safelight to read later." },
  ],
  writes: true,
  ownsStop: true,
  run: (ctx, args) => importPhotos(ctx, args, ctx.stops),
};
