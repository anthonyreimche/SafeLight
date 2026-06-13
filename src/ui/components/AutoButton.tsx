// Small "Auto" button shown at the top-right of a tool panel (White Balance,
// Basic, …). Disabled until a histogram is available to compute from.

interface AutoButtonProps {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

export function AutoButton({ onClick, disabled = false, title }: AutoButtonProps) {
  return (
    <div className="mb-2 flex justify-end">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title}
        className="rounded border border-border-subtle px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-secondary hover:text-text-primary hover:border-border disabled:opacity-40 disabled:cursor-default"
      >
        Auto
      </button>
    </div>
  );
}
