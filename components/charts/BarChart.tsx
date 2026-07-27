"use client";

import { useCallback, useMemo, useRef } from "react";
import { ChartCanvas, type ChartFrame, type DrawResult } from "./ChartCanvas";
import { ChartLegend } from "./ChartLegend";
import {
  addBarToPath,
  aggregateBuckets,
  bucketMean,
  clearCanvas,
  clipToPlot,
  createBucketSet,
  drawXAxis,
  drawYAxis,
  ensureBucketSet,
  linearMap,
  linearTicks,
  niceStep,
  niceTimeStep,
  timeTicks,
} from "@/lib/canvasUtils";
import { buildSeries, seriesMask } from "@/lib/series";
import type { SeriesRingBuffer } from "@/lib/ringBuffer";
import {
  CATEGORIES,
  type Category,
  type PerformanceMetrics,
} from "@/lib/types";
import { useChartTheme } from "@/hooks/useChartTheme";

const ALL_CATEGORIES: ReadonlySet<Category> = new Set(CATEGORIES);

/** Target on-screen width of one time bucket's bar group, in CSS pixels. */
const TARGET_GROUP_PX = 46;

/** Surface gap between adjacent bars, per the mark spec. */
const BAR_GAP_PX = 2;

export interface BarChartProps {
  buffer: SeriesRingBuffer;
  visibleCategories?: ReadonlySet<Category>;
  following?: boolean;
  yDomain?: readonly [number, number];
  forceRedraw?: boolean;
  onMetrics?: (metrics: PerformanceMetrics) => void;
  height?: number;
}

/**
 * Grouped bar chart of per-bucket means.
 *
 * Bars summarise rather than plot every sample — 10,000 individual bars would
 * be visual noise — so the buffer is folded into time buckets in a single pass
 * and one bar is drawn per series per bucket. Bucket boundaries snap to
 * absolute multiples of the bucket width, so bars stay put as the window
 * scrolls instead of sliding continuously underneath the axis.
 *
 * Shares the render loop, sizing and metrics with every other chart via
 * `ChartCanvas`; only the draw callback differs.
 */
export function BarChart({
  buffer,
  visibleCategories = ALL_CATEGORIES,
  following = true,
  yDomain = [0, 100],
  forceRedraw = false,
  onMetrics,
  height = 360,
}: BarChartProps) {
  const theme = useChartTheme();
  const series = useMemo(
    () => buildSeries(visibleCategories, theme),
    [visibleCategories, theme],
  );

  const seriesRef = useRef(series);
  seriesRef.current = series;
  const followingRef = useRef(following);
  followingRef.current = following;
  const domainRef = useRef(yDomain);
  domainRef.current = yDomain;

  // Pooled across frames; grown only when the bucket grid gets bigger.
  const bucketsRef = useRef(createBucketSet(CATEGORIES.length, 64));
  const maskRef = useRef(new Uint8Array(CATEGORIES.length));

  const window = useCallback((): {
    start: number;
    end: number;
    span: number;
  } | null => {
    const end = buffer.endTime;
    const start = buffer.startTime;
    if (end === null || start === null) return null;
    const span = Math.max(1000, end - start);
    const right = followingRef.current ? Date.now() : end;
    return { start: right - span, end: right, span };
  }, [buffer]);

  const signature = useCallback(
    (frame: ChartFrame): string => {
      const w = window();
      if (w === null) return "empty";
      // Bucket boundaries are absolute, so the frame only changes when the
      // window crosses one — quantising the key here means a paused-but-
      // following chart redraws when it must, not every frame.
      const bucketMs = niceTimeStep(
        w.span,
        Math.max(2, Math.floor(frame.rect.width / TARGET_GROUP_PX)),
      );
      const d = domainRef.current;
      return `${buffer.revision}|${Math.floor(w.end / bucketMs)}|${frame.width}|${frame.height}|${frame.theme.mode}|${seriesRef.current.length}|${d[0]}|${d[1]}`;
    },
    [buffer, window],
  );

  const draw = useCallback(
    (frame: ChartFrame): DrawResult => {
      const { ctx, rect, theme: t, axisTheme } = frame;
      const w = window();
      clearCanvas(ctx, frame.width, frame.height, t.surface);
      if (w === null) return { rendered: 0, examined: 0 };

      const visible = seriesRef.current;
      const domain = domainRef.current;

      const targetBuckets = Math.max(
        2,
        Math.floor(rect.width / TARGET_GROUP_PX),
      );
      const bucketMs = niceTimeStep(w.span, targetBuckets);
      // Snap to absolute time so buckets are stable as the window scrolls.
      const rangeStart = Math.floor(w.start / bucketMs) * bucketMs;
      // floor + 1, not ceil: buckets are half-open, so a sample landing exactly
      // on the right edge belongs to bucket floor((end - start) / width) and
      // needs a bucket to exist at that index. `ceil` silently drops it
      // whenever the span is an exact multiple of the bucket width.
      const bucketCount = Math.max(
        1,
        Math.floor((w.end - rangeStart) / bucketMs) + 1,
      );

      const xMap = linearMap(
        rangeStart,
        rangeStart + bucketCount * bucketMs,
        rect.x,
        rect.x + rect.width,
      );
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

      bucketsRef.current = ensureBucketSet(
        bucketsRef.current,
        CATEGORIES.length,
        bucketCount,
      );
      const buckets = bucketsRef.current;

      const mask = maskRef.current;
      mask.fill(0);
      for (const s of visible) mask[s.id] = 1;

      const examined = aggregateBuckets(
        buffer,
        buckets,
        buffer.lowerBound(rangeStart),
        buffer.length,
        rangeStart,
        bucketMs,
        bucketCount,
        mask,
      );

      const groupPx = rect.width / bucketCount;
      const seriesCount = visible.length;
      // Leave a gap on each side of the group as well as between bars.
      const usable = Math.max(1, groupPx - BAR_GAP_PX * 2);
      const barWidth = Math.max(
        1,
        usable / Math.max(1, seriesCount) - BAR_GAP_PX,
      );
      const baselineY = yMap.offset + domain[0] * yMap.scale;

      clipToPlot(ctx, rect);
      let bars = 0;
      for (let si = 0; si < seriesCount; si++) {
        const descriptor = visible[si]!;
        ctx.beginPath();
        for (let b = 0; b < bucketCount; b++) {
          const mean = bucketMean(buckets, descriptor.id, b);
          if (Number.isNaN(mean)) continue; // empty bucket — draw nothing
          const groupLeft = rect.x + b * groupPx + BAR_GAP_PX;
          const x = groupLeft + si * (barWidth + BAR_GAP_PX);
          const y = mean * yMap.scale + yMap.offset;
          addBarToPath(ctx, x, y, barWidth, baselineY - y, 4);
          bars++;
        }
        // One fill per series rather than one per bar.
        ctx.fillStyle = descriptor.color;
        ctx.fill();
      }
      ctx.restore();

      return { rendered: bars, examined };
    },
    [buffer, window],
  );

  return (
    <ChartCanvas
      height={height}
      ariaLabel={`Bar chart of mean ${series
        .map((s) => s.label)
        .join(", ")} per time bucket`}
      signature={signature}
      draw={draw}
      forceRedraw={forceRedraw}
      active={following}
      onMetrics={onMetrics}
    >
      <ChartLegend
        series={series}
        mark="block"
        note="mean per time bucket"
      />
    </ChartCanvas>
  );
}
