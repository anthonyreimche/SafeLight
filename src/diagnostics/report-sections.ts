// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Plain facts about the app turned into the text of each report section. The
// facts are narrowed before they get here (photoFacts, changedSettings) so a
// file name, folder, GPS position or serial number can't reach a report even
// through a careless format string.

import type { CatalogPhoto } from "@/catalog/types";
import type { AppSettings } from "@/state/settings-store";
import { getExtension } from "@/modules/library/raw-preview";
import type { ErrorLogEntry } from "./error-log";

export interface ReportCrash {
  /** Names what crashed, e.g. `Panel "core.histogram"`. */
  what: string;
  message: string;
  stack?: string;
  componentStack?: string;
}

export interface ReportPrefill {
  title?: string;
  crash?: ReportCrash;
}

export interface WebGLInfo {
  vendor: string;
  renderer: string;
  glsl: string;
  maxTexture: number;
}

export interface EnvironmentFacts {
  appVersion: string;
  /** Null in the browser build. */
  electron: string | null;
  chrome: string | null;
  platform: string;
  arch: string | null;
  osVersion: string | null;
  userAgent: string;
  language: string;
  threads: number | null;
  screen: { width: number; height: number; dpr: number };
  viewport: { width: number; height: number };
  crossOriginIsolated: boolean;
  /** Which window the report was made from. */
  window: string;
}

export interface GraphicsFacts {
  webgl: WebGLInfo | null;
  gpuFeatures: Record<string, string> | null;
  /** Null where display profiles don't apply (everywhere but Linux). */
  displayProfile: "off" | "loading" | "active" | "error" | null;
}

export interface ExtensionRow {
  id: string;
  version: string;
  source: "installed" | "dev";
  enabled: boolean;
  running: boolean;
  trust: "verified" | "unverified" | "stale" | null;
  rendersPixels: boolean;
  problem?: string;
}

export interface ExtensionFacts {
  rows: ExtensionRow[];
  /** Built-ins switched away from how they ship. */
  builtinChanges: { id: string; enabled: boolean }[];
  /** Installed extensions skipped at load because they are banned. */
  blocked: { id: string; reason: string }[];
}

export interface PhotoFacts {
  ext: string;
  mimeType: string;
  width: number;
  height: number;
  camera: string | null;
  lens: string | null;
  virtualCopy: boolean;
  metadataPending: boolean;
  decodeError: string | null;
}

export interface EditFacts {
  processVersion: number;
  currentProcessVersion: number;
  pipeline: string;
  /** The photo picked its own display transform. */
  ownPipeline: boolean;
}

export interface ContextFacts {
  module: string;
  theme: string;
  layout: string;
  folderOpen: boolean;
  photoCount: number;
  photo: PhotoFacts | null;
  edit: EditFacts | null;
  changedSettings: string[];
}

/** Settings worth knowing about in a bug report. Nothing that holds a path. */
export const REPORTED_SETTINGS = [
  "uiScale",
  "reduceMotion",
  "highContrast",
  "colorVisionFilter",
  "previewSource",
  "thumbMaxEdge",
  "persistPreviews",
  "catalogLocation",
  "rawCacheEnabled",
  "rawCachePrefetch",
  "rawCacheMaxEdge",
  "developMaxEdge",
  "gpuSourceCacheBytes",
  "developPrefetchNeighbors",
  "highBitDepth",
  "liveHistogram",
  "autoSaveCollapsedPanels",
] as const satisfies readonly (keyof AppSettings)[];

const PLATFORM_NAMES: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };
const MAX_COMPONENT_STACK_LINES = 12;

function cameraName(make: string | undefined, model: string | undefined): string | null {
  if (!model) return make ?? null;
  const brand = make?.split(/\s+/)[0];
  if (!make || (brand && model.toLowerCase().includes(brand.toLowerCase()))) return model;
  return `${make} ${model}`;
}

export function photoFacts(photo: CatalogPhoto): PhotoFacts {
  return {
    ext: getExtension(photo.filename),
    mimeType: photo.mimeType,
    width: photo.width,
    height: photo.height,
    camera: cameraName(photo.exif.cameraMake, photo.exif.cameraModel),
    lens: photo.exif.lens ?? null,
    virtualCopy: photo.copyOf !== undefined,
    metadataPending: photo.metadataPending === true,
    decodeError: photo.decodeError ?? null,
  };
}

function settingValue(key: (typeof REPORTED_SETTINGS)[number], value: AppSettings[typeof key]): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (key === "gpuSourceCacheBytes") return `${Math.round(Number(value) / (1024 * 1024))} MB`;
  return String(value);
}

export function changedSettings(s: AppSettings, defaults: AppSettings): string[] {
  return REPORTED_SETTINGS.filter((key) => s[key] !== defaults[key]).map(
    (key) => `${key} ${settingValue(key, s[key])}`,
  );
}

