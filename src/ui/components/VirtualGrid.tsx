// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface VirtualGridProps<T> {
  items: T[];
  /** Cell width in pixels (ignored when columns=1 — cells stretch to fill). */
  cellWidth?: number;
  /** Cell height in pixels. */
  cellHeight: number;
  /** Gap between cells in pixels. */
  gap?: number;
  /** Padding around the grid in pixels. */
  padding?: number;
  /** Fixed column count. When omitted, columns are calculated from container width. */
  columns?: number;
  /** Rows of extra cells to render above and below the viewport. */
  overscan?: number;
  /** Render a single cell. The wrapper handles positioning. */
  renderCell: (item: T, index: number) => React.ReactNode;
  /** Stable key extractor. */
  getKey: (item: T) => string;
  /** Index to keep visible (keyboard navigation). Scrolls into view when it changes. */
  scrollToIndex?: number;
  /** Notified whenever the computed column count changes (for row-wise nav). */
  onColumnsChange?: (columns: number) => void;
  /** Click on the scroll container (e.g. empty space between/around cells). */
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
  /** ARIA role of the scroll container, e.g. "listbox" when cells render as options. */
  role?: "listbox";
  "aria-label"?: string;
}

function visibleRows(scrollTop: number, viewportHeight: number, padding: number, rowHeight: number) {
  return {
    first: Math.floor((scrollTop - padding) / rowHeight),
    last: Math.floor((scrollTop + viewportHeight - padding) / rowHeight),
  };
}

export function VirtualGrid<T>({
  items,
  cellWidth = 0,
  cellHeight,
  gap = 0,
  padding = 0,
  columns: fixedColumns,
  overscan = 2,
  renderCell,
  getKey,
  scrollToIndex,
  onColumnsChange,
  onClick,
  className,
  role,
  "aria-label": ariaLabel,
}: VirtualGridProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // Measure container width with ResizeObserver.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Read the size now so the first paint is already laid out; the observer
    // only reports once a frame later.
    setContainerWidth(el.clientWidth);
    setViewportHeight(el.clientHeight);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerWidth(entry.contentRect.width);
      setViewportHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Column count: fixed, or auto-fit from container width.
  const columns =
    fixedColumns ??
    Math.max(1, Math.floor((containerWidth - 2 * padding + gap) / (cellWidth + gap)));

  const isSingleColumn = columns === 1;
  const effectiveCellWidth = isSingleColumn ? containerWidth : cellWidth;

  // Publish the column count so row-wise keyboard nav (↑/↓) knows the stride.
  const unmeasured = fixedColumns == null && containerWidth === 0;
  useEffect(() => {
    if (!unmeasured) onColumnsChange?.(columns);
  }, [columns, onColumnsChange, unmeasured]);

  const totalRows = Math.ceil(items.length / columns);
  const rowHeight = cellHeight + gap;
  const totalHeight = totalRows > 0 ? totalRows * rowHeight - gap + 2 * padding : 0;

  // The rows the viewport touches. Held as state in place of the scroll offset so a
  // scroll event that stays within the same rows renders nothing.
  const [visible, setVisible] = useState(() => visibleRows(0, 0, padding, rowHeight));
  const syncVisible = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const next = visibleRows(el.scrollTop, viewportHeight, padding, rowHeight);
    setVisible((prev) => (prev.first === next.first && prev.last === next.last ? prev : next));
  }, [viewportHeight, padding, rowHeight]);

  useEffect(syncVisible, [syncVisible]);

  const startRow = Math.max(0, visible.first - overscan);
  const endRow = Math.min(totalRows - 1, visible.last + overscan);

  // Scroll active item into view.
  useEffect(() => {
    if (scrollToIndex == null || scrollToIndex < 0 || !containerRef.current) return;
    const row = Math.floor(scrollToIndex / columns);
    const rowTop = row * rowHeight + padding;
    const rowBottom = rowTop + cellHeight;
    const el = containerRef.current;
    if (rowTop < el.scrollTop) {
      el.scrollTop = rowTop - padding;
    } else if (rowBottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = rowBottom - el.clientHeight + padding;
    }
  }, [scrollToIndex, columns, rowHeight, cellHeight, padding]);

  // Build visible cells.
  const cells: React.ReactNode[] = [];
  for (let row = startRow; row <= endRow; row++) {
    for (let col = 0; col < columns; col++) {
      const index = row * columns + col;
      if (index >= items.length) break;
      const item = items[index];
      const top = row * rowHeight + padding;
      const left = isSingleColumn ? 0 : col * (cellWidth + gap) + padding;

      cells.push(
        <div
          key={getKey(item)}
          role="presentation"
          style={{
            position: "absolute",
            top,
            left,
            width: effectiveCellWidth,
            height: cellHeight,
          }}
        >
          {renderCell(item, index)}
        </div>,
      );
    }
  }

  return (
    <div
      ref={containerRef}
      className={className}
      role={role}
      aria-label={ariaLabel}
      aria-multiselectable={role === "listbox" ? true : undefined}
      style={{ overflow: "auto", position: "relative" }}
      onScroll={syncVisible}
      onClick={onClick}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        {cells}
      </div>
    </div>
  );
}
