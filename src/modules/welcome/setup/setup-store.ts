// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// State of the welcome setup: whether it is showing, the step, the starter
// kits and what's installed, the picks, and the install rows. It lives in a
// store rather than in the component so the welcome grid, Preferences and the
// Extensions store can open it, and so installs outlive re-renders.

import { create } from "zustand";
import { installFromGitHub } from "@/extensions/loader";
import { checkReview, setAckedExtensionRisk } from "@/extensions/install-gate";
import { rememberSource, repoFor } from "@/extensions/sources";
import { THEME_STORAGE_KEY } from "@/extensions/themes";
import {
  bannedReason,
  isVerified,
  loadTrustList,
  useTrust,
} from "@/extensions/trust";
import type { TrustList } from "@/extensions/types";
import { listRecentProjects } from "@/project/recent";
import { SETTINGS_STORAGE_KEY } from "@/state/settings-store";
import {
  decideFirstRun,
  gatherProfileSignals,
  readSetupRecord,
  writeSetupRecord,
  type ProfileSignals,
  type SignalSources,
} from "./first-run";
import {
  installOne,
  runSetupInstalls,
  SETUP_INSTALL_TIMEOUT_MS,
  waitingRow,
  type InstallDeps,
  type InstallRow,
} from "./install-queue";
import { parseKits, type KitExtension, type StarterKit } from "./kits";
import {
  pendingInstalls,
  toggleExtension,
  toggleKit,
  visibleKits,
} from "./selection";

export type SetupStep = "look" | "workspace" | "extensions" | "finish";
export type SetupMode = "first-run" | "rerun";

export type KitsLoad =
  | { status: "loading" }
  | { status: "ready"; kits: StarterKit[] }
  | { status: "unavailable" };

interface SetupState {
  /** "checking" until the main window's first-run decision lands. */
  phase: "checking" | "open" | "closed";
  mode: SetupMode;
  step: SetupStep;
  kits: KitsLoad;
  /** Repos ("owner/repo", lowercase) of the extensions already installed. */
  installed: string[];
  /** Repos picked for install, lowercase. */
  selected: string[];
  /** The kit whose extension list is open, by id. */
  expandedKit: string | null;
  /** One row per extension being installed; null until Install is clicked. */
  installs: InstallRow[] | null;
  /** From the Install click (or a Retry) until every row has settled. */
  installing: boolean;
}

const INITIAL: SetupState = {
  phase: "checking",
  mode: "first-run",
  step: "look",
  kits: { status: "loading" },
  installed: [],
  selected: [],
  expandedKit: null,
  installs: null,
  installing: false,
};

export const useSetupStore = create<SetupState>(() => INITIAL);

let kitsRequest = 0;

/** The kits and the trust list load together: on a fresh install the trust
 *  list is empty until its first fetch, and every kit would look unverified. */
async function loadKits(): Promise<void> {
  const request = ++kitsRequest;
  useSetupStore.setState({ kits: { status: "loading" } });
  const fetchKits = window.safelightNative?.plugins.kits;
  let kits: StarterKit[] | null = null;
  if (fetchKits) {
    const [raw] = await Promise.all([
      fetchKits().catch(() => null),
      loadTrustList(),
    ]);
    kits = parseKits(raw, __APP_VERSION__);
  }
  if (request !== kitsRequest) return;
  useSetupStore.setState({
    kits:
      kits && kits.length > 0
        ? { status: "ready", kits }
        : { status: "unavailable" },
  });
}

async function loadInstalled(): Promise<void> {
  const list =
    (await window.safelightNative?.plugins.list().catch(() => [])) ?? [];
  const installed = list
    .map((m) => repoFor(m)?.toLowerCase() ?? null)
    .filter((repo): repo is string => repo !== null);
  useSetupStore.setState({ installed });
}

/** First run starts at Look; the entry points can start a rerun at any step
 *  (the Extensions store opens it on Extensions). Ignored while installs run:
 *  resetting the rows would orphan the queue still reporting into them. */
export function openSetup(mode: SetupMode, step: SetupStep = "look"): void {
  if (useSetupStore.getState().installing) return;
  useSetupStore.setState({
    phase: "open",
    mode,
    step,
    selected: [],
    expandedKit: null,
    installs: null,
    installing: false,
  });
  void loadKits();
  void loadInstalled();
}

/** A first run records how it ended so it isn't offered again; a rerun
 *  leaves the record alone. Refused while installs run, because no other
 *  surface could report their failures. */
export function closeSetup(outcome: "finished" | "skipped"): void {
  const { mode, installing } = useSetupStore.getState();
  if (installing) return;
  if (mode === "first-run")
    writeSetupRecord(localStorage, outcome, __APP_VERSION__);
  useSetupStore.setState({ phase: "closed" });
}

