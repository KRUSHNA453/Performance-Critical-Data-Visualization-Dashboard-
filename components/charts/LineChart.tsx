"use client";

import { useCallback, useMemo, useRef, type MutableRefObject } from "react";
import { ChartCanvas, type ChartFrame, type DrawResult } from "./ChartCanvas";
import { ChartLegend } from "./ChartLegend";
import { AXIS_FONT } from "@/lib/theme";
import {
  clearCanvas,
  clipToPlot,
  createVertexBuffer,
  drawPolyline,
  drawXAxis,
  drawYAxis,
  linearMap,
  linearTicks,
  niceStep,
  projectSeries,
  timeTicks,
  vertexCapacityFor,
  type PlotRect,
  type VertexBuffer,
} from "@/lib/canvasUtils";
import { projectBuckets } from "@/lib/canvasUtils";
import { AggregationCache } from "@/lib/aggregation";
import { buildSeries, type SeriesDescriptor } from "@/lib/series";
import type { SeriesRingBuffer } from "@/lib/ringBuffer";
import {
  CATEGORIES,
  type AggregationWindow,
  type Category,
  type PerformanceMetrics,
} from "@/lib/types";
import { useChartTheme } from "@/hooks/useChartTheme";
import { useChartInteraction } from "@/hooks/useChartInteraction";
import { useTimeWindow } from "@/hooks/useTimeWindow";
import type { ViewportState } from "@/lib/viewport";

const ALL_CATEGORIES: ReadonlySet<Category> = new Set(CATEGORIES);

export interface LineChartProps {
  buffer: SeriesRingBuffer;
  visibleCategories?: ReadonlySet<Category>;
  /**
   * Shared visible window. Mutated in place by gestures and read by the render
   * loop every frame, so panning never round-trips through React state.
   */
  viewportRef: MutableRefObject<ViewportState>;
  /** Throttled notification for UI that displays the range. */
  onViewportChange?: (viewport: ViewportState) => void;
  /** Whether the window is currently tracking the live edge. */
  live?: boolean;
  /** Bucket size. "raw" plots every sample through min/max decimation. */
  aggregation?: AggregationWindow;
  yDomain?: readonly [number, number];
  forceRedraw?: boolean;
  onMetrics?: (metrics: PerformanceMetrics) => void;
  height?: number;
}

/**
 * Line chart over the streaming ring buffer.
 *
 * Rendering runs on the shared `ChartCanvas` loop at display rate, decoupled
 * from the 100ms data tick: data arrives at 10Hz, the display refreshes at
 * 60Hz, and binding one to the other would either render choppily or
 * re-render React ten times a second. This component supplies only a `draw`
 * callback; the loop, sizing, dirty check and metrics are shared.
 */
