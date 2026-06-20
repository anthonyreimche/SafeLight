import { useEffect } from "react";

interface Props {
  name: string;
  onOverwrite: () => void;
  onSaveAsNew: () => void;
  onCancel: () => void;
}

/** Shown when saving a preset whose name already exists. Modeled on the app's
 *  modal pattern (see LensPickerDialog). */
export function PresetOverwriteDialog({
  name,
  onOverwrite,
  onSaveAsNew,
  onCancel,
}: Props) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-[320px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4 shadow-xl">
        <p className="mb-4 text-[12px] text-[var(--color-text)]">
          A preset named &ldquo;{name}&rdquo; already exists.
        </p>
        <div className="flex justify-end gap-2">
          <button
            className="rounded bg-[var(--color-accent)] px-3 py-1 text-[11px] font-medium text-white hover:opacity-90"
            onClick={onOverwrite}
          >
            Overwrite
          </button>
          <button
            className="rounded bg-[var(--color-surface-2)] px-3 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)]"
            onClick={onSaveAsNew}
          >
            Save as new
          </button>
          <button
            className="rounded bg-[var(--color-surface-2)] px-3 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
