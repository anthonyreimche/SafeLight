// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// In-app replacement for native window.confirm and window.alert. Native
// confirm/alert suspend the renderer, and Electron can lose the window's focus
// state when the native dialog closes — keystrokes stop reaching inputs until
// the window is refocused or the app restarts (electron#31917) — so nothing in
// the renderer may call them. Callers await confirmDialog() or alertDialog();
// ConfirmDialogHost, mounted once per window, renders the oldest pending
// request as a lightweight card (the PresetRenameDialog pattern). Requests
// queue FIFO and the promise always resolves — for confirms, cancel, backdrop
// click, and Esc (via the shared escape stack) all resolve false; an alert is
// a one-button notice that resolves however it's dismissed.

import { useEffect, useRef } from "react";
import { create } from "zustand";
import { pushEscapeHandler } from "@/ui/escape-stack";

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" paints the confirm button in the destructive red — reserve it
   *  for actions that destroy data (deleting files, irreversible removals). */
  variant?: "default" | "danger";
}

export type AlertDialogOptions = Pick<
  ConfirmDialogOptions,
  "title" | "message" | "confirmLabel"
>;

interface PendingConfirm extends ConfirmDialogOptions {
  id: number;
  kind: "confirm" | "alert";
  resolve: (confirmed: boolean) => void;
}

const useConfirmQueue = create<{ queue: PendingConfirm[] }>(() => ({ queue: [] }));

let nextId = 0;

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useConfirmQueue.setState((s) => ({
      queue: [...s.queue, { ...options, kind: "confirm", id: nextId++, resolve }],
    }));
  });
}

export function alertDialog(options: AlertDialogOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    useConfirmQueue.setState((s) => ({
      queue: [
        ...s.queue,
        { ...options, kind: "alert", id: nextId++, resolve: () => resolve() },
      ],
    }));
  });
}

/** True from the moment confirmDialog()/alertDialog() is called until its
 *  answer, before the card has even mounted. A native dialog froze every key
 *  handler in the window; this card doesn't, so global shortcuts consult this
 *  and stand down. Not the Preferences shortcuts-suspended flag: that one is a
 *  single boolean, and a confirm opening over Preferences would clobber it. */
export function isDialogOpen(): boolean {
  return useConfirmQueue.getState().queue.length > 0;
}

function settle(request: PendingConfirm, confirmed: boolean): void {
  useConfirmQueue.setState((s) => ({ queue: s.queue.filter((q) => q !== request) }));
  request.resolve(confirmed);
}

export function ConfirmDialogHost() {
  const request = useConfirmQueue((s) => s.queue[0] ?? null);
  if (!request) return null;
  // Keyed by request so each queued confirm mounts fresh (focus + Esc handler).
  return <ConfirmCard key={request.id} request={request} />;
}

function ConfirmCard({ request }: { request: PendingConfirm }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Focus the affirmative button (Enter confirms, like native confirm) and hand
  // focus back to wherever it was once the card closes.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    const off = pushEscapeHandler(() => settle(request, false));
    return () => {
      off();
      prev?.focus?.();
    };
  }, [request]);

  const titleId = `confirm-title-${request.id}`;
  const isAlert = request.kind === "alert";
  return (
    // z above ModalWindow's z-[100] backdrop: confirms may open over the
    // Extensions/Preferences windows.
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) settle(request, false);
      }}
    >
      <div
        role={isAlert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-[400px] max-w-[90vw] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-xl"
      >
        <div className="space-y-2 p-3">
          <div
            id={titleId}
            className="text-[10px] uppercase tracking-wide text-[var(--color-text-tertiary)]"
          >
            {request.title}
          </div>
          {/* pre-line: single newlines carry list structure (e.g. per-file
              failure reports); blank lines still split real paragraphs. */}
          {request.message.split(/\n{2,}/).map((paragraph, i) => (
            <p
              key={i}
              className="whitespace-pre-line text-[12px] leading-relaxed text-[var(--color-text)]"
            >
              {paragraph}
            </p>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] p-3">
          {!isAlert && (
            <button
              className="rounded bg-[var(--color-surface-2)] px-3 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
              onClick={() => settle(request, false)}
            >
              {request.cancelLabel ?? "Cancel"}
            </button>
          )}
          <button
            ref={confirmRef}
            className={`rounded px-3 py-1 text-[11px] font-medium text-white hover:opacity-90 ${
              request.variant === "danger"
                ? "bg-[var(--color-label-red)]"
                : "bg-[var(--color-accent)]"
            }`}
            onClick={() => settle(request, true)}
          >
            {request.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
