// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop status-bar drop-up for the active display transform (render
// pipeline), mirroring Preferences ▸ Rendering ▸ Display transform but placed
// beside Assess so it's reachable without opening Preferences. Hidden when only
// the built-in transform is registered — it only earns banner space once an
// extension (e.g. Spektrafilm, Advanced Denoise) adds an alternative. The menu
// opens upward since the control lives at the bottom of the view.
import { useEffect, useRef, useState } from "react";
import { useRegistry } from "@/extensions/registry";
import {
  applyPipeline,
  DEFAULT_PIPELINE,
  usePipelineStore,
} from "@/extensions/pipelines";
import { pushEscapeHandler } from "@/ui/escape-stack";

export function DisplayTransformControl() {
  const pipelines = useRegistry((s) => s.pipelines);
  const activeId = usePipelineStore((s) => s.activeId);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the menu on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    const popEsc = pushEscapeHandler(() => setOpen(false));
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      popEsc();
    };
  }, [open]);

  const options = Object.values(pipelines);
  // Only worth a banner slot once there's a real choice; with just the
  // built-in transform the dropdown would have nothing to switch to.
  if (options.length <= 1) return null;

  // Mirror the Preferences fallback: an unregistered saved id (its extension
  // was disabled) resolves to the built-in transform.
  const active = pipelines[activeId] ?? pipelines[DEFAULT_PIPELINE];

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Display transform — how scene-linear data is tone-mapped for display"
        aria-label="Choose display transform"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-1 text-[10px] ${
          open ? "text-text-primary" : "text-text-muted hover:text-text-primary"
        }`}
      >
        <span>{active?.name ?? "Transform"}</span>
        <span className="text-[7px] leading-none" aria-hidden>
          ▲
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-1/2 mb-1.5 flex min-w-[120px] -translate-x-1/2 flex-col gap-0.5 rounded border border-border bg-surface-2 p-1 shadow-lg"
        >
          {options.map((p) => {
            const checked = p.id === active?.id;
            return (
              <button
                key={p.id}
                role="menuitemradio"
                aria-checked={checked}
                title={p.description}
                onClick={() => {
                  applyPipeline(p.id);
                  setOpen(false);
                }}
                className={`whitespace-nowrap rounded px-2 py-1 text-left text-[11px] leading-none ${
                  checked
                    ? "bg-surface-3 text-text-primary"
                    : "text-text-muted hover:bg-surface-3 hover:text-text-primary"
                }`}
              >
                {p.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
