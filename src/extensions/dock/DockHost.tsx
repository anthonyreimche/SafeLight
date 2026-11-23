// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The dock's React surface: side and bottom rails, floating windows, panel
// headers and the drag overlay, all hosted by DockHost around a module's view.

import {
  createContext,
  memo,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ContextMenu } from "@/ui/components/ContextMenu";
import { ErrorBoundary } from "@/ui/components/ErrorBoundary";
import {
  useRegistry,
  usePanelHeaderAccessories,
  usePanelTitle,
  panelTitle,
} from "../registry";
import { panelIsPreviewable } from "@/modules/develop/panel-bypass";
import { getSettings } from "@/state/settings-store";
import type { AppModule } from "@/catalog/types";
import type { PanelPlacement } from "../types";
import { boundaryKey } from "../guard";
import { initModule } from "./layouts";
import {
  DEFAULT_BOTTOM,
  MAX_BOTTOM,
  MAX_FLOAT,
  MAX_RAIL,
  MIN_BOTTOM,
  MIN_FLOAT,
  MIN_RAIL,
  useDockStore,
  type DockSide,
  type RailState,
} from "./store";
import {
  bringToFront,
  closeDockPanel,
  setFloatWidth,
  setRailHeight,
  setRailWidth,
  soloCollapsed,
  toggleCollapsed,
} from "./actions";
import { startHeaderDrag, startResize } from "./dnd";
import { prewarmPanel } from "./prewarm";
import { EASE_OUT, MOTION_FAST_MS } from "@/ui/motion";
import { reducedMotion } from "@/ui/reduced-motion";

function PanelErrorBoundary({ id, children }: { id: string; children: ReactNode }) {
  return (
    <ErrorBoundary what={`Panel "${id}"`} className="p-3 text-[11px] text-danger">
      {children}
    </ErrorBoundary>
  );
}

/** The hosting dock panel's title. A Panel whose own title matches renders
 *  without its collapsible header — the dock header already names it. */
export const DockPanelTitleCtx = createContext<string | null>(null);

const ContainerCtx = createContext<RefObject<HTMLDivElement | null> | null>(null);

const PLACEMENTS: Record<PanelPlacement["side"], PanelPlacement> = {
  left: { side: "left" },
  right: { side: "right" },
  bottom: { side: "bottom" },
  float: { side: "float" },
};
const PlacementCtx = createContext<PanelPlacement>(PLACEMENTS.float);

/** Where the hosting dock panel currently sits — lets a panel adapt its layout
 *  to its rail (e.g. a strip renders horizontal in a bottom rail). "float"
 *  covers floating windows and any render outside the dock. */
export function useDockPlacement(): PanelPlacement {
  return useContext(PlacementCtx);
}

const PanelBody = memo(function PanelBody({ id }: { id: string }) {
  const reg = useRegistry((s) => s.panels[id]);
  if (!reg)
    return (
      <div className="p-3 text-[11px] text-text-muted">
        Panel “{id}” is disabled or not installed.
      </div>
    );
  const C = reg.component;
  return (
    <DockPanelTitleCtx.Provider value={reg.title}>
      <C />
    </DockPanelTitleCtx.Provider>
  );
});

