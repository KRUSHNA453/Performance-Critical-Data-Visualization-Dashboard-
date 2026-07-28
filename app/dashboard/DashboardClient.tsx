"use client";

import {
  useCallback,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { BarChart } from "@/components/charts/BarChart";
import { LineChart } from "@/components/charts/LineChart";
import { ScatterPlot } from "@/components/charts/ScatterPlot";
import { AggregationControl } from "@/components/controls/AggregationControl";
import { FilterPanel } from "@/components/controls/FilterPanel";
import { TimeRangeSelector } from "@/components/controls/TimeRangeSelector";
import { DataTable } from "@/components/ui/DataTable";
import { MetricsPanel } from "@/components/ui/MetricsPanel";
import { PerformanceMonitor } from "@/components/ui/PerformanceMonitor";
import { useDataStream } from "@/hooks/useDataStream";
import {
  CATEGORIES,
  type AggregationWindow,
  type Category,
  type ChartType,
  type PerformanceMetrics,
} from "@/lib/types";
import {
  LIVE_VIEWPORT,
  resolveWindow,
  type ViewportState,
} from "@/lib/viewport";
import { datasetSize, type SerializedDataset } from "@/lib/serialization";

const CHART_TYPES: Array<{ id: ChartType; label: string }> = [
  { id: "line", label: "Line" },
  { id: "bar", label: "Bar" },
  { id: "scatter", label: "Scatter" },
];

export interface DashboardClientProps {
  /** Backfill generated on the server and hydrated into the ring buffer. */
  initialDataset: SerializedDataset;
}

/**
 * The interactive half of the dashboard.
 *
 * Everything below this boundary needs the browser: canvas, requestAnimationFrame,
 * pointer and wheel listeners, ResizeObserver, and mutable refs that are read
 * 60 times a second. None of it can run on the server, so the boundary is drawn
 * exactly here — as deep as possible, but no deeper.
 */
export default function DashboardClient({
  initialDataset,
}: DashboardClientProps) {
  const { buffer, isStreaming, toggle, reset, getStats } = useDataStream({
    capacity: Math.max(10_000, datasetSize(initialDataset)),
    initialDataset,
  });

  const [visible, setVisible] = useState<ReadonlySet<Category>>(
    () => new Set(CATEGORIES),
  );
  const [stress, setStress] = useState(false);
  const [chartType, setChartType] = useState<ChartType>("line");
  const [aggregation, setAggregation] = useState<AggregationWindow>("raw");
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);

  /**
   * Swapping chart type unmounts a canvas and mounts another, tearing down one
   * rAF loop and starting another. It is the single heaviest state change here,
   * and the one worth marking interruptible.
   *
   * Two pieces of state rather than one, deliberately. `selectedTab` is urgent
   * and drives the highlight, so the button responds to the click on the next
   * frame. `chartType` is transitioned and drives the mount, so the expensive
   * swap happens at lower priority and can be interrupted by another click.
   * Driving both from one state would defer the highlight too, and the tab
   * would appear dead for as long as the swap took — the exact unresponsiveness
   * the transition was meant to prevent.
   */
  const [isSwitchingChart, startChartTransition] = useTransition();
  const [selectedTab, setSelectedTab] = useState<ChartType>("line");
  const selectChartType = useCallback(
    (next: ChartType) => {
      setSelectedTab(next);
      startChartTransition(() => setChartType(next));
    },
    [startChartTransition],
  );

  /**
   * The charts respond to a filter change almost for free — hidden series are
   * skipped by a mask in the projection loop. The table is the expensive
   * consumer: it rebuilds a 10,000-entry index map and reconciles rows.
   *
   * So the two are deliberately split rather than both being deferred. Charts
   * and the checkboxes themselves read the urgent value and update on the next
   * frame; the table reads the deferred one and is allowed to lag, so rapid
   * toggling never queues up index rebuilds behind the input.
   */
  const deferredVisible = useDeferredValue(visible);
  const tableIsStale = deferredVisible !== visible;

  /**
   * The viewport lives in a ref because the render loop reads it every frame
   * and gestures mutate it directly. `viewportUi` is a throttled mirror, used
   * only by the DOM controls that display the range.
   */
  const viewportRef = useRef<ViewportState>(LIVE_VIEWPORT);
  const [viewportUi, setViewportUi] = useState<ViewportState>(LIVE_VIEWPORT);

  const handleViewportChange = useCallback((next: ViewportState) => {
    setViewportUi(next);
  }, []);

  /** Used by the controls, which must write the ref as well as the mirror. */
  const applyViewport = useCallback((next: ViewportState) => {
    viewportRef.current = next;
    setViewportUi(next);
  }, []);

  const handleMetrics = useCallback((next: PerformanceMetrics) => {
    setMetrics(next);
  }, []);

  const stats = getStats();

  // Resolved here for the readout only; the charts resolve their own window
  // per frame, since a live window's right edge is the clock.
  const timeWindow = resolveWindow(
    buffer.startTime,
    buffer.endTime,
    viewportUi,
    Date.now(),
  );
  const live = timeWindow?.live ?? true;

  /**
   * Memoised so the charts' `React.memo` shallow compare actually holds. These
   * values change only on real user input; without this they would be rebuilt
   * on every metrics tick and defeat the memo.
   */
  const chartProps = useMemo(
    () => ({
      buffer,
      visibleCategories: visible,
      viewportRef,
      onViewportChange: handleViewportChange,
      live,
      aggregation,
      forceRedraw: stress,
      onMetrics: handleMetrics,
      height: 360,
    }),
    [
      buffer,
      visible,
      handleViewportChange,
      live,
      aggregation,
      stress,
      handleMetrics,
    ],
  );

  return (
    <main
      style={{
        maxWidth: 1100,
        margin: "0 auto",
        padding: "24px 16px 64px",
        display: "grid",
        gap: 16,
      }}
    >
      <header>
        <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>
          {stats.size.toLocaleString("en-US")} points, live
        </h1>
        <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 13 }}>
          Canvas 2D, no chart libraries. Drag to pan, scroll or pinch to zoom,
          double-click to return to live.
        </p>
      </header>

      <section className="panel" style={{ display: "grid", gap: 12 }}>
        <TimeRangeSelector
          viewport={viewportUi}
          window={timeWindow}
          onChange={applyViewport}
        />
        <AggregationControl
          value={aggregation}
          onChange={setAggregation}
          spanMs={timeWindow?.span ?? 0}
        />
        <FilterPanel
          visible={visible}
          onChange={setVisible}
          isStreaming={isStreaming}
          onToggleStream={toggle}
          onReset={reset}
        />
      </section>

      <div
        role="tablist"
        aria-label="Chart type"
        style={{ display: "flex", gap: 8 }}
      >
        {CHART_TYPES.map((type) => {
          // Highlight follows the urgent state, not the transitioned one.
          const selected = selectedTab === type.id;
          return (
            <button
              key={type.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => selectChartType(type.id)}
              style={{
                ...buttonStyle,
                borderColor: selected ? "var(--series-cpu)" : "var(--border)",
                color: selected ? "var(--series-cpu)" : "var(--text)",
                fontWeight: selected ? 600 : 400,
              }}
            >
              {type.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setStress((s) => !s)}
          style={{
            ...buttonStyle,
            marginLeft: "auto",
            borderColor: stress ? "#fab219" : "var(--border)",
            color: stress ? "#fab219" : "var(--text)",
          }}
        >
          {stress ? "Stress mode: ON" : "Stress mode: off"}
        </button>
      </div>

      <section
        className="panel"
        // Dim rather than blank during the swap: replacing a rendered chart
        // with a spinner loses more information than the wait costs.
        style={{
          opacity: isSwitchingChart ? 0.6 : 1,
          transition: "opacity 120ms ease",
        }}
        aria-busy={isSwitchingChart}
      >
        {chartType === "line" && <LineChart {...chartProps} />}
        {chartType === "bar" && <BarChart {...chartProps} />}
        {chartType === "scatter" && <ScatterPlot {...chartProps} />}
      </section>

      <section className="panel">
        <MetricsPanel
          metrics={metrics}
          bufferSize={stats.size}
          bufferBytes={stats.bufferBytes}
        />
      </section>

      <section className="panel">
        <h2
          style={{
            fontSize: 14,
            margin: "0 0 10px",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          Raw data points
          {tableIsStale && (
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              updating…
            </span>
          )}
        </h2>
        <div
          style={{
            opacity: tableIsStale ? 0.6 : 1,
            transition: "opacity 120ms ease",
          }}
        >
          <DataTable
            buffer={buffer}
            visibleCategories={deferredVisible}
            height={340}
          />
        </div>
      </section>

      <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
        Stress mode forces a redraw every frame regardless of whether anything
        changed — use it when profiling, so the numbers reflect sustained
        worst-case render load rather than the idle path.
      </p>

      <PerformanceMonitor drawMetrics={metrics} />
    </main>
  );
}

const buttonStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  padding: "6px 12px",
  fontSize: 13,
  fontFamily: "inherit",
  cursor: "pointer",
};