export function environmentText(f: EnvironmentFacts): string {
  const lines: string[] = [];
  if (f.electron) {
    lines.push(`Safelight ${f.appVersion}`);
    lines.push(`Electron ${f.electron} · Chromium ${f.chrome ?? "?"}`);
    const os = [PLATFORM_NAMES[f.platform] ?? f.platform, f.osVersion].filter(Boolean).join(" ");
    lines.push(f.arch ? `${os} · ${f.arch}` : os);
  } else {
    lines.push(`Safelight ${f.appVersion} (browser build)`);
    lines.push(f.userAgent);
  }
  lines.push(`Language ${f.language}${f.threads ? ` · ${f.threads} CPU threads` : ""}`);
  lines.push(
    `Screen ${f.screen.width}×${f.screen.height} at ${f.screen.dpr}× · window ${f.viewport.width}×${f.viewport.height}`,
  );
  lines.push(`Cross-origin isolated: ${f.crossOriginIsolated ? "yes" : "no (RAW decode degraded)"}`);
  lines.push(`Window: ${f.window}`);
  return lines.join("\n");
}

export function graphicsText(f: GraphicsFacts): string {
  const lines: string[] = [];
  if (f.webgl) {
    lines.push(f.webgl.renderer);
    lines.push(`Vendor: ${f.webgl.vendor}`);
    lines.push(`${f.webgl.glsl} · max texture ${f.webgl.maxTexture}`);
  } else {
    lines.push("WebGL unavailable");
  }
  if (f.gpuFeatures) {
    const off = Object.entries(f.gpuFeatures).filter(
      ([, status]) => !status.startsWith("enabled") && !status.endsWith("_ok"),
    );
    lines.push(
      off.length === 0
        ? "GPU features: all enabled"
        : `GPU features off: ${off.map(([name, status]) => `${name} (${status})`).join(", ")}`,
    );
  }
  if (f.displayProfile) lines.push(`Display profile: ${f.displayProfile}`);
  return lines.join("\n");
}

const TRUST_LABELS: Record<NonNullable<ExtensionRow["trust"]>, string> = {
  verified: "verified",
  unverified: "unverified",
  stale: "verified, this version not reviewed yet",
};

function extensionLine(row: ExtensionRow): string[] {
  const state = row.enabled ? (row.running ? "on" : "on, not running") : "off";
  const parts = [`- ${row.id} ${row.version}`, state];
  if (row.trust) parts.push(TRUST_LABELS[row.trust]);
  if (row.rendersPixels) parts.push("renders into photos");
  const lines = [parts.join(" · ")];
  if (row.problem) lines.push(`  ${row.problem}`);
  return lines;
}

export function extensionsText(f: ExtensionFacts): string {
  const installed = f.rows.filter((r) => r.source === "installed");
  const dev = f.rows.filter((r) => r.source === "dev");
  const lines: string[] = [];
  if (installed.length) lines.push("Installed:", ...installed.flatMap(extensionLine));
  if (dev.length) lines.push("Dev folder:", ...dev.flatMap(extensionLine));
  if (f.builtinChanges.length) {
    lines.push(
      "Built-in changes:",
      ...f.builtinChanges.map((c) => `- ${c.id} · ${c.enabled ? "on (off by default)" : "off (on by default)"}`),
    );
  }
  if (f.blocked.length) lines.push("Blocked:", ...f.blocked.map((b) => `- ${b.id}: ${b.reason}`));
  return lines.length ? lines.join("\n") : "No extensions installed; built-ins at their defaults.";
}

export function contextText(f: ContextFacts): string {
  const lines = [`Module: ${f.module}`, `Theme: ${f.theme} · Layout: ${f.layout}`];
  lines.push(f.folderOpen ? `Catalog: ${f.photoCount.toLocaleString("en-US")} photos` : "No folder open");
  if (f.photo) {
    const p = f.photo;
    const photo = [`Photo: ${p.ext || "(no extension)"}`, p.mimeType, `${p.width}×${p.height}`];
    if (p.virtualCopy) photo.push("virtual copy");
    if (p.metadataPending) photo.push("metadata still loading");
    lines.push(photo.join(" · "));
    const gear = [p.camera && `Camera: ${p.camera}`, p.lens && `Lens: ${p.lens}`].filter(Boolean);
    if (gear.length) lines.push(gear.join(" · "));
  }
  if (f.edit) {
    const e = f.edit;
    lines.push(
      `Processing: version ${e.processVersion} (current ${e.currentProcessVersion}) · display transform ${e.pipeline}${e.ownPipeline ? " (photo's own)" : ""}`,
    );
  }
  if (f.photo?.decodeError) lines.push(`Decode problem: ${f.photo.decodeError}`);
  if (f.changedSettings.length) lines.push(`Settings changed: ${f.changedSettings.join(" · ")}`);
  return lines.join("\n");
}

const pad = (n: number): string => String(n).padStart(2, "0");

function localTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const withoutBlankLines = (text: string): string[] => text.split("\n").filter((l) => l.trim() !== "");

export function errorsText(entries: readonly ErrorLogEntry[]): string {
  if (entries.length === 0) return "No warnings or errors recorded.";
  return entries
    .map((e) =>
      [
        `${localTime(e.time)} · ${e.source} · ${e.level}${e.count > 1 ? ` ×${e.count}` : ""}`,
        ...withoutBlankLines(e.message),
        ...withoutBlankLines(e.stack ?? ""),
      ].join("\n"),
    )
    .join("\n\n");
}

export function crashText(c: ReportCrash): string {
  const lines = [`${c.what} crashed: ${c.message}`, ...withoutBlankLines(c.stack ?? "")];
  const components = withoutBlankLines(c.componentStack ?? "").slice(0, MAX_COMPONENT_STACK_LINES);
  if (components.length) lines.push("Component stack:", ...components);
  return lines.join("\n");
}