function PanelHeader({ id }: { id: string }) {
  const containerRef = useContext(ContainerCtx);
  const title = usePanelTitle(id);
  const onReset = useRegistry((s) => s.panels[id]?.onReset);
  const Accessory = useRegistry((s) => s.panels[id]?.headerAccessory);
  // Controls an extension contributes to EVERY panel header (e.g. a preview-off
  // eye). Each gets the panel's identity so one component can decorate all.
  const headerAccessories = usePanelHeaderAccessories();
  const module = useRegistry((s) => s.panels[id]?.defaultDock?.module);
  const extensionId = useRegistry((s) => s.panels[id]?.extensionId ?? "");
  const previewable = useRegistry((s) => panelIsPreviewable(id, s));
  const collapsed = useDockStore((s) => !!s.collapsed[id]);
  // The marker points the way the body will go: a column folds up to the right,
  // a bottom strip folds down out of the canvas's way.
  const { side } = useDockPlacement();
  const marker = side === "bottom" ? (collapsed ? "▴" : "▾") : collapsed ? "▸" : "▾";
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <div
      onPointerDown={(e) => startHeaderDrag(id, e, containerRef?.current ?? null)}
      onPointerEnter={() => prewarmPanel(id)}
      onContextMenu={
        onReset
          ? (e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY });
            }
          : undefined
      }
      className="flex h-7 shrink-0 cursor-grab select-none items-center gap-1.5 border-b border-border-subtle bg-surface-2 px-2"
    >
      <span className="w-2 text-[9px] text-text-muted" aria-hidden="true">
        {marker}
      </span>
      {Accessory && (
        <span className="flex items-center leading-none">
          <ErrorBoundary
            key={boundaryKey(id, Accessory)}
            what={`Panel "${id}" header`}
            className="truncate text-[11px] text-danger"
          >
            <Accessory />
          </ErrorBoundary>
        </span>
      )}
      {headerAccessories.map(({ id: accId, component: A }) => (
        <span key={accId} className="flex items-center leading-none">
          <ErrorBoundary
            key={boundaryKey(accId, A)}
            what={`Header control "${accId}"`}
            className="truncate text-[11px] text-danger"
          >
            <A
              panelId={id}
              title={title}
              module={module}
              extensionId={extensionId}
              previewable={previewable}
            />
          </ErrorBoundary>
        </span>
      ))}
      {/* Not a <button>: the header starts its collapse-or-drag gesture on any
          press outside a button, and the title is most of the header. */}
      <span
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        title={`Click to collapse or expand · Alt+click to expand only this panel · Drag to move${
          onReset ? " · Right-click to reset" : ""
        }`}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          if (e.altKey) soloCollapsed(id);
          else toggleCollapsed(id);
        }}
        className="flex-1 truncate text-[11px] uppercase tracking-wider text-text-secondary"
      >
        {title}
      </span>
      <button
        type="button"
        title="Close panel"
        aria-label={`Close ${title} panel`}
        onClick={() => closeDockPanel(id)}
        className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[12px] leading-none text-text-muted hover:bg-surface-3 hover:text-text-primary"
      >
        ×
      </button>
      {menu && onReset && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[{ label: "Reset to defaults", onClick: onReset }]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** True from the moment a panel that was collapsed is expanded until it is
 *  collapsed again. Sticky so the body's wrapper keeps one shape, and the body
 *  inside it stays mounted, once the enter has played. A panel that mounts
 *  expanded never enters. */
function useExpandedEnter(collapsed: boolean): boolean {
  const wasCollapsed = useRef(collapsed);
  const entering = useRef(false);
  if (collapsed) entering.current = false;
  else if (wasCollapsed.current) entering.current = true;
  useLayoutEffect(() => {
    wasCollapsed.current = collapsed;
  });
  return entering.current;
}

/** Expanding folds the body open (0fr to 1fr rows) instead of popping in. The body is
 *  clipped only while it folds open: settled, it may overflow its panel as before.
 *  The wrapper stays once settled, so the body isn't remounted when the class goes. */
function ExpandEnter({ enter, children }: { enter: boolean; children: ReactNode }) {
  const [settled, setSettled] = useState(false);
  if (!enter && settled) setSettled(false);
  // Under Reduce motion the animation never runs, so it would never end and unclip.
  const folding = enter && !settled && !reducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!folding || !el) return;
    const onEnd = (e: Event) => {
      if (e.target === el) setSettled(true);
    };
    // Cancelled (the rail hidden mid-fold) counts as done, or the body stays clipped.
    el.addEventListener("animationend", onEnd);
    el.addEventListener("animationcancel", onEnd);
    return () => {
      el.removeEventListener("animationend", onEnd);
      el.removeEventListener("animationcancel", onEnd);
    };
  }, [folding]);
  if (!enter) return <>{children}</>;
  return (
    <div ref={wrapRef} className={folding ? "sl-enter-expand" : undefined}>
      {children}
    </div>
  );
}

/** `stretch` panels fill the remaining rail space and let the body scroll
 *  itself (fill panels in side rails; every panel in a bottom rail). */
