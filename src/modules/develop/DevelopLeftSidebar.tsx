import { MasksPanel } from "./panels/MasksPanel";
import { RetouchPanel } from "./panels/RetouchPanel";

// Left-side toolbox in Develop: local adjustment masks and spot removal
// (heal / clone). Both write into the develop params, so they undo/redo and
// export through the same pipeline as the global edits.
export function DevelopLeftSidebar() {
  return (
    <div className="flex flex-col">
      <div className="flex items-center border-b border-border-subtle px-3 py-2">
        <span className="text-[11px] uppercase tracking-wider text-text-secondary">
          Tools
        </span>
      </div>
      <MasksPanel />
      <RetouchPanel />
    </div>
  );
}
