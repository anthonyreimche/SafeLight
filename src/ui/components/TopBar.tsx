import type { AppModule } from "@/catalog/types";
import { useUIStore } from "@/state/ui-store";

const modules: { key: AppModule; label: string; shortcut: string }[] = [
  { key: "library", label: "Library", shortcut: "G" },
  { key: "develop", label: "Develop", shortcut: "D" },
  { key: "loupe", label: "Loupe", shortcut: "E" },
  { key: "export", label: "Export", shortcut: "" },
];

export function TopBar() {
  const activeModule = useUIStore((s) => s.activeModule);
  const setActiveModule = useUIStore((s) => s.setActiveModule);

  return (
    <div className="flex h-9 items-center justify-between border-b border-border bg-surface-1 px-3">
      <div className="flex items-center gap-1">
        <span className="mr-3 text-xs font-semibold tracking-widest text-text-secondary">
          SAFELIGHT
        </span>
        {modules.map((m) => (
          <button
            key={m.key}
            onClick={() => setActiveModule(m.key)}
            className={`rounded px-3 py-1 text-[11px] uppercase tracking-wider transition-colors ${
              activeModule === m.key
                ? "bg-surface-3 text-text-primary"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}
