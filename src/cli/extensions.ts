// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Install, update, remove and switch extensions through the same store code
// Safelight main uses. Every change to the plugin folders runs under
// <userData>/plugins.lock, and an install is settled (kept) as soon as its files
// are in place, so nothing is left for the app's startup sweep to roll back.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readDisabled, writeDisabled } from "../../electron/extension-state.cjs";
import { createExtensionStore } from "../../electron/extension-store/index.cjs";
import officialExtensions from "../../electron/official-extensions.json";
import { APP_SOURCES_KEY, GUI_HEARTBEAT_FRESH_MS } from "@/state/shared-settings";
import { isNewer } from "@/update/semver";
import { guiHeartbeatAt, readSharedSettings } from "./mirror";
import { fileWriter } from "./node-fs";
import { closest } from "./suggest";
import {
  CliError,
  type CliEnv,
  type ExtensionService,
  type InstallRisk,
  type InstalledExtension,
  type SearchHit,
  type Trust, COMMAND } from "./types";

/** The most hits `search` returns; the command says when it stopped there. */
export const SEARCH_LIMIT = 25;

const PROXY_HINT = "If this network uses a proxy, set HTTPS_PROXY and try again.";
const NETWORK_CODES = new Set([
  "ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

interface OfficialRow { id: string; repo: string; aliases?: string[] }
const OFFICIAL: readonly OfficialRow[] = officialExtensions.extensions;

interface TrustData {
  verified?: string[];
  reviewed?: Record<string, { version?: string }>;
  repos: string[];
  owners: string[];
  reason: Record<string, string>;
  unchecked?: boolean;
}

export interface Manifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  repository?: string;
  permissions?: { network?: string[]; userOrigins?: boolean; userSockets?: boolean };
}

interface CatalogueItem { fullName: string; name?: string; description?: string | null; categories?: string[] }
interface Vocabulary { categories: { slug: string; label: string }[] }
interface Kit { id: string; repos: string[] }

interface Candidate {
  /** Canonical "owner/repo", or null for an installed extension that names none. */
  repo: string | null;
  id?: string;
  names: string[];
}

const lower = (s: string): string => s.trim().toLowerCase();
const stripPrefix = (id: string): string => id.replace(/^safelight\./i, "");
const repoName = (repo: string): string => repo.split("/")[1] ?? repo;

export function slugOf(name: string): string {
  return name.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** "owner/repo" from a manifest's `repository` (a bare name or a GitHub URL), or null. */
function repoFromManifest(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim().match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#]+?)(?:\.git)?\/?$/i);
  if (url) return `${url[1]}/${url[2]}`;
  return /^[^/\s]+\/[^/\s]+$/.test(value.trim()) ? value.trim() : null;
}

const SOURCES_FILE = "slu-sources.json";

function sourceRecord(text: string): Record<string, string> {
  try {
    const doc: unknown = JSON.parse(text);
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return {};
    return Object.fromEntries(Object.entries(doc).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

/** The repository safelight downloaded each extension from, by id: safelight's own record, which only safelight writes. */
function readSluSources(userData: string): Record<string, string> {
  try {
    return sourceRecord(readFileSync(path.join(userData, SOURCES_FILE), "utf8"));
  } catch {
    return {};
  }
}

/** Where each extension was downloaded from, by id: safelight's record beside the one the app keeps and
 *  mirrors (shared-settings). An id the two give different repositories has none, as either may be
 *  the older install. An extension's manifest is never a source. */
function readSources(userData: string): Record<string, string> {
  const app = sourceRecord(readSharedSettings(userData)?.storage[APP_SOURCES_KEY] ?? "{}");
  const slu = readSluSources(userData);
  const same = (a: string, b: string): boolean => lower(canonicalRepo(a)) === lower(canonicalRepo(b));
  const merged = { ...app, ...slu };
  return Object.fromEntries(Object.entries(merged).filter(([id, repo]) => !app[id] || same(app[id], repo)));
}

const officialByRepo = (repo: string): OfficialRow | undefined =>
  OFFICIAL.find((e) => [e.repo, ...(e.aliases ?? [])].some((r) => lower(r) === lower(repo)));

const canonicalRepo = (repo: string): string => officialByRepo(repo)?.repo ?? repo;

function trustOf(list: TrustData, repo: string | null, version: string | null): Trust {
  if (repo) {
    const r = lower(repo);
    const owner = r.split("/")[0] ?? "";
    if (list.repos.includes(r) || list.owners.includes(owner)) return "banned";
    if (officialByRepo(repo)) return "official";
    if ((list.verified ?? []).includes(r)) {
      const reviewed = Object.entries(list.reviewed ?? {}).find(([k]) => lower(k) === r)?.[1]?.version;
      return reviewed && version && isNewer(reviewed, version) ? "unverified" : "verified";
    }
  }
  return "unverified";
}

const isBanned = (list: TrustData, repo: string | null): boolean =>
  repo !== null && trustOf(list, repo, null) === "banned";

function bannedReasonOf(list: TrustData, repo: string): string {
  const r = lower(repo);
  const owner = r.split("/")[0] ?? "";
  return list.reason[r] ?? list.reason[owner] ?? "flagged as unsafe";
}

function permissionLines(m: Manifest): string[] {
  const p = m.permissions ?? {};
  return [
    ...(p.network ?? []).map((origin) => `reach ${origin}`),
    ...(p.userOrigins ? ["reach web addresses you type in"] : []),
    ...(p.userSockets ? ["open live connections to addresses you type in"] : []),
  ];
}

const isManifest = (m: unknown): m is Manifest =>
  typeof m === "object" && m !== null &&
  typeof (m as Manifest).id === "string" && typeof (m as Manifest).name === "string" &&
  typeof (m as Manifest).version === "string";

function networkError(e: unknown, env: CliEnv): CliError {
  if (e instanceof CliError) return e;
  const err = e instanceof Error ? e : new Error(String(e));
  const code = (err.cause as { code?: string } | undefined)?.code ?? (err as { code?: string }).code;
  if (code === "ELOCKED")
    return new CliError(5, "Another install or update is in progress.", "Try again in a moment.");
  const unreachable = /fetch failed/i.test(err.message) || err.name === "TimeoutError" || err.name === "AbortError";
  const proxyLikely = unreachable || (code !== undefined && NETWORK_CODES.has(code)) ||
    !!(env.env.HTTPS_PROXY ?? env.env.https_proxy);
  const message = unreachable ? "Couldn't reach GitHub." : err.message.split("\n")[0];
  return new CliError(5, message, proxyLikely ? PROXY_HINT : undefined);
}

/** The installed extensions' manifests, by name: what plugins/ holds, read without the network. */
export function installedManifests(userData: string): Manifest[] {
  const pluginsDir = path.join(userData, "plugins");
  let names: string[];
  try {
    names = readdirSync(pluginsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const found: Manifest[] = [];
  for (const name of names) {
    try {
      const m: unknown = JSON.parse(readFileSync(path.join(pluginsDir, name, "safelight.json"), "utf8"));
      if (isManifest(m) && m.id === name) found.push(m);
    } catch {
      // A folder without a readable manifest isn't an extension.
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** The ids turned off, as electron/extension-state.cjs readDisabled reads them, for the callers that can't wait. */
export function disabledIdsSync(userData: string): string[] {
  try {
    const doc: unknown = JSON.parse(readFileSync(path.join(userData, "extension-state.json"), "utf8"));
    const disabled = (doc as { version?: unknown; disabled?: unknown } | null)?.disabled;
    if ((doc as { version?: unknown }).version !== 1 || !Array.isArray(disabled)) return [];
    return disabled.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export function createExtensionService(env: CliEnv, fetchImpl: typeof fetch = globalThis.fetch): ExtensionService {
  const userData = env.userData;
  const pluginsDir = path.join(userData, "plugins");
  const store = createExtensionStore({
    net: { fetch: (url, init) => fetchImpl(url, init as RequestInit | undefined) },
    userData: () => userData,
    fileWriter,
    appVersion: () => env.appVersion,
    pluginsDir: () => pluginsDir,
    pluginWorkDir: () => path.join(userData, "plugins-update"),
    lockOwner: "slu",
  });

  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      throw networkError(e, env);
    }
  };

  const trustList = async (): Promise<TrustData> => (await store.fetchTrustList()) as TrustData;

  const manifests = async (): Promise<Manifest[]> => installedManifests(userData);

  /** Null until the app has written its list. */
  const disabledList = (): Promise<string[] | null> => readDisabled(userData);
  const disabledIds = async (): Promise<string[]> => (await disabledList()) ?? [];

  /** Where an installed extension came from: what safelight recorded, or the list's row for an official
   *  id whose manifest names that row. The manifest alone is not enough for anything else. */
  function sourceOf(m: Manifest, sources: Record<string, string>): string | null {
    const recorded = sources[m.id];
    if (recorded) return canonicalRepo(recorded);
    const row = OFFICIAL.find((e) => e.id === m.id);
    const declared = repoFromManifest(m.repository);
    return row && declared && officialByRepo(declared)?.id === row.id ? row.repo : null;
  }

  function describe(m: Manifest, list: TrustData, disabled: readonly string[] | null, sources: Record<string, string>): InstalledExtension {
    const repo = sourceOf(m, sources);
    const declaredBanned = isBanned(list, repoFromManifest(m.repository));
    return {
      id: m.id, name: m.name, version: m.version,
      enabled: disabled ? !disabled.includes(m.id) : null,
      trust: declaredBanned ? "banned" : trustOf(list, repo, m.version),
      repo,
      permissions: permissionLines(m),
      ...(m.description && { description: m.description }),
    };
  }

  async function installed(): Promise<InstalledExtension[]> {
    const [found, list, disabled] = await Promise.all([manifests(), trustList(), disabledList()]);
    const sources = readSources(userData);
    return found.map((m) => describe(m, list, disabled, sources));
  }

  async function catalogue(): Promise<{ items: CatalogueItem[]; vocabulary: Vocabulary | null } | null> {
    try {
      const items = (await store.searchExtensions("", undefined)) as CatalogueItem[];
      const vocabulary = (await store.storeVocabulary()) as Vocabulary | null;
      return { items, vocabulary };
    } catch {
      return null;
    }
  }

  async function readKits(): Promise<Kit[]> {
    try {
      const raw = (await (store.kits as { get(): Promise<unknown> }).get()) as { kits?: unknown } | null;
      const kits: unknown[] = Array.isArray(raw?.kits) ? raw.kits : [];
      return kits.flatMap((k) => {
        const kit = k as { id?: unknown; extensions?: { repo?: unknown }[] };
        if (typeof kit.id !== "string" || !Array.isArray(kit.extensions)) return [];
        const repos = kit.extensions.flatMap((x) => (typeof x.repo === "string" ? [x.repo] : []));
        return repos.length ? [{ id: kit.id, repos }] : [];
      });
    } catch {
      return [];
    }
  }

  function localCandidates(found: Manifest[]): Candidate[] {
    const official = OFFICIAL.map((e): Candidate => ({
      repo: e.repo,
      id: e.id,
      names: [e.id, stripPrefix(e.id), e.repo, repoName(e.repo), ...(e.aliases ?? []), ...(e.aliases ?? []).map(repoName)],
    }));
    const sources = readSources(userData);
    const local = found.map((m): Candidate => {
      const repo = sourceOf(m, sources);
      return {
        repo,
        id: m.id,
        names: [m.id, stripPrefix(m.id), slugOf(m.name), ...(repo ? [repo, repoName(repo)] : [])],
      };
    });
    return [...official, ...local];
  }

  const matching = (candidates: Candidate[], input: string): { repo: string; id?: string }[] => {
    const wanted = lower(input);
    const merged = new Map<string, { repo: string; id?: string }>();
    for (const c of candidates) {
      if (!c.names.some((n) => lower(n) === wanted)) continue;
      const key = c.repo ? lower(c.repo) : `id:${c.id}`;
      const have = merged.get(key);
      merged.set(key, { repo: c.repo ?? "", id: c.id ?? have?.id });
    }
    return [...merged.values()];
  };

  const ambiguous = (input: string, hits: { repo: string; id?: string }[]): CliError =>
    new CliError(5, `"${input}" matches more than one extension: ${hits.map((h) => h.repo || h.id).join(", ")}.`,
      "Name one of them as owner/repo.");

  async function resolve(input: string) {
    const name = input.trim();
    const local = matching(localCandidates(await manifests()), name);
    if (local.length === 1) return local[0].id ? local[0] : { repo: local[0].repo };
    if (local.length > 1) throw ambiguous(name, local);

    const cat = await catalogue();
    const fromCatalogue = (cat?.items ?? []).map((i): Candidate => ({
      repo: canonicalRepo(i.fullName),
      names: [i.fullName, repoName(i.fullName), ...(i.name ? [slugOf(i.name)] : [])],
    }));
    const hits = matching(fromCatalogue, name);
    if (hits.length === 1) return { repo: hits[0].repo };
    if (hits.length > 1) throw ambiguous(name, hits);

    if (/^[^/\s]+\/[^/\s]+$/.test(name)) return { repo: canonicalRepo(name) };
    const kit = (await readKits()).find((k) => lower(k.id) === lower(name));
    if (kit) return { kit: kit.id, repos: kit.repos };
    if (!cat) throw new CliError(5, `Couldn't find "${name}" here, and the extension list couldn't be reached.`, PROXY_HINT);
    const near = closest(name, [...fromCatalogue.flatMap((c) => c.names), ...OFFICIAL.map((e) => stripPrefix(e.id))]);
    throw new CliError(5, `No extension called "${name}".${near ? ` Did you mean ${near}?` : ""}`, `${COMMAND} search ${name} lists what's available.`);
  }

  async function search(words: string[]): Promise<SearchHit[]> {
    return guard(async () => {
      const [items, list, vocabulary] = await Promise.all([
        store.searchExtensions(words.join(" "), undefined) as Promise<CatalogueItem[]>,
        trustList(),
        store.storeVocabulary() as Promise<Vocabulary | null>,
      ]);
      const labels = new Map((vocabulary?.categories ?? []).map((c) => [c.slug, c.label]));
      return Promise.all(items.slice(0, SEARCH_LIMIT).map(async (item): Promise<SearchHit> => {
        const remote = await (store.fetchRemoteManifest(item.fullName) as Promise<{ version: string } | null>)
          .catch(() => null);
        const row = officialByRepo(item.fullName);
        const slug = item.categories?.[0];
        return {
          id: row?.id ?? repoName(item.fullName).toLowerCase(),
          name: item.name ?? repoName(item.fullName),
          version: remote?.version ?? "",
          category: slug ? (labels.get(slug) ?? slug) : "",
          trust: trustOf(list, item.fullName, remote?.version ?? null),
          repo: item.fullName,
          installName: row ? stripPrefix(row.id) : repoName(item.fullName).toLowerCase(),
          ...(item.description && { description: item.description }),
        };
      }));
    });
  }

  /** The id whose files are swapped in but not yet kept or rolled back: the window the question sits in. */
  let unsettled: string | null = null;

  async function abandon(): Promise<void> {
    const id = unsettled;
    unsettled = null;
    if (id) await store.settleUpdate(id, "rollback");
  }

  async function install(
    repo: string,
    opts: { version?: string; confirm: (risk: InstallRisk) => Promise<boolean> },
  ): Promise<InstalledExtension> {
    const full = repo.split("#")[0];
    const list = await guard(trustList);
    if (trustOf(list, full, null) === "banned")
      throw new CliError(5, `"${full}" is blocked by Safelight: ${bannedReasonOf(list, full)}.`, `${COMMAND} doesn't install blocked extensions.`);
    const manifest = await guard(() => store.installPlugin(repo, opts.version));
    if (!isManifest(manifest)) throw new CliError(5, `${full} didn't hold a usable extension.`);
    unsettled = manifest.id;
    if (isBanned(list, repoFromManifest(manifest.repository))) {
      unsettled = null;
      await guard(() => store.settleUpdate(manifest.id, "rollback"));
      throw new CliError(5, `${manifest.name} names a repository Safelight blocks.`, `${COMMAND} doesn't install blocked extensions.`);
    }
    const trust = trustOf(list, full, manifest.version);
    if (trust === "unverified") {
      const ok = await opts.confirm({ name: manifest.name, trust, permissions: permissionLines(manifest) });
      if (!ok) {
        unsettled = null;
        await guard(() => store.settleUpdate(manifest.id, "rollback"));
        throw new CliError(5, `Didn't install ${manifest.name}: it isn't verified, and you didn't confirm.`, "Add --yes to install it anyway.");
      }
    }
    unsettled = null;
    await guard(() => store.settleUpdate(manifest.id, "keep"));
    const sources = { ...readSluSources(userData), [manifest.id]: canonicalRepo(full).toLowerCase() };
    await fileWriter.write(path.join(userData, SOURCES_FILE), JSON.stringify(sources));
    return describe(manifest, list, await disabledList(), sources);
  }

  async function uninstall(id: string): Promise<void> {
    await guard(() => store.uninstallPlugin(id));
    const { [id]: _forgotten, ...sources } = readSluSources(userData);
    await fileWriter.write(path.join(userData, SOURCES_FILE), JSON.stringify(sources));
    const disabled = await disabledIds();
    if (disabled.includes(id)) await writeDisabled(userData, disabled.filter((d) => d !== id), fileWriter);
  }

  async function updatesAvailable(ids?: string[]) {
    const wanted = ids ? new Set(ids) : null;
    const targets = (await installed()).filter((e) => e.repo && (!wanted || wanted.has(e.id)));
    const results = await Promise.all(targets.map(async (e) => {
      try {
        const remote = (await store.fetchRemoteManifest(e.repo as string)) as { version: string; minAppVersion?: string } | null;
        const usable = remote && isNewer(e.version, remote.version) &&
          (!remote.minAppVersion || !isNewer(env.appVersion, remote.minAppVersion));
        return usable ? { id: e.id, from: e.version, to: remote.version } : null;
      } catch (error) {
        return error;
      }
    }));
    const failures = results.filter((r): r is Error => r instanceof Error);
    if (targets.length > 0 && failures.length === targets.length) throw networkError(failures[0], env);
    return results.filter((r): r is { id: string; from: string; to: string } => !!r && !(r instanceof Error));
  }

  /** Until the app has written its list, safelight can't tell which extensions are on: a list written
   *  now would leave out the ones switched off in the app, and the app would adopt it. */
  async function setEnabled(id: string, enabled: boolean): Promise<void> {
    const disabled = await readDisabled(userData);
    if (disabled === null) throw new CliError(5, `Open Safelight once so ${COMMAND} can see which extensions are on.`);
    if (disabled.includes(id) !== enabled) return;
    const others = disabled.filter((d) => d !== id);
    await writeDisabled(userData, enabled ? others : [...others, id], fileWriter);
  }

  async function guiRunning(): Promise<boolean> {
    return Date.now() - guiHeartbeatAt(userData) < GUI_HEARTBEAT_FRESH_MS;
  }

  return {
    installed,
    search,
    resolve: (name) => guard(() => resolve(name)),
    install,
    abandon,
    uninstall,
    updatesAvailable,
    setEnabled,
    guiRunning,
  };
}
