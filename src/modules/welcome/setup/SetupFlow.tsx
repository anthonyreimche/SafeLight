// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The welcome setup: a full-window layer in the main window that walks through
// the look, the workspace behaviour and the starter kits. It opens by itself on
// a fresh install (see initFirstRun) and from the welcome grid, Preferences and
// the Extensions store later on. It is modal: app shortcuts stand down while it
// is up (they would otherwise open dialogs or switch modules underneath), Tab
// stays inside, and Escape closes only a rerun, so a first run can't be skipped
// by a stray key. It sits below ModalWindow (z-100) and the confirm and banners
// (z-200 and up), which never open over it but must win if they do.

import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { setShortcutsSuspended } from "@/state/keybindings-store";
import { trapTab } from "@/ui/focus-trap";
import {
  dragBarStyle,
  noDragStyle,
  useTitleBarOverlay,
} from "@/ui/window-chrome";
import { FinishStep } from "./FinishStep";
import { KitsStep } from "./KitsStep";
import { LookStep } from "./LookStep";
import { closeSetup, useSetupStore, type SetupStep } from "./setup-store";
import { secondaryBtn } from "./SetupParts";
import { WorkspaceStep } from "./WorkspaceStep";

const STEPS: { id: SetupStep; label: string }[] = [
  { id: "look", label: "Look" },
  { id: "workspace", label: "Workspace" },
  { id: "extensions", label: "Extensions" },
  { id: "finish", label: "Finish" },
];

export function SetupFlow() {
  const open = useSetupStore((s) => s.phase === "open");
  return open ? <SetupLayer /> : null;
}

function SetupLayer() {
  useTitleBarOverlay("--color-surface-0");
  const mode = useSetupStore((s) => s.mode);
  const step = useSetupStore((s) => s.step);
  const installing = useSetupStore((s) => s.installing);
  const started = useSetupStore((s) => s.installs !== null);
  const boxRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setShortcutsSuspended(true);
    return () => {
      setShortcutsSuspended(false);
      previous?.focus();
    };
  }, []);

  // Also when installs start and settle: the Install and Retry buttons that
  // held focus unmount.
  useEffect(() => {
    document.getElementById(headingId)?.focus();
  }, [step, headingId, started, installing]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    trapTab(e, boxRef.current);
    if (e.key === "Escape" && mode === "rerun" && !installing) {
      e.preventDefault();
      closeSetup("skipped");
    }
  };
  const current = STEPS.findIndex((s) => s.id === step);

  return (
    <div
      ref={boxRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-[90] flex flex-col bg-surface-0 text-text-primary outline-none"
    >
      <header
        className="flex h-[38px] shrink-0 items-center justify-between px-8"
        style={dragBarStyle}
      >
        <span className="text-sm font-semibold tracking-[0.3em] text-text-secondary">
          SAFELIGHT
        </span>
        {!started && (
          <button
            type="button"
            onClick={() => closeSetup("skipped")}
            style={noDragStyle}
            className={secondaryBtn}
          >
            {mode === "first-run" ? "Skip setup" : "Close"}
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-10">
        <div className="mx-auto max-w-[760px] pt-6">
          <ol aria-label="Setup steps" className="mb-6 flex gap-6 text-xs">
            {STEPS.map((s, i) => (
              <li
                key={s.id}
                aria-current={i === current ? "step" : undefined}
                className={
                  i === current
                    ? "border-b border-text-primary pb-0.5 text-text-primary"
                    : "text-text-secondary"
                }
              >
                {`${i + 1}. ${s.label}`}
              </li>
            ))}
          </ol>
          {step === "look" ? (
            <LookStep headingId={headingId} />
          ) : step === "workspace" ? (
            <WorkspaceStep headingId={headingId} />
          ) : step === "extensions" ? (
            <KitsStep headingId={headingId} />
          ) : (
            <FinishStep headingId={headingId} />
          )}
        </div>
      </div>
    </div>
  );
}
