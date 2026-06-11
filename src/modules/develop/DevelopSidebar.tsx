// EditActionsPanel ("Edit"): undo / redo / reset only. All other develop
// panels dock individually via their defaultDock registrations in builtin.tsx.

import { useDevelopStore } from "@/state/develop-store";

export function EditActionsPanel() {
  const reset = useDevelopStore((s) => s.reset);
  const undo = useDevelopStore((s) => s.undo);
  const redo = useDevelopStore((s) => s.redo);
  const historyIndex = useDevelopStore((s) => s.historyIndex);
  const historyLength = useDevelopStore((s) => s.history.length);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < historyLength - 1;

  const btn =
    "flex-1 rounded bg-surface-2 px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:cursor-default disabled:opacity-30";

  return (
    <div className="flex items-center gap-1.5 p-2">
      <button onClick={undo} disabled={!canUndo} className={btn} title="Undo">
        {"↩"} Undo
      </button>
      <button onClick={redo} disabled={!canRedo} className={btn} title="Redo">
        {"↪"} Redo
      </button>
      <button onClick={reset} className={btn} title="Reset all edits">
        Reset
      </button>
    </div>
  );
}