const DockedPanel = memo(function DockedPanel({
  id,
  stretch = false,
}: {
  id: string;
  stretch?: boolean;
}) {
  const collapsed = useDockStore((s) => !!s.collapsed[id]);
  const enter = useExpandedEnter(collapsed);
  const body = (
    <PanelErrorBoundary id={id}>
      <PanelBody id={id} />
    </PanelErrorBoundary>
  );
  return (
    <div
      data-dock-panel={id}
      className={`border-b border-border ${
        stretch ? "flex min-h-0 min-w-0 flex-1 flex-col" : "shrink-0"
      }`}
    >
      <PanelHeader id={id} />
      {!collapsed &&
        (stretch ? (
          // A stretched body can't fold open (its height is the leftover space),
          // so it rises in instead.
          <div className={`min-h-0 flex-1 overflow-hidden ${enter ? "sl-enter-rise" : ""}`}>
            {body}
          </div>
        ) : (
          <ExpandEnter enter={enter}>{body}</ExpandEnter>
        ))}
    </div>
  );
});

const Rail = memo(function Rail({ rail }: { rail: RailState }) {
  // At most one fill panel per rail stretches to the leftover height; while one
  // is present (and expanded) the rail stops scrolling and the panel scrolls.
  const fillId = useRegistry(
    (s) => rail.panels.find((id) => s.panels[id]?.fill) ?? null,
  );
  const fillExpanded = useDockStore((s) => !!fillId && !s.collapsed[fillId]);
  return (
    <PlacementCtx.Provider value={PLACEMENTS[rail.side]}>
      <div
        data-rail={rail.id}
        className={`relative h-full shrink-0 bg-surface-1 ${
          rail.side === "left" ? "border-r" : "border-l"
        } border-border`}
        style={{ width: rail.width }}
      >
        <div
          className={
            fillExpanded
              ? "flex h-full flex-col overflow-hidden"
              : "h-full overflow-y-auto overflow-x-hidden"
          }
        >
          {rail.panels.map((id) => (
            <DockedPanel key={id} id={id} stretch={fillExpanded && id === fillId} />
          ))}
        </div>
        <div
          onPointerDown={(e) =>
            startResize(e, rail.width, MIN_RAIL, MAX_RAIL,
              rail.side === "left" ? 1 : -1,
              (w) => setRailWidth(rail.id, w))
          }
          className={`absolute top-0 z-10 h-full w-1 cursor-col-resize hover:bg-accent/40 ${
            rail.side === "left" ? "-right-0.5" : "-left-0.5"
          }`}
        />
      </div>
    </PlacementCtx.Provider>
  );
});

const BottomRail = memo(function BottomRail({ rail }: { rail: RailState }) {
  // Collapsing a bottom panel folds the strip downward: with every panel in the
  // rail collapsed it drops its fixed height and sizes to the headers alone, so
  // the canvas takes back the band instead of looking at an empty strip. (One
  // collapsed panel beside an expanded one just narrows to its own header.)
  const allCollapsed = useDockStore((s) => rail.panels.every((id) => s.collapsed[id]));
  return (
    <PlacementCtx.Provider value={PLACEMENTS.bottom}>
      <div
        data-rail={rail.id}
        className="relative w-full shrink-0 border-t border-border bg-surface-1"
        style={allCollapsed ? undefined : { height: rail.height ?? DEFAULT_BOTTOM }}
      >
        <div
          className={`flex overflow-hidden [&>*:not(:last-child)]:border-r ${
            allCollapsed ? "" : "h-full"
          }`}
        >
          {rail.panels.map((id) => (
            <DockedPanel key={id} id={id} stretch />
          ))}
        </div>
        {/* Nothing to resize while it's folded away; the stored height comes
            back when a panel is expanded again. */}
        {!allCollapsed && (
          <div
            onPointerDown={(e) =>
              startResize(e, rail.height ?? DEFAULT_BOTTOM, MIN_BOTTOM, MAX_BOTTOM, -1,
                (h) => setRailHeight(rail.id, h), "y")
            }
            className="absolute -top-0.5 left-0 z-10 h-1 w-full cursor-row-resize hover:bg-accent/40"
          />
        )}
      </div>
    </PlacementCtx.Provider>
  );
});

