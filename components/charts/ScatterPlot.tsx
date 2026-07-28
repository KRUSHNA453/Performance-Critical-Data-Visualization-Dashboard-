"use client";

import { memo, useCallback, useMemo, useRef, type MutableRefObject } from "react";
import { ChartCanvas, type ChartFrame, type DrawResult } from "./ChartCanvas";
import { ChartLegend } from "./ChartLegend";
import {
  beginStampPass,
  clearCanvas,
  clipToPlot,
  createStampGrid,
  drawPointsBatched,
  drawXAxis,
  drawYAxis,
  ensureStampGrid,
  linearMap,
  linearTicks,
  niceStep,
  timeTicks,
  createVertexBuffer,
  projectBuckets,
  vertexCapacityFor,
  type VertexBuffer,
} from "@/lib/canvasUtils";
import { AggregationCache } from "@/lib/aggregation";
import { SCATTER_SERIES_LIMIT, buildSeries } from "@/lib/series";
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

/** Mark edge length in CSS pixels. */
const MARK_SIZE = 3;

/**
 * De-duplication cell size. Slightly smaller than the mark so marks that would
 * visually merge are dropped, but genuinely distinct positions survive.
 */
const DEDUP_CELL = 2;

export interface ScatterPlotProps {
  buffer: SeriesRingBuffer;
  visibleCategories?: ReadonlySet<Category>;
  viewportRef: MutableRefObject<ViewportState>;
  onViewportChange?: (viewport: ViewportState) => void;
  live?: boolean;
  /** Bucket size. "raw" draws one mark per sample. */
  aggregation?: AggregationWindow;
  yDomain?: readonly [number, number];
  forceRedraw?: boolean;
  onMetrics?: (metrics: PerformanceMetrics) => void;
  height?: number;
}

/**
 * Scatter plot of individual samples over time.
 *
 * Two things make a dense scatter affordable. Marks are de-duplicated against
 * an occupancy grid, so samples landing on already-covered pixels cost nothing
 * to draw; and every surviving mark is batched into one path per series and
 * filled once, rather than issuing a rasteriser call per point.
 *
 * The series cap is a correctness constraint, not a performance one: scatter
 * marks can sit beside any other mark, so the palette is judged on all colour
 * pairs, and the fourth slot fails that bar against the second. See
 * `SCATTER_SERIES_LIMIT`.
 */
function ScatterPlotImpl({
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
}: ScatterPlotProps) {
  const theme = useChartTheme();

  const requested = useMemo(
    () => buildSeries(visibleCategories, theme),
    [visibleCategories, theme],
  );
  const series = useMemo(
    () => requested.slice(0, SCATTER_SERIES_LIMIT),
    [requested],
  );
  const dropped = requested.length - series.length;

  const seriesRef = useRef(series);
  seriesRef.current = series;
  const domainRef = useRef(yDomain);
  domainRef.current = yDomain;
  const aggregationRef = useRef(aggregation);
  aggregationRef.current = aggregation;

  const gridRef = useRef(createStampGrid(1, 1, DEDUP_CELL));
  const aggCacheRef = useRef(new AggregationCache(CATEGORIES.length));
  const maskRef = useRef(new Uint8Array(CATEGORIES.length));
  // Only used on the aggregated path, where marks come from bucket means.
  const poolRef = useRef<VertexBuffer[]>([]);

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

      gridRef.current = ensureStampGrid(
        gridRef.current,
        rect.width,
        rect.height,
        DEDUP_CELL,
      );
      const grid = gridRef.current;

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

      clipToPlot(ctx, rect);
      let marks = 0;
      let examined: number;

      if (aggregated === null) {
        const startIndex = buffer.lowerBound(w.start);
        examined = buffer.length - startIndex;
        for (const descriptor of seriesRef.current) {
          // A fresh pass per series: two series may legitimately occupy the
          // same pixel, and dropping the second would hide a real overlap.
          beginStampPass(grid);
          marks += drawPointsBatched(
            ctx,
            buffer,
            descriptor.id,
            startIndex,
            buffer.length,
            xMap,
            yMap,
            rect,
            descriptor.color,
            MARK_SIZE,
            grid,
          );
        }
      } else {
        // One mark per bucket. De-duplication is pointless here — buckets are
        // already distinct positions — so the marks are drawn slightly larger
        // to read as deliberate summary points rather than sparse samples.
        examined = aggregated.examined;
        const capacity = vertexCapacityFor(rect.width);
        if (
          poolRef.current.length !== CATEGORIES.length ||
          (poolRef.current[0]?.xs.length ?? 0) < capacity
        ) {
          poolRef.current = CATEGORIES.map(() => createVertexBuffer(capacity));
        }
        const pool = poolRef.current;
        const active: Array<VertexBuffer | undefined> = new Array(
          CATEGORIES.length,
        );
        for (const s of seriesRef.current) active[s.id] = pool[s.id];

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

        const size = MARK_SIZE * 2;
        const half = size / 2;
        for (const descriptor of seriesRef.current) {
          const vb = pool[descriptor.id];
          if (vb === undefined || vb.count === 0) continue;
          ctx.beginPath();
          for (let i = 0; i < vb.count; i++) {
            ctx.rect(vb.xs[i]! - half, vb.ys[i]! - half, size, size);
          }
          ctx.fillStyle = descriptor.color;
          ctx.fill();
          marks += vb.count;
        }
      }
      ctx.restore();

      return { rendered: marks, examined };
    },
    [buffer, window],
  );

  return (
    <ChartCanvas
      height={height}
      ariaLabel={`Scatter plot of ${series
        .map((s) => s.label)
        .join(", ")} samples over time`}
      signature={signature}
      draw={draw}
      forceRedraw={forceRedraw}
      active={live}
      onMetrics={onMetrics}
      canvasRefOut={canvasRef}
      interactionLatencyRef={latencyRef}
    >
      <ChartLegend
        series={series}
        mark="block"
        note={
          dropped > 0
            ? `showing first ${SCATTER_SERIES_LIMIT} series — scatter marks need all-pairs colour separation, which the 4th slot fails`
            : undefined
        }
      />
    </ChartCanvas>
  );
}

/** Skips the dashboard's ~2Hz metrics re-renders; see LineChart. */
export const ScatterPlot = memo(ScatterPlotImpl);