export function LineChart({
  buffer,
  visibleCategories = ALL_CATEGORIES,
  viewportRef,
  onViewportChange,
  live = true,
  aggregation = "raw",
  yDomain = [0, 100],
  forceRedraw = false,
  onMetrics,
  height = 360,
}: LineChartProps) {
  const theme = useChartTheme();
  const series = useMemo(
    () => buildSeries(visibleCategories, theme),
    [visibleCategories, theme],
  );

  // Pooled vertex storage, one slot per category, reused across frames.
  const poolRef = useRef<VertexBuffer[]>([]);
  const seriesRef = useRef(series);
  seriesRef.current = series;
  const domainRef = useRef(yDomain);
  domainRef.current = yDomain;
  const aggregationRef = useRef(aggregation);
  aggregationRef.current = aggregation;

  // Owned here so its arrays are allocated once and reused across frames.
  const aggCacheRef = useRef(new AggregationCache(CATEGORIES.length));
  const maskRef = useRef(new Uint8Array(CATEGORIES.length));

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const getExtent = useCallback(
    () => ({ start: buffer.startTime, end: buffer.endTime }),
    [buffer],
  );
  const { latencyRef } = useChartInteraction({
    targetRef: canvasRef,
    viewportRef,
    getExtent,
    onChange: onViewportChange,
  });

  const window = useTimeWindow(buffer, viewportRef);

  const signature = useCallback(
    (frame: ChartFrame): string => {
      const w = window();
      if (w === null) return "empty";
      const d = domainRef.current;
      // Span belongs in the key as well as start: a zoom that keeps the right
      // edge fixed changes only the span, and would otherwise not redraw.
      return `${buffer.revision}|${w.start}|${w.span}|${frame.width}|${frame.height}|${frame.theme.mode}|${seriesRef.current.length}|${d[0]}|${d[1]}|${aggregationRef.current}`;
    },
    [buffer, window],
  );

  const draw = useCallback(
    (frame: ChartFrame): DrawResult => {
      const { ctx, rect, theme: t, axisTheme } = frame;
      const w = window();
      clearCanvas(ctx, frame.width, frame.height, t.surface);
      if (w === null) return { rendered: 0, examined: 0 };

      const domain = domainRef.current;
      const xMap = linearMap(w.start, w.end, rect.x, rect.x + rect.width);
      // Inverted: the domain minimum sits at the bottom of the plot.
      const yMap = linearMap(
        domain[0],
        domain[1],
        rect.y + rect.height,
        rect.y,
      );

      const yStep = niceStep(domain[1] - domain[0], 5);
      drawYAxis(
        ctx,
        rect,
        linearTicks(domain[0], domain[1], 5),
        yMap,
        yStep,
        axisTheme,
      );
      drawXAxis(
        ctx,
        rect,
        timeTicks(w.start, w.end, Math.max(2, Math.floor(rect.width / 90))),
        xMap,
        w.span,
        axisTheme,
      );

      // Grow the pool only when the plot got wider.
      const capacity = vertexCapacityFor(rect.width);
      if (
        poolRef.current.length !== CATEGORIES.length ||
        (poolRef.current[0]?.xs.length ?? 0) < capacity
      ) {
        poolRef.current = CATEGORIES.map(() => createVertexBuffer(capacity));
      }
      const pool = poolRef.current;

      // Holes for hidden series let the projection skip them without a
      // per-point set lookup.
      const active: Array<VertexBuffer | undefined> = new Array(
        CATEGORIES.length,
      );
      for (const s of seriesRef.current) active[s.id] = pool[s.id];

      const mask = maskRef.current;
      mask.fill(0);
      for (const s of seriesRef.current) mask[s.id] = 1;

      const aggregated = aggCacheRef.current.compute(
        buffer,
        aggregationRef.current,
        w.start,
        w.end,
        mask,
        CATEGORIES.length,
      );

      let examined: number;
      if (aggregated === null) {
        // Raw path: every sample, folded to two vertices per pixel column.
        examined = projectSeries(
          buffer,
          CATEGORIES.length,
          buffer.lowerBound(w.start),
          buffer.length,
          xMap,
          yMap,
          active as VertexBuffer[],
        );
      } else {
        // Aggregated path: one vertex per non-empty bucket.
        projectBuckets(
          aggregated.set,
          CATEGORIES.length,
          aggregated.bucketCount,
          aggregated.rangeStart,
          aggregated.bucketMs,
          xMap,
          yMap,
          active,
        );
        examined = aggregated.examined;
      }

      clipToPlot(ctx, rect);
      let vertices = 0;
      for (const s of seriesRef.current) {
        const vb = pool[s.id];
        if (vb === undefined) continue;
        drawPolyline(ctx, vb, s.color, 2);
        vertices += vb.count;
      }
      ctx.restore();

      drawDirectLabels(ctx, seriesRef.current, pool, rect);
      return { rendered: vertices, examined };
    },
    [buffer, window],
  );

  return (
    <ChartCanvas
      height={height}
      ariaLabel={`Line chart of ${series.map((s) => s.label).join(", ")} over time`}
      signature={signature}
      draw={draw}
      forceRedraw={forceRedraw}
      active={live}
      onMetrics={onMetrics}
      canvasRefOut={canvasRef}
      interactionLatencyRef={latencyRef}
    >
      <ChartLegend series={series} mark="line" />
    </ChartCanvas>
  );
}

/**
 * Series labels at the live edge, drawn in the right-hand gutter.
 *
 * Not decoration: aqua and yellow both fall below 3:1 contrast on the light
 * surface, so identity cannot rest on line colour alone. Labels are nudged
 * apart when they would collide, then the stack is pulled back inside the plot.
 */
function drawDirectLabels(
  ctx: CanvasRenderingContext2D,
  series: SeriesDescriptor[],
  pool: VertexBuffer[],
  rect: PlotRect,
): void {
  const entries: Array<{ y: number; color: string; text: string }> = [];
  for (const s of series) {
    const vb = pool[s.id];
    if (vb === undefined || vb.count === 0) continue;
    entries.push({ y: vb.ys[vb.count - 1]!, color: s.color, text: s.label });
  }
  if (entries.length === 0) return;

  entries.sort((a, b) => a.y - b.y);
  const minGap = 13;
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]!;
    const cur = entries[i]!;
    if (cur.y - prev.y < minGap) cur.y = prev.y + minGap;
  }
  const bottom = entries[entries.length - 1]!.y - (rect.y + rect.height);
  if (bottom > 0) for (const e of entries) e.y -= bottom;
  const top = rect.y - entries[0]!.y;
  if (top > 0) for (const e of entries) e.y += top;

  ctx.save();
  ctx.font = AXIS_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const entry of entries) {
    ctx.fillStyle = entry.color;
    ctx.fillText(entry.text, rect.x + rect.width + 6, entry.y);
  }
  ctx.restore();
}