const FloatingPanel = memo(function FloatingPanel({ id }: { id: string }) {
  const pos = useDockStore((s) => s.floating[id]);
  const z = useDockStore((s) => s.zOrder.indexOf(id));
  const collapsed = useDockStore((s) => !!s.collapsed[id]);
  const enter = useExpandedEnter(collapsed);
  if (!pos) return null;
  // Centred windows track the workspace centre by CSS, so they stay centred
  // whatever the panel's natural height; the height cap keeps a tall panel's
  // header reachable (the body scrolls) instead of centring it off both edges.
  const placement = pos.centered
    ? {
        left: `calc(50% + ${pos.x}px)`,
        top: `calc(50% + ${pos.y}px)`,
        transform: "translate(-50%, -50%)",
        maxHeight: "calc(100% - 16px)",
      }
    : { left: pos.x, top: pos.y };
  return (
    <div
      onPointerDown={() => bringToFront(id)}
      className="sl-floating-panel absolute flex flex-col overflow-hidden rounded border border-border bg-surface-1 shadow-2xl"
      style={{ ...placement, width: pos.width, zIndex: 30 + Math.max(z, 0) }}
    >
      <PanelHeader id={id} />
      {!collapsed && (
        <ExpandEnter enter={enter}>
          <div className="max-h-[70vh] overflow-y-auto">
            <PanelErrorBoundary id={id}>
              <PanelBody id={id} />
            </PanelErrorBoundary>
          </div>
        </ExpandEnter>
      )}
      <div
        onPointerDown={(e) =>
          startResize(e, pos.width, MIN_FLOAT, MAX_FLOAT, 1, (w) =>
            setFloatWidth(id, w))
        }
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40"
      />
    </div>
  );
});

function DragOverlay() {
  const drag = useDockStore((s) => s.drag);
  const target = useDockStore((s) => s.target);
  const title = useRegistry((s) => (drag ? panelTitle(s.panels, drag.id) : ""));
  if (!drag) return null;
  // These coords are visual px (client coords / getBoundingClientRect from
  // hitTest); the fixed elements are <body>-zoom descendants whose CSS left/top
  // are layout px, so map back through the zoom (see frame-point.ts).
  const z = getSettings().uiScale || 1;
  return (
    <>
      {target && target.kind !== "float" && (
        <div
          className={`pointer-events-none fixed z-50 ${
            target.kind === "rail" ? "bg-accent" : "bg-accent/70"
          }`}
          style={{
            left: target.line.x / z,
            top: target.line.y / z,
            width: target.line.w / z,
            height: target.line.h / z,
          }}
        />
      )}
      <div
        className="pointer-events-none fixed z-50 rounded border border-accent bg-surface-2 px-3 py-1 text-[11px] uppercase tracking-wider text-text-primary opacity-90 shadow-xl"
        style={{ left: drag.x / z + 10, top: drag.y / z + 10 }}
      >
        {title}
      </div>
    </>
  );
}

export function DockHost({
  module,
  children,
}: {
  module: AppModule;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ready = useDockStore((s) => s.module === module);
  const hidden = useDockStore((s) => s.hidden);
  const rails = useDockStore((s) => s.rails);
  const floatIds = useDockStore((s) => s.zOrder);

  // A layout effect so the incoming module's rails commit before the browser
  // paints; `ready` keeps the outgoing module's rails off the screen until then.
  const workspaceRef = useRef<HTMLDivElement>(null);
  const shownModule = useRef(module);
  useLayoutEffect(() => {
    initModule(module);
    // Fade the same elements in rather than keying them: the canvas measures its
    // box, and a remount would drop the dock's panels.
    const el = workspaceRef.current;
    const switched = shownModule.current !== module;
    shownModule.current = module;
    if (!switched || !el || typeof el.animate !== "function" || reducedMotion()) return;
    el.animate({ opacity: [0, 1] }, { duration: MOTION_FAST_MS, easing: EASE_OUT });
  }, [module]);

  const shown = (side: DockSide) => ready && !hidden[side];
  const left = shown("left") ? rails.filter((r) => r.side === "left") : [];
  const right = shown("right") ? rails.filter((r) => r.side === "right") : [];
  const bottom = shown("bottom") ? rails.filter((r) => r.side === "bottom") : [];

  return (
    <ContainerCtx.Provider value={containerRef}>
      <div ref={containerRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div ref={workspaceRef} className="flex min-h-0 flex-1 overflow-hidden">
          {left.map((r) => (
            <Rail key={r.id} rail={r} />
          ))}
          <div data-dock-main className="flex h-full min-w-0 flex-1 flex-col">
            {children}
          </div>
          {right.map((r) => (
            <Rail key={r.id} rail={r} />
          ))}
        </div>
        {bottom.map((r) => (
          <BottomRail key={r.id} rail={r} />
        ))}
        {shown("floating") && floatIds.map((id) => <FloatingPanel key={id} id={id} />)}
        <DragOverlay />
      </div>
    </ContainerCtx.Provider>
  );
}