export const setSetupStep = (step: SetupStep): void =>
  useSetupStore.setState({ step });

export const setExpandedKit = (id: string | null): void =>
  useSetupStore.setState({ expandedKit: id });

export function toggleSetupKit(kit: StarterKit): void {
  const { selected, installed } = useSetupStore.getState();
  useSetupStore.setState({
    selected: [...toggleKit(kit, new Set(selected), new Set(installed))],
  });
}

export function toggleSetupExtension(repo: string): void {
  const { selected } = useSetupStore.getState();
  useSetupStore.setState({
    selected: [...toggleExtension(repo, new Set(selected))],
  });
}

/** What Install would fetch, from the kits as the trust list allows them now. */
export function setupPending(
  state: Pick<SetupState, "kits" | "selected" | "installed">,
  trust: TrustList = useTrust.getState().list,
): KitExtension[] {
  if (state.kits.status !== "ready") return [];
  return pendingInstalls(
    visibleKits(state.kits.kits, trust),
    new Set(state.selected),
    new Set(state.installed),
  );
}

const installDeps = (): InstallDeps => ({
  bannedReason,
  isVerified,
  checkReview,
  install: installFromGitHub,
  rememberSource,
  timeoutMs: SETUP_INSTALL_TIMEOUT_MS,
});

const replaceRow = (next: InstallRow): void =>
  useSetupStore.setState((s) => ({
    installs: (s.installs ?? []).map((r) => (r.repo === next.repo ? next : r)),
  }));

/** The click is the person's acknowledgement of the third-party notice shown
 *  beside the button, as the store's one-time prompt is. */
export async function startSetupInstalls(): Promise<void> {
  const state = useSetupStore.getState();
  if (state.installing || state.installs) return;
  const rows = setupPending(state).map(waitingRow);
  if (rows.length === 0) return;
  setAckedExtensionRisk();
  useSetupStore.setState({ installs: rows, installing: true });
  // `installing` blocks closing setup, so it must clear however the run ends.
  try {
    await runSetupInstalls(rows, installDeps(), replaceRow);
  } finally {
    useSetupStore.setState({ installing: false });
    void loadInstalled();
  }
}

export async function retrySetupInstall(repo: string): Promise<void> {
  const { installs, installing } = useSetupStore.getState();
  const row = installs?.find((r) => r.repo === repo);
  if (!row || installing) return;
  if (row.status !== "failed" && row.status !== "timed-out") return;
  useSetupStore.setState({ installing: true });
  try {
    replaceRow({ ...row, status: "installing", detail: "" });
    replaceRow(await installOne(row, installDeps()));
  } finally {
    useSetupStore.setState({ installing: false });
    void loadInstalled();
  }
}

const FIRST_RUN_BUDGET_MS = 3_000;

const defaultSources = (): SignalSources => ({
  countRecentProjects: async () => (await listRecentProjects()).length,
  countInstalledExtensions: async () =>
    (await window.safelightNative?.plugins.list())?.length ?? 0,
  hasSavedPreferences: () =>
    localStorage.getItem(THEME_STORAGE_KEY) !== null ||
    localStorage.getItem(SETTINGS_STORAGE_KEY) !== null,
});

function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

async function decideAndOpen(
  sources: SignalSources,
  budgetMs: number,
): Promise<void> {
  const record = readSetupRecord(localStorage);
  let signals: ProfileSignals | null = null;
  if (!record && window.safelightNative)
    signals = await within(gatherProfileSignals(sources), budgetMs);
  const decision = decideFirstRun(record, signals);
  if (decision === "existing-profile")
    writeSetupRecord(localStorage, "not-needed", __APP_VERSION__);
  // The person opened setup themselves while this was pending.
  if (useSetupStore.getState().phase === "open") return;
  if (decision === "open") {
    if (!record) writeSetupRecord(localStorage, "in-progress", __APP_VERSION__);
    openSetup("first-run");
    return;
  }
  useSetupStore.setState({ phase: "closed" });
}

let firstRun: Promise<void> | null = null;

/** Decide once per launch, in the main window, whether setup opens by itself.
 *  Memoised: StrictMode mounts effects twice. */
export function initFirstRun(
  sources: SignalSources = defaultSources(),
  budgetMs = FIRST_RUN_BUDGET_MS,
): Promise<void> {
  firstRun ??= decideAndOpen(sources, budgetMs);
  return firstRun;
}

/** The app decides once per launch; tests need a fresh launch each time. */
export function resetSetupForTests(): void {
  firstRun = null;
  kitsRequest += 1;
  useSetupStore.setState(INITIAL, true);
}
