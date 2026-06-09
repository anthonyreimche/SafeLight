import { useRef, type ReactNode } from "react";
import { TopBar } from "./TopBar";
import { useUIStore } from "@/state/ui-store";

interface AppShellProps {
  leftSidebar?: ReactNode;
  rightSidebar?: ReactNode;
  children: ReactNode;
  statusBar?: ReactNode;
}

export function AppShell({
  leftSidebar,
  rightSidebar,
  children,
  statusBar,
}: AppShellProps) {
  const leftOpen = useUIStore((s) => s.leftSidebarOpen);
  const rightOpen = useUIStore((s) => s.rightSidebarOpen);
  const leftSidebarWidth = useUIStore((s) => s.leftSidebarWidth);
  const setLeftSidebarWidth = useUIStore((s) => s.setLeftSidebarWidth);
  const rightSidebarWidth = useUIStore((s) => s.rightSidebarWidth);
  const setRightSidebarWidth = useUIStore((s) => s.setRightSidebarWidth);

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        {leftSidebar && leftOpen && (
          <>
            <aside
              className="flex shrink-0 flex-col overflow-y-auto border-r border-border bg-surface-1"
              style={{ width: leftSidebarWidth }}
            >
              {leftSidebar}
            </aside>
            <ResizeHandle
              onResize={(clientX) =>
                setLeftSidebarWidth(Math.min(600, Math.max(180, clientX)))
              }
            />
          </>
        )}

        <main className="flex min-w-0 flex-1 flex-col bg-surface-0">
          {children}
        </main>

        {rightSidebar && rightOpen && (
          <>
            <ResizeHandle
              onResize={(clientX) =>
                setRightSidebarWidth(
                  Math.min(600, Math.max(240, window.innerWidth - clientX)),
                )
              }
            />
            <aside
              className="flex shrink-0 flex-col overflow-y-auto border-l border-border bg-surface-1"
              style={{ width: rightSidebarWidth }}
            >
              {rightSidebar}
            </aside>
          </>
        )}
      </div>
      {statusBar && (
        <div className="flex h-6 items-center border-t border-border bg-surface-1 px-3 text-[10px] text-text-muted">
          {statusBar}
        </div>
      )}
    </div>
  );
}

// A thin draggable divider on the right sidebar's left edge. Reports the pointer
// x-position; the parent converts it to a clamped width.
function ResizeHandle({ onResize }: { onResize: (clientX: number) => void }) {
  const dragging = useRef(false);
  return (
    <div
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (dragging.current) onResize(e.clientX);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      title="Drag to resize"
      className="w-1 shrink-0 cursor-col-resize bg-border/30 transition-colors hover:bg-accent/50"
    />
  );
}
