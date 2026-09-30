// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useUIStore } from "@/state/ui-store";
import { useModules } from "@/extensions/registry";
import { attachModule, detachModule, focusDetached } from "@/state/detach";

// The Library / Develop / … strip: the built-ins, then every module an
// extension registered, each with its pop-out control.
export function ModuleTabs() {
  const modules = useModules();
  const activeModule = useUIStore((s) => s.activeModule);
  const setActiveModule = useUIStore((s) => s.setActiveModule);
  const detached = useUIStore((s) => s.detached);

  return (
    <nav aria-label="Views" className="flex items-center gap-1">
      {modules.map(({ id, label }) => {
        const isDetached = detached.has(id);
        const isActive = activeModule === id && !isDetached;
        return (
          <div key={id} className="flex items-center rounded">
            <button
              onClick={() => (isDetached ? focusDetached(id) : setActiveModule(id))}
              className={`rounded-l px-3 py-1 text-[11px] uppercase tracking-wider transition-colors ${
                isActive
                  ? "bg-surface-3 text-text-primary"
                  : isDetached
                    ? "italic text-text-muted hover:text-text-secondary"
                    : "text-text-secondary hover:text-text-primary"
              }`}
              title={isDetached ? "Open in its window" : undefined}
            >
              {label}
            </button>
            <button
              onClick={() => (isDetached ? attachModule(id) : detachModule(id))}
              title={isDetached ? "Re-attach to this window" : "Open in a new window"}
              aria-label={`${label}: ${isDetached ? "re-attach to this window" : "open in a new window"}`}
              className="rounded-r py-1 pr-1.5 pl-0.5 text-[10px] text-text-muted hover:text-text-primary"
            >
              {isDetached ? "⧈" : "⧉"}
            </button>
          </div>
        );
      })}
    </nav>
  );
}
