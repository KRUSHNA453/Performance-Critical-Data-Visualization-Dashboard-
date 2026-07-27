"use client";

import { useCallback, useRef, useState } from "react";
import { BarChart } from "@/components/charts/BarChart";
import { LineChart } from "@/components/charts/LineChart";
import { ScatterPlot } from "@/components/charts/ScatterPlot";
import { FilterPanel } from "@/components/controls/FilterPanel";
import { TimeRangeSelector } from "@/components/controls/TimeRangeSelector";
import { DataTable } from "@/components/ui/DataTable";
import { MetricsPanel } from "@/components/ui/MetricsPanel";
import { useDataStream } from "@/hooks/useDataStream";
import {
  CATEGORIES,
  type Category,
  type ChartType,
  type PerformanceMetrics,
} from "@/lib/types";
import {
  LIVE_VIEWPORT,
  resolveWindow,
  type ViewportState,
} from "@/lib/viewport";

const CHART_TYPES: Array<{ id: ChartType; label: string }> = [
  { id: "line", label: "Line" },
  { id: "bar", label: "Bar" },
  { id: "scatter", label: "Scatter" },
];

export default function DashboardPage() {
  const { buffer, isStreaming, toggle, reset, getStats } = useDataStream({
    capacity: 10_000,
  });

  const [visible, setVisible] = useState<ReadonlySet<Category>>(
    () => new Set(CATEGORIES),
  );
  const [stress, setStress] = useState(false);
  const [chartType, setChartType] = useState<ChartType>("line");
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);

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

  const chartProps = {
    buffer,
    visibleCategories: visible,
    viewportRef,
    onViewportChange: handleViewportChange,
    live,
    forceRedraw: stress,
    onMetrics: handleMetrics,
    height: 360,
  };

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
          const selected = chartType === type.id;
          return (
            <button
              key={type.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setChartType(type.id)}
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

      <section className="panel">
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
        <h2 style={{ fontSize: 14, margin: "0 0 10px" }}>Raw data points</h2>
        <DataTable buffer={buffer} visibleCategories={visible} height={340} />
      </section>

      <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
        Stress mode forces a redraw every frame regardless of whether anything
        changed — use it when profiling, so the numbers reflect sustained
        worst-case render load rather than the idle path.
      </p>
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
