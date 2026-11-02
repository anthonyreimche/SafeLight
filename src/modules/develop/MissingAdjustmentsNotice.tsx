// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop's word that the open photo uses adjustments from an essential that
// isn't running, so the photo renders without them. The edit keeps them; the
// notice offers the way back (the extension's page, or turning it on), and a
// dismissed one stays away for the session.

import { create } from "zustand";
import { missingAdjustments } from "@/extensions/essential-params";
import {
  setExtensionEnabled,
  useDisabledExtensions,
  useExternalPluginsSettled,
  useRunningPlugins,
} from "@/extensions/loader";
import { officialExtension } from "@/extensions/official-extensions";
import { useDevelopStore } from "@/state/develop-store";
import { openExtensionsOn } from "@/ui/components/extensions-dialog-store";

const useDismissed = create<{ ids: string[] }>(() => ({ ids: [] }));

const dismiss = (id: string) => useDismissed.setState((s) => ({ ids: [...s.ids, id] }));

/** Show dismissed notices again (tests). */
export const resetDismissedAdjustments = () => useDismissed.setState({ ids: [] });

const buttonCls = "rounded border border-border px-2 py-0.5 text-[11px] text-text-primary hover:bg-surface-3";

export function MissingAdjustmentsNotice() {
  const params = useDevelopStore((s) => s.params);
  const asShotTemperature = useDevelopStore((s) => s.asShotTemperature);
  const settled = useExternalPluginsSettled((s) => s.settled);
  const running = useRunningPlugins((s) => s.ids);
  const disabled = useDisabledExtensions((s) => s.ids);
  const dismissed = useDismissed((s) => s.ids);
  if (!settled) return null;
  const missing = missingAdjustments(params, (id) => running.includes(id), asShotTemperature).filter(
    (e) => !dismissed.includes(e.id),
  );
  if (missing.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center gap-1">
      {missing.map((e) => {
        const off = disabled.includes(e.id);
        const repo = officialExtension(e.id)?.repo;
        return (
          <div
            key={e.id}
            role="status"
            className="pointer-events-auto flex items-center gap-2 rounded border border-border bg-surface-2 px-3 py-1.5 text-[11px] text-text-primary shadow-lg"
          >
            <span>
              This photo uses adjustments from {e.name}, which {off ? "is turned off" : "isn't installed"}.
            </span>
            {off ? (
              <button className={buttonCls} onClick={() => void setExtensionEnabled(e.id, true)}>
                Turn on
              </button>
            ) : (
              repo && (
                <button className={buttonCls} onClick={() => openExtensionsOn(repo)}>
                  View in Extensions
                </button>
              )
            )}
            <button
              aria-label="Dismiss"
              title="Dismiss"
              className="px-1 text-text-muted hover:text-text-primary"
              onClick={() => dismiss(e.id)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
