"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualization } from "@/hooks/useVirtualization";
import type { SeriesRingBuffer } from "@/lib/ringBuffer";
import { CATEGORY_LABELS } from "@/lib/theme";
import { useChartTheme } from "@/hooks/useChartTheme";
import { CATEGORIES, type Category } from "@/lib/types";

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 32;

/**
 * How often the table re-reads the buffer.
 *
 * Data arrives at 10Hz but a table refreshing ten times a second is unreadable
 * and pointlessly expensive. 4Hz still feels live and cuts the React work by
 * more than half.
 */
const REFRESH_MS = 250;

const ALL_CATEGORIES: ReadonlySet<Category> = new Set(CATEGORIES);

export interface DataTableProps {
  buffer: SeriesRingBuffer;
  visibleCategories?: ReadonlySet<Category>;
  height?: number;
}

/** Build a newest-first list of logical indices passing the filter. */
function buildIndexMap(
  buffer: SeriesRingBuffer,
  mask: Uint8Array,
  out: Int32Array,
): number {
  let n = 0;
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (mask[buffer.categoryIdAt(i)] === 1) out[n++] = i;
  }
  return n;
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const mmm = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${mmm}`;
}

/**
 * Virtualized table of raw samples, newest first.
 *
 * Hand-rolled windowing (see `useVirtualization`) — no virtualization library.
 * Only the rows intersecting the viewport are in the DOM; a spacer of the full
 * list height keeps the scrollbar proportional.
 *
 * Two details make it usable against a live stream:
 *
 * - **Scroll anchoring.** New samples land at display index 0, which would push
 *   whatever the user is reading downward four times a second. When scrolled
 *   away from the top, the container is shifted by exactly the number of rows
 *   prepended, so the rows under the cursor stay put.
 *
 *   Known limitation: the list is only rebuilt every `REFRESH_MS`, so at the
 *   moment scrolling starts there can be up to one refresh interval of samples
 *   (~10 rows) that have arrived but are not yet rendered. The first
 *   compensation absorbs that backlog, which shifts the view once by up to
 *   that much. Measured behaviour is a single settle of ~8 rows followed by
 *   exact anchoring for as long as the user stays scrolled. Removing it would
 *   mean rebuilding at the full 10Hz tick rate, which costs more than the
 *   artifact is worth.
 * - **Filtering via an index map.** Rows are addressed through a pooled
 *   Int32Array of logical indices rather than by filtering an array, so a
 *   category toggle costs one O(n) rebuild at 4Hz instead of allocating a new
 *   filtered array on every frame.
 */
export function DataTable({
  buffer,
  visibleCategories = ALL_CATEGORIES,
  height = 340,
}: DataTableProps) {
  const theme = useChartTheme();

  // Sized to capacity once; never reallocated as the window slides.
  const indexMapRef = useRef<Int32Array>(new Int32Array(buffer.capacity));
  const maskRef = useRef<Uint8Array>(new Uint8Array(CATEGORIES.length));
  const lastTotalPushedRef = useRef(0);
  const lastRevisionRef = useRef(-1);
  /** Rows prepended since the last commit, awaiting scroll compensation. */
  const pendingShiftRef = useRef(0);

  const [rowCount, setRowCount] = useState(0);
  // Bumped whenever the map is rebuilt, to re-render rows without copying data.
  const [version, setVersion] = useState(0);

  const mask = useMemo(() => {
    const next = new Uint8Array(CATEGORIES.length);
    for (let i = 0; i < CATEGORIES.length; i++) {
      if (visibleCategories.has(CATEGORIES[i]!)) next[i] = 1;
    }
    return next;
  }, [visibleCategories]);
  maskRef.current = mask;

  const virtual = useVirtualization<HTMLDivElement>({
    itemCount: rowCount,
    itemHeight: ROW_HEIGHT,
  });
  const { shiftByRows, isAtTop, containerRef } = virtual;

  // Registered once, so the interval reads the latest through refs.
  const shiftRef = useRef(shiftByRows);
  shiftRef.current = shiftByRows;

  useEffect(() => {
    if (indexMapRef.current.length < buffer.capacity) {
      indexMapRef.current = new Int32Array(buffer.capacity);
    }

    const refresh = (force: boolean) => {
      if (!force && buffer.revision === lastRevisionRef.current) return;

      // Count how many newly pushed samples pass the filter. Those land at the
      // top of a newest-first list, so they are exactly what the scroll
      // position has to compensate for.
      const pushedDelta = buffer.totalPushed - lastTotalPushedRef.current;
      let prepended = 0;
      if (pushedDelta > 0 && lastTotalPushedRef.current > 0) {
        const from = Math.max(0, buffer.length - pushedDelta);
        for (let i = from; i < buffer.length; i++) {
          if (maskRef.current[buffer.categoryIdAt(i)] === 1) prepended++;
        }
      }

      lastRevisionRef.current = buffer.revision;
      lastTotalPushedRef.current = buffer.totalPushed;

      const n = buildIndexMap(buffer, maskRef.current, indexMapRef.current);
      setRowCount(n);
      setVersion((v) => v + 1);

      // Read scroll position from the DOM, not from React state. State lags by
      // a render, which leaves a window right after the user starts scrolling
      // where compensation is skipped for one refresh — and a skipped refresh
      // is a permanent drift, since nothing later corrects it.
      const el = containerRef.current;
      const atTop = el === null || el.scrollTop <= 1;

      // Deferred to the layout effect below rather than applied here. Moving
      // scrollTop now would take effect a frame before React commits the new
      // rows, so for one frame the old rows would sit at the new offset and
      // the content under the cursor would visibly jump.
      if (!atTop && prepended > 0) {
        pendingShiftRef.current += prepended;
      }
    };

    refresh(true);
    const timer = setInterval(() => refresh(false), REFRESH_MS);
    return () => clearInterval(timer);
  }, [buffer, mask, containerRef]);

  // Runs after the new rows are in the DOM but before paint, so the row
  // content and the scroll position change together in a single frame.
  useLayoutEffect(() => {
    const pending = pendingShiftRef.current;
    if (pending === 0) return;
    pendingShiftRef.current = 0;
    shiftRef.current(pending);
  }, [version]);

  const indexMap = indexMapRef.current;
  const rows: React.ReactNode[] = [];
  for (let d = virtual.startIndex; d < virtual.endIndex; d++) {
    const logical = indexMap[d];
    if (logical === undefined || logical < 0 || logical >= buffer.length) break;

    const point = buffer.pointAt(logical);
    const category = point.category as Category;
    const deviation = point.metadata?.deviation;
    const isAnomaly = point.metadata?.anomaly === true;

    rows.push(
      <div
        key={`${point.timestamp}-${category}`}
        role="row"
        aria-rowindex={d + 2} // 1 is the header row
        style={{
          position: "absolute",
          top: (d - virtual.startIndex) * ROW_HEIGHT,
          left: 0,
          right: 0,
          height: ROW_HEIGHT,
          display: "grid",
          gridTemplateColumns: "auto 96px 1fr 80px 132px",
          alignItems: "center",
          gap: 8,
          padding: "0 12px",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
          whiteSpace: "nowrap",
        }}
      >
        <span
          role="gridcell"
          className="mono"
          style={{
            color: "var(--text-muted)",
            width: 56,
            textAlign: "right",
          }}
        >
          {d + 1}
        </span>
        <span role="gridcell" className="mono">
          {formatClock(point.timestamp)}
        </span>
        <span
          role="gridcell"
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          <span
            aria-hidden
            style={{
              width: 9,
              height: 9,
              borderRadius: 2,
              background: theme.series[category],
              flex: "0 0 auto",
            }}
          />
          {CATEGORY_LABELS[category]}
        </span>
        <span role="gridcell" className="mono" style={{ textAlign: "right" }}>
          {point.value.toFixed(2)}
        </span>
        <span
          role="gridcell"
          className="mono"
          style={{
            color: isAnomaly ? "#ec835a" : "var(--text-muted)",
            fontSize: 11,
          }}
        >
          {/* Icon plus the word "spike" — a status colour never carries
              meaning on its own. */}
          {isAnomaly && typeof deviation === "number"
            ? `${deviation >= 0 ? "▲" : "▼"} spike ${deviation > 0 ? "+" : ""}${deviation.toFixed(1)}`
            : ""}
        </span>
      </div>,
    );
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
          {rowCount.toLocaleString("en-US")} rows ·{" "}
          <span style={{ color: "var(--text-secondary)" }}>
            {rows.length} in DOM
          </span>
        </div>
        {!isAtTop && (
          <button
            type="button"
            onClick={virtual.scrollToTop}
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              padding: "4px 10px",
              fontSize: 12,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            Jump to live ↑
          </button>
        )}
      </div>

      <div
        role="grid"
        aria-label="Raw data points, newest first"
        aria-rowcount={rowCount + 1}
        style={{
          border: "1px solid var(--border)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        <div
          role="row"
          aria-rowindex={1}
          style={{
            display: "grid",
            gridTemplateColumns: "auto 96px 1fr 80px 132px",
            alignItems: "center",
            gap: 8,
            padding: "0 12px",
            height: HEADER_HEIGHT,
            borderBottom: "1px solid var(--border)",
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: "var(--text-muted)",
            background: "var(--surface)",
          }}
        >
          <span role="columnheader" style={{ width: 56, textAlign: "right" }}>
            #
          </span>
          <span role="columnheader">Time</span>
          <span role="columnheader">Series</span>
          <span role="columnheader" style={{ textAlign: "right" }}>
            Value
          </span>
          <span role="columnheader">Note</span>
        </div>

        <div
          ref={virtual.containerRef}
          style={{
            height,
            overflowY: "auto",
            overflowX: "hidden",
            position: "relative",
            // Tells the browser this subtree scrolls independently, so it can
            // skip laying out the rest of the page on every scroll frame.
            contain: "strict",
          }}
        >
          {/* Spacer carries the full list height so the scrollbar is honest. */}
          <div style={{ height: virtual.totalHeight, position: "relative" }}>
            <div
              style={{
                position: "absolute",
                top: virtual.offsetY,
                left: 0,
                right: 0,
              }}
              data-version={version}
            >
              {rows}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
