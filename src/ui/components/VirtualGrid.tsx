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
}: VirtualGridProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // Measure container width with ResizeObserver.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerWidth(entry.contentRect.width);
      setViewportHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  // Column count: fixed, or auto-fit from container width.
  const columns =
    fixedColumns ??
    Math.max(1, Math.floor((containerWidth - 2 * padding + gap) / (cellWidth + gap)));

  const isSingleColumn = columns === 1;
  const effectiveCellWidth = isSingleColumn ? containerWidth : cellWidth;

  // Publish the column count so row-wise keyboard nav (↑/↓) knows the stride.
  useEffect(() => {
    onColumnsChange?.(columns);
  }, [columns, onColumnsChange]);

  const totalRows = Math.ceil(items.length / columns);
  const rowHeight = cellHeight + gap;
  const totalHeight = totalRows > 0 ? totalRows * rowHeight - gap + 2 * padding : 0;

  // Visible row range (clamped with overscan buffer).
  const startRow = Math.max(0, Math.floor((scrollTop - padding) / rowHeight) - overscan);
  const endRow = Math.min(
    totalRows - 1,
    Math.floor((scrollTop + viewportHeight - padding) / rowHeight) + overscan,
  );

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
      style={{ overflow: "auto", position: "relative" }}
      onScroll={handleScroll}
      onClick={onClick}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        {cells}
      </div>
    </div>
  );
}
