// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Reads the live app (stores, the native bridge, the error log) into the
// sections of a report. Every section's text and summary passes through the
// redactor on the way out.

import type { ExtensionManifest } from "@/extensions/types";
import { BUILTIN_EXTENSIONS } from "@/extensions/builtin";
import { isExtensionDisabled, isPluginRunning } from "@/extensions/loader";
import { extensionKinds } from "@/extensions/extension-kinds";
import { repoFor } from "@/extensions/sources";
import { useTrust, verificationStatus } from "@/extensions/trust";
import { updateNote, useExtStoreUI } from "@/extensions/store-ui";
import { useDevFolder } from "@/extensions/devtools/dev-folder";
import { moduleLabel } from "@/extensions/registry";
import { effectivePipelineId } from "@/extensions/pipelines";
import { useThemeStore } from "@/extensions/themes";
import { useLayoutStore } from "@/extensions/dock";
import { CURRENT_PROCESS_VERSION } from "@/catalog/types";
import { nativePathOf } from "@/project/native-fs";
import { useProjectStore } from "@/project/project-store";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore } from "@/state/develop-store";
import { useUIStore } from "@/state/ui-store";
import { detachedModule } from "@/state/detach";
import { DEFAULT_SETTINGS, getSettings } from "@/state/settings-store";
import { readErrorLog, syncNativeCrashes } from "./error-log";
import { readEnvironment, readGraphics } from "./environment";
import { makeRedactor } from "./redact";
import type { ReportSection, SectionId } from "./report-markdown";
import {
  changedSettings,
  contextText,
  crashText,
  environmentText,
  errorsText,
  extensionsText,
  graphicsText,
  photoFacts,
  type ContextFacts,
  type ExtensionFacts,
  type ExtensionRow,
  type ReportPrefill,
} from "./report-sections";

const PLATFORM_NAMES: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };

export function reportRedactor(): (text: string) => string {
  const roots = [nativePathOf(useProjectStore.getState().root), getSettings().externalCatalogDir].filter(
    (r): r is string => Boolean(r),
  );
  const folders = new Set<string>();
  for (const { folder } of useCatalogStore.getState().photos) {
    const parts = folder.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  return makeRedactor({ roots, folders: [...folders] });
}

async function installedManifests(): Promise<ExtensionManifest[]> {
  try {
    return (await window.safelightNative?.plugins.list()) ?? [];
  } catch {
    return [];
  }
}

async function extensionFacts(): Promise<ExtensionFacts> {
  const kinds = extensionKinds();
  const rendersPixels = (id: string): boolean => Object.hasOwn(kinds, id) && kinds[id] === "pixels";
  const updates = useExtStoreUI.getState().updates;

  const installed: ExtensionRow[] = (await installedManifests()).map((m) => {
    const upd = Object.hasOwn(updates, m.id) ? updates[m.id] : undefined;
    return {
      id: m.id,
      version: m.version,
      source: "installed",
      enabled: !isExtensionDisabled(m.id),
      running: isPluginRunning(m.id),
      trust: verificationStatus(repoFor(m), m.version),
      rendersPixels: rendersPixels(m.id),
      ...(upd?.failed ? { problem: updateNote(m.version, upd) } : {}),
    };
  });
  const dev: ExtensionRow[] = useDevFolder.getState().items.map((item) => ({
    id: item.id,
    version: item.version,
    source: "dev",
    enabled: !isExtensionDisabled(item.id),
    running: item.status === "loaded",
    trust: null,
    rendersPixels: rendersPixels(item.id),
    ...(item.error ? { problem: `error: ${item.error}` } : {}),
  }));
  const builtinChanges = BUILTIN_EXTENSIONS.filter(
    (b) => !b.locked && isExtensionDisabled(b.id) !== Boolean(b.disabledByDefault),
  ).map((b) => ({ id: b.id, enabled: !isExtensionDisabled(b.id) }));
  const blocked = useTrust.getState().flagged.map((f) => ({ id: f.id, reason: f.reason }));
  return { rows: [...installed, ...dev], builtinChanges, blocked };
}

function contextFacts(): ContextFacts {
  const { photos, activePhotoId } = useCatalogStore.getState();
  const active = photos.find((p) => p.id === activePhotoId) ?? null;
  const develop = useDevelopStore.getState();
  const params = active && develop.photoId === active.id ? develop.params : null;
  return {
    module: moduleLabel(detachedModule() ?? useUIStore.getState().activeModule),
    theme: useThemeStore.getState().activeId,
    layout: useLayoutStore.getState().activeId,
    folderOpen: useProjectStore.getState().root !== null,
    photoCount: photos.length,
    photo: active ? photoFacts(active) : null,
    edit: params
      ? {
          processVersion: params.processVersion,
          currentProcessVersion: CURRENT_PROCESS_VERSION,
          pipeline: effectivePipelineId(params.displayTransform),
          ownPipeline: params.displayTransform !== null,
        }
      : null,
    changedSettings: changedSettings(getSettings(), DEFAULT_SETTINGS),
  };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export async function collectReportSections(prefill: ReportPrefill | null): Promise<ReportSection[]> {
  const [environment, graphics, extensions] = await Promise.all([
    readEnvironment(),
    readGraphics(),
    extensionFacts(),
    syncNativeCrashes(),
  ]);
  const context = contextFacts();
  const errors = readErrorLog();
  const redact = reportRedactor();

  const section = (id: SectionId, label: string, summary: string, text: string): ReportSection => ({
    id,
    label,
    summary: redact(summary),
    text: redact(text),
    include: true,
  });

  const os = PLATFORM_NAMES[environment.platform] ?? environment.platform;
  const devCount = extensions.rows.filter((r) => r.source === "dev").length;
  const installedCount = extensions.rows.length - devCount;
  const sections: ReportSection[] = [];
  if (prefill?.crash) {
    sections.push(section("crash", "Crash", `${prefill.crash.what} crashed`, crashText(prefill.crash)));
  }
  sections.push(
    section(
      "environment",
      "Environment",
      `Safelight ${environment.appVersion} · ${environment.electron ? os : "browser build"}`,
      environmentText(environment),
    ),
    section("graphics", "Graphics", graphics.webgl?.renderer ?? "WebGL unavailable", graphicsText(graphics)),
    section(
      "extensions",
      "Extensions",
      [installedCount ? `${installedCount} installed` : "None installed", devCount ? `${devCount} in dev folder` : ""]
        .filter(Boolean)
        .join(" · "),
      extensionsText(extensions),
    ),
    section(
      "context",
      "Photo and app",
      [context.module, context.photo?.ext, context.photo?.camera].filter(Boolean).join(" · "),
      contextText(context),
    ),
    section("errors", "Recent errors", errors.length ? plural(errors.length, "entry", "entries") : "None", errorsText(errors)),
  );
  return sections;
}
