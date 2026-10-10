// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Step 2 of the welcome setup: starter kits by shooting style. A kit card is a
// tri-state checkbox over its extensions, with a sibling disclosure button
// (never nested, so each control has one role) that opens the list for single
// picks. Kits are filtered by the trust list as it is now, so an extension
// unverified or banned since kits.json was published never shows.

import { useTrust } from "@/extensions/trust";
import { KitGlyph } from "./KitGlyph";
import type { StarterKit } from "./kits";
import { kitState, visibleKits, type KitState } from "./selection";
import {
  setExpandedKit,
  setSetupStep,
  setupPending,
  toggleSetupExtension,
  toggleSetupKit,
  useSetupStore,
} from "./setup-store";
import {
  primaryBtn,
  secondaryBtn,
  StepFooter,
  StepHeading,
  type StepProps,
} from "./SetupParts";

const listId = (kit: StarterKit) => `sl-setup-kit-${kit.id}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function TickBox({ state }: { state: KitState }) {
  const on = state === "on" || state === "installed";
  return (
    <span
      aria-hidden="true"
      className={`flex h-4 w-4 items-center justify-center rounded-sm border text-[11px] leading-none ${
        on || state === "mixed"
          ? "border-text-primary bg-text-primary text-surface-0"
          : "border-text-secondary"
      }`}
    >
      {on ? "✓" : state === "mixed" ? "–" : ""}
    </span>
  );
}

function KitCard({
  kit,
  state,
  expanded,
}: {
  kit: StarterKit;
  state: KitState;
  expanded: boolean;
}) {
  const done = state === "installed";
  const descId = `${listId(kit)}-desc`;
  const ariaChecked =
    state === "mixed" ? "mixed" : state === "on" || done ? "true" : "false";
  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border bg-surface-1 p-3 ${
        state === "on" || state === "mixed" ? "border-text-primary" : "border-border"
      }`}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={ariaChecked}
        aria-disabled={done || undefined}
        aria-label={kit.name}
        aria-describedby={kit.description ? descId : undefined}
        onClick={() => {
          if (!done) toggleSetupKit(kit);
        }}
        className="flex flex-col items-start gap-1 text-left"
      >
        <span className="flex w-full items-center justify-between text-text-primary">
          <KitGlyph icon={kit.icon} />
          <TickBox state={state} />
        </span>
        <span className="text-sm font-medium text-text-primary">{kit.name}</span>
        {kit.description && (
          <span id={descId} className="text-xs text-text-secondary">
            {kit.description}
          </span>
        )}
      </button>
      <div className="flex items-center justify-between text-xs text-text-secondary">
        <span>{done ? "All installed" : plural(kit.extensions.length, "extension")}</span>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={expanded ? listId(kit) : undefined}
          aria-label={`${expanded ? "Hide" : "Show"} ${kit.name} extensions`}
          onClick={() => setExpandedKit(expanded ? null : kit.id)}
          className="underline hover:text-text-primary"
        >
          {expanded ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

function KitExtensions({
  kit,
  selected,
  installed,
}: {
  kit: StarterKit;
  selected: ReadonlySet<string>;
  installed: ReadonlySet<string>;
}) {
  return (
    <fieldset
      id={listId(kit)}
      className="mt-3 rounded-lg border border-border bg-surface-1 p-3"
    >
      <legend className="px-1 text-sm text-text-primary">{kit.name}</legend>
      <ul className="flex flex-col gap-2">
        {kit.extensions.map((e) => (
          <li key={e.repo}>
            {installed.has(e.repo) ? (
              <div className="flex items-baseline gap-3">
                <span className="text-sm text-text-primary">{e.name}</span>
                <span className="text-xs text-text-secondary">Installed</span>
              </div>
            ) : (
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={selected.has(e.repo)}
                  onChange={() => toggleSetupExtension(e.repo)}
                  className="mt-1"
                />
                <span className="flex flex-col">
                  <span className="text-sm text-text-primary">{e.name}</span>
                  {e.summary && (
                    <span className="text-xs text-text-secondary">{e.summary}</span>
                  )}
                </span>
              </label>
            )}
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

export function KitsStep({ headingId }: StepProps) {
  const load = useSetupStore((s) => s.kits);
  const selectedRepos = useSetupStore((s) => s.selected);
  const installedRepos = useSetupStore((s) => s.installed);
  const expandedKit = useSetupStore((s) => s.expandedKit);
  const trust = useTrust((s) => s.list);
  const selected = new Set(selectedRepos);
  const installed = new Set(installedRepos);
  const kits = load.status === "ready" ? visibleKits(load.kits, trust) : [];
  const count = setupPending(
    { kits: load, selected: selectedRepos, installed: installedRepos },
    trust,
  ).length;
  const open = kits.find((k) => k.id === expandedKit) ?? null;

  return (
    <>
      <StepHeading
        id={headingId}
        title="Build your own darkroom"
        subtitle="Pick kits for how you shoot, or open one to choose single extensions. Kits list only extensions on the verified list."
      />
      {load.status === "loading" ? (
        <p role="status" className="text-sm text-text-secondary">
          Loading starter kits…
        </p>
      ) : kits.length === 0 ? (
        <p className="text-sm text-text-secondary">
          Starter kits aren't available right now. You can add extensions any
          time from the Extensions store.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
            {kits.map((kit) => (
              <KitCard
                key={kit.id}
                kit={kit}
                state={kitState(kit, selected, installed)}
                expanded={expandedKit === kit.id}
              />
            ))}
          </div>
          {open && (
            <KitExtensions kit={open} selected={selected} installed={installed} />
          )}
        </>
      )}
      <StepFooter
        status={count > 0 ? `${plural(count, "extension")} selected` : undefined}
      >
        <button
          type="button"
          className={secondaryBtn}
          onClick={() => setSetupStep("workspace")}
        >
          Back
        </button>
        <button
          type="button"
          className={primaryBtn}
          onClick={() => setSetupStep("finish")}
        >
          Continue
        </button>
      </StepFooter>
    </>
  );
}
