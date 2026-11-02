// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useRef, useState } from "react";
import { pushEscapeHandler } from "@/ui/escape-stack";
import { useRegistry } from "@/extensions/registry";
import {
  addUserLayout,
  applyDockLayout,
  CUSTOM_LAYOUT,
  deleteUserLayout,
  renameUserLayout,
  updateUserLayout,
  useLayoutStore,
  useUserLayouts,
} from "@/extensions/dock";
import { LayoutExtensionsEditor } from "@/ui/components/LayoutExtensionsEditor";
import { btnCls, labelCls, useFieldVisible } from "@/ui/preferences/fields";

// Panel-layout manager: a selectable list of layouts (Custom + the user's saved
// layouts + read-only presets contributed by extensions). User layouts can be
// updated to the current arrangement, renamed inline, or deleted; "Add layout"
// captures the current dock as a new named layout. Replaces the old dropdown —
// a dropdown can only pick, and the user now needs to manage the list.
export function LayoutField() {
  const presets = useRegistry((s) => s.layouts);
  const userLayouts = useUserLayouts((s) => s.layouts);
  const activeId = useLayoutStore((s) => s.activeId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [extensionsId, setExtensionsId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  // Guards against committing twice when Enter (or Esc) unmounts the input and
  // fires its blur handler too. Reset each time an input opens.
  const committedRef = useRef(false);

  // While an inline name input is open, Esc cancels it (top of the modal
  // escape stack) instead of closing Preferences.
  const inputOpen = adding || editingId !== null;
  useEffect(() => {
    if (!inputOpen) return;
    return pushEscapeHandler(() => {
      committedRef.current = true; // suppress the unmount blur-commit
      setAdding(false);
      setEditingId(null);
    });
  }, [inputOpen]);

  if (!useFieldVisible("Panel layout", "dock arrangement window")) return null;

  const userList = Object.values(userLayouts).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const presetList = Object.values(presets).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const startRename = (id: string, name: string) => {
    committedRef.current = false;
    setAdding(false);
    setEditingId(id);
    setDraft(name);
  };
  const commitRename = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    if (editingId) renameUserLayout(editingId, draft);
    setEditingId(null);
  };
  const startAdd = () => {
    committedRef.current = false;
    setEditingId(null);
    setAdding(true);
    setDraft("");
  };
  const commitAdd = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    addUserLayout(draft);
    setAdding(false);
    setDraft("");
  };

  const nameInput = (onCommit: () => void) => (
    <div className="flex items-center gap-1.5 bg-surface-2 px-2 py-1">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit();
        }}
        onBlur={onCommit}
        placeholder="Layout name"
        aria-label="Layout name"
        spellCheck={false}
        className="min-w-0 flex-1 rounded bg-surface-1 px-1.5 py-0.5 text-[11px] text-text-primary outline-none placeholder:text-text-muted focus:bg-surface-3"
      />
      <button
        // Commit happens on blur; mousedown would blur the input first and make
        // this a no-op, so commit here and let blur see the cleared state.
        onMouseDown={(e) => {
          e.preventDefault();
          onCommit();
        }}
        className="rounded bg-slider-fill px-2 py-0.5 text-[10px] font-medium text-white hover:opacity-90"
      >
        Save
      </button>
    </div>
  );

  return (
    <div>
      <div className={labelCls}>Panel layout</div>
      <div className="mt-1.5 overflow-hidden rounded border border-border">
        <LayoutRow
          active={activeId === CUSTOM_LAYOUT}
          name="Custom"
          hint="Your live arrangement — any change you make to a layout is kept here."
          onClick={() => applyDockLayout(CUSTOM_LAYOUT)}
        />
        {userList.map((l) =>
          editingId === l.id ? (
            <div key={l.id} className="border-t border-border-subtle">
              {nameInput(commitRename)}
            </div>
          ) : (
            <div key={l.id} className="border-t border-border-subtle">
              <LayoutRow
                active={activeId === l.id}
                name={l.name}
                onClick={() => applyDockLayout(l.id)}
                expanded={extensionsId === l.id}
                actions={
                  <>
                    <RowButton
                      title="Choose which extensions this layout switches"
                      label={`Extensions for ${l.name}`}
                      expanded={extensionsId === l.id}
                      onClick={() =>
                        setExtensionsId(extensionsId === l.id ? null : l.id)
                      }
                    >
                      Extensions
                    </RowButton>
                    <RowButton
                      title="Save the current arrangement into this layout"
                      onClick={() => updateUserLayout(l.id)}
                    >
                      ↻
                    </RowButton>
                    <RowButton
                      title="Rename"
                      onClick={() => startRename(l.id, l.name)}
                    >
                      ✎
                    </RowButton>
                    <RowButton
                      title="Delete layout"
                      onClick={() => deleteUserLayout(l.id)}
                    >
                      ×
                    </RowButton>
                  </>
                }
              />
              {extensionsId === l.id && (
                <div className="border-t border-border-subtle">
                  <LayoutExtensionsEditor layoutId={l.id} />
                </div>
              )}
            </div>
          ),
        )}
        {adding && (
          <div className="border-t border-border-subtle">
            {nameInput(commitAdd)}
          </div>
        )}
        {presetList.length > 0 && (
          <div className="border-t border-border bg-surface-0/30 px-2 py-1 text-[9px] uppercase tracking-widest text-text-muted">
            Presets
          </div>
        )}
        {presetList.map((l) => (
          <LayoutRow
            key={l.id}
            active={activeId === l.id}
            name={l.name}
            hint={l.description}
            onClick={() => applyDockLayout(l.id)}
          />
        ))}
      </div>
      <div className="mt-2">
        <button onClick={startAdd} className={btnCls}>
          + Add layout
        </button>
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
        Saves the current panel arrangement (both Library and Develop) as a named
        layout. Switch layouts here or from the Layout menu in the top bar.
      </p>
      <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
        A saved layout can also switch panel and tool extensions on and off.
        Choose which under its Extensions button.
      </p>
    </div>
  );
}

function LayoutRow({
  active,
  name,
  hint,
  onClick,
  actions,
  expanded = false,
}: {
  active: boolean;
  name: string;
  hint?: string;
  onClick: () => void;
  actions?: React.ReactNode;
  /** Something opened from its actions shows beneath it, so they stay visible. */
  expanded?: boolean;
}) {
  return (
    <div
      className={`group flex items-center border-t border-border-subtle first:border-t-0 ${
        active ? "bg-surface-3" : "hover:bg-surface-2"
      }`}
    >
      <button
        onClick={onClick}
        title={hint}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
      >
        <span className="w-3 shrink-0 text-[11px] text-slider-fill">
          {active ? "✓" : ""}
        </span>
        <span
          className={`truncate text-[11px] ${
            active ? "text-text-primary" : "text-text-secondary"
          }`}
        >
          {name}
        </span>
      </button>
      {actions && (
        <div
          className={`flex shrink-0 items-center gap-0.5 px-1 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
            expanded ? "opacity-100" : "opacity-0"
          }`}
        >
          {actions}
        </div>
      )}
    </div>
  );
}

function RowButton({
  title,
  label,
  expanded,
  onClick,
  children,
}: {
  title: string;
  /** Accessible name, when the visible glyph or word isn't enough. */
  label?: string;
  /** Set on a button that shows or hides something beneath its row. */
  expanded?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={label}
      aria-expanded={expanded}
      onClick={onClick}
      className="rounded px-1.5 py-0.5 text-[12px] leading-none text-text-muted hover:bg-surface-4 hover:text-text-primary"
    >
      {children}
    </button>
  );
}
