// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// TEMPORARY DIAGNOSTIC — chasing an intermittent bug where dropdowns and text
// inputs stop accepting keystrokes after extensions are added/removed, until a
// restart (and sometimes it self-clears). Static analysis can't pin it because
// it's transient in-memory state, so this watches for the failure live.
//
// It installs ONLY when the "Developer Tools" extension (core.devtools) is
// enabled at launch, so normal users get nothing. While active it's silent
// until it actually catches one of the two failure modes:
//   • a keystroke meant for a text field is preventDefault()'d  → interception
//   • clicking a text field fails to focus it                   → overlay/focus
// On either it dumps every window-level key listener with the stack of wherever
// it was registered, so a leaked/duplicate global handler is named outright.
// The renderer's CSP blocks console eval, so this reads itself out to the
// console (captured by the DevTools extension's Console tab). Remove once found.

import { isEditableTarget } from "@/state/keybindings-store";
import { useDisabledExtensions } from "@/extensions/loader";

interface KeyListenerRecord {
  type: "keydown" | "keyup";
  listener: EventListenerOrEventListenerObject;
  capture: boolean;
  stack: string;
}

const tracked: KeyListenerRecord[] = [];
let installed = false;

function captureFlag(options?: boolean | AddEventListenerOptions): boolean {
  return typeof options === "boolean" ? options : !!options?.capture;
}

/** Only run while Developer Tools (core.devtools) is enabled. Read straight from
 *  localStorage so there's no store dependency before init. core.devtools ships
 *  default-off and is seeded into the disabled list exactly once; until that
 *  seeding has recorded it (fresh profile, or one predating seeding) its absence
 *  from the disabled list means "not yet decided", not "enabled". */
function diagActive(): boolean {
  try {
    const seeded: unknown = JSON.parse(
      localStorage.getItem("sl_ext_default_seeded") ?? "[]",
    );
    if (!Array.isArray(seeded) || !seeded.includes("core.devtools")) return false;
    const disabled: unknown = JSON.parse(
      localStorage.getItem("sl_ext_disabled") ?? "[]",
    );
    return Array.isArray(disabled) && !disabled.includes("core.devtools");
  } catch {
    return false;
  }
}

/** The frame that actually called add/removeEventListener (skip Error + wrapper). */
function originFrame(stack: string): string {
  const frames = stack.split("\n").map((l) => l.trim());
  return frames[3] ?? frames[2] ?? frames[1] ?? "(unknown)";
}

function dumpListeners(): void {
  const lines = tracked.map(
    (r, i) =>
      `  #${i} ${r.type}${r.capture ? " (capture)" : ""}  ${originFrame(r.stack)}`,
  );
  console.warn(
    `[key-diag] ${tracked.length} window key listener(s) attached:\n${lines.join("\n")}`,
  );
}

export function installKeyDiag(): void {
  if (installed || !diagActive()) return;
  installed = true;
  console.warn("[key-diag] active — watching for swallowed input. Toggle some extensions to repro.");

  const origAdd = window.addEventListener.bind(window);
  const origRemove = window.removeEventListener.bind(window);

  // Track every window keydown/keyup listener so a leaked/duplicate one is visible.
  window.addEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) {
    if ((type === "keydown" || type === "keyup") && listener) {
      tracked.push({
        type,
        listener,
        capture: captureFlag(options),
        stack: new Error().stack ?? "",
      });
    }
    return origAdd(type as keyof WindowEventMap, listener as EventListener, options);
  } as typeof window.addEventListener;

  window.removeEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) {
    if (type === "keydown" || type === "keyup") {
      const cap = captureFlag(options);
      const i = tracked.findIndex(
        (r) => r.type === type && r.listener === listener && r.capture === cap,
      );
      if (i >= 0) tracked.splice(i, 1);
    }
    return origRemove(type as keyof WindowEventMap, listener as EventListener, options);
  } as typeof window.removeEventListener;

  // Probe 1 — a typing key aimed at a text field got swallowed. Registered via
  // the ORIGINAL add so it isn't counted in the inventory it prints.
  origAdd(
    "keydown",
    (e: Event) => {
      const ev = e as KeyboardEvent;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const typing =
        ev.key.length === 1 || ev.key === "Backspace" || ev.key === "Delete" || ev.key === " ";
      if (!typing || !isEditableTarget(ev.target)) return;
      const target = ev.target as HTMLElement;
      queueMicrotask(() => {
        if (!ev.defaultPrevented) return; // normal: nobody touched it, it typed fine
        console.error(
          `[key-diag] "${ev.key}" into an editable element was preventDefault()'d — ` +
            `input is being intercepted.`,
          { target, activeElement: document.activeElement },
        );
        dumpListeners();
      });
    },
    true,
  );

  // Probe 2 — clicking a real text input didn't focus it: a leftover overlay or
  // focus trap is covering the UI (the non-keyboard failure mode).
  origAdd(
    "click",
    (e: Event) => {
      const field = (e.target as HTMLElement)?.closest?.(
        "input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=file]),textarea",
      ) as HTMLInputElement | null;
      if (!field || field.disabled || field.readOnly) return;
      setTimeout(() => {
        if (document.activeElement === field) return; // focused fine
        console.error(
          "[key-diag] clicking a text field did NOT focus it — a leftover overlay or " +
            "focus trap is likely on top of the UI.",
          { field, activeElement: document.activeElement },
        );
        dumpListeners();
      }, 0);
    },
    true,
  );

  // Each enable/disable: the re-render/unmount that adds or STRANDS listeners
  // runs after this store update commits, so sample on a later tick. If the
  // count grew, a listener leaked — dump the inventory so the new one's stack
  // names the file that stranded it.
  let prevCount = tracked.length;
  useDisabledExtensions.subscribe(() => {
    setTimeout(() => {
      const now = tracked.length;
      if (now > prevCount) {
        console.error(
          `[key-diag] window key-listener count rose ${prevCount} → ${now} across a toggle — likely leak:`,
        );
        dumpListeners();
      } else {
        console.warn(`[key-diag] after toggle: ${now} window key listener(s) (was ${prevCount}).`);
      }
      prevCount = now;
    }, 300);
  });
}
