"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  AXIS_FONT,
  CATEGORY_LABELS,
  getChartTheme,
  type ChartTheme,
} from "@/lib/theme";
import {
  DEFAULT_MARGINS,
  clearCanvas,
  clipToPlot,
  computePlotRect,
  createVertexBuffer,
  drawPolyline,
  drawXAxis,
  drawYAxis,
  linearMap,
  linearTicks,
  niceStep,
  projectSeries,
  resizeCanvas,
  timeTicks,
  vertexCapacityFor,
  type AxisTheme,
  type VertexBuffer,
} from "@/lib/canvasUtils";
import type { SeriesRingBuffer } from "@/lib/ringBuffer";
import {
  CATEGORIES,
  CATEGORY_IDS,
  type Category,
  type PerformanceMetrics,
} from "@/lib/types";
import { useElementSize } from "@/hooks/useElementSize";
import { useThemeMode } from "@/hooks/useThemeMode";

const ALL_CATEGORIES: ReadonlySet<Category> = new Set(CATEGORIES);

/** How often metrics are pushed to React, in ms. */
const METRICS_INTERVAL_MS = 500;

/** A frame slower than this counts as dropped against a 60fps budget. */
const FRAME_BUDGET_MS = 1000 / 60;

export interface LineChartProps {
  buffer: SeriesRingBuffer;
  /** Series to draw. Hidden series stay in the buffer and are skipped cheaply. */
  visibleCategories?: ReadonlySet<Category>;
  /** Pin the right edge to wall-clock time so the plot scrolls smoothly. */
  following?: boolean;
  /** Fixed value-axis domain. All four series are percentages, so 0–100. */
  yDomain?: readonly [number, number];
  /** Redraw every frame even when nothing changed. Benchmark mode. */
  forceRedraw?: boolean;
  onMetrics?: (metrics: PerformanceMetrics) => void;
  height?: number;
}

interface SeriesDescriptor {
  category: Category;
  id: number;
  color: string;
  label: string;
}

/** Everything the rAF loop reads. Kept in a ref so prop changes never restart it. */
interface LoopState {
  buffer: SeriesRingBuffer;
  series: SeriesDescriptor[];
  theme: ChartTheme;
  axisTheme: AxisTheme;
  width: number;
  height: number;
  following: boolean;
  yDomain: readonly [number, number];
  forceRedraw: boolean;
  onMetrics: ((metrics: PerformanceMetrics) => void) | undefined;
}

/**
 * Canvas line chart over the streaming ring buffer.
 *
 * Two decisions drive the whole design:
 *
 * 1. **One rAF loop, decoupled from the 100ms data tick.** Data arrives at
 *    10Hz; the display refreshes at 60Hz. Binding rendering to data arrival
 *    would either render at 10fps (choppy) or re-render React ten times a
 *    second (expensive). Instead the loop runs free at display rate and reads
 *    whatever is in the buffer at that instant, so ingestion and rendering
 *    never contend.
 *
 * 2. **React never re-renders on data.** This component renders once per
 *    prop change. The buffer mutates underneath it and the loop picks it up.
 */
export function LineChart({
  buffer,
  visibleCategories = ALL_CATEGORIES,
  following = true,
  yDomain = [0, 100],
  forceRedraw = false,
  onMetrics,
  height = 320,
}: LineChartProps) {
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mode = useThemeMode();

  const theme = useMemo(() => getChartTheme(mode), [mode]);

  const axisTheme = useMemo<AxisTheme>(
    () => ({
      grid: theme.grid,
      axis: theme.axis,
      label: theme.label,
      font: AXIS_FONT,
    }),
    [theme],
  );

  // Recomputed only when the visible set or theme changes — not per frame.
  const series = useMemo<SeriesDescriptor[]>(
    () =>
      CATEGORIES.filter((c) => visibleCategories.has(c)).map((category) => ({
        category,
        id: CATEGORY_IDS[category],
        color: theme.series[category],
        label: CATEGORY_LABELS[category],
      })),
    [visibleCategories, theme],
  );

  /**
   * Pooled vertex storage, one slot per category (indexed by category id, with
   * holes for hidden series so `projectSeries` can skip them by identity).
   * Reallocated only when the plot gets wider — never per frame.
   */
  const plotWidth = Math.max(
    0,
    size.width - DEFAULT_MARGINS.left - DEFAULT_MARGINS.right,
  );
  const vertexPool = useMemo<VertexBuffer[]>(() => {
    const capacity = vertexCapacityFor(plotWidth);
    return CATEGORIES.map(() => createVertexBuffer(capacity));
    // Bucketing by 256px stops a resize drag from reallocating on every pixel.
  }, [Math.ceil(plotWidth / 256)]); // eslint-disable-line react-hooks/exhaustive-deps

  const stateRef = useRef<LoopState>({
    buffer,
    series,
    theme,
    axisTheme,
    width: size.width,
    height,
    following,
    yDomain,
    forceRedraw,
    onMetrics,
  });
  // Refreshed on every React render; the loop always reads the latest values.
  stateRef.current = {
    buffer,
    series,
    theme,
    axisTheme,
    width: size.width,
    height,
    following,
    yDomain,
    forceRedraw,
    onMetrics,
  };

  const poolRef = useRef(vertexPool);
  poolRef.current = vertexPool;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (ctx === null) return;

    let rafId = 0;
    let running = true;

    /**
     * Signature of everything that affects the pixels. When it is unchanged
     * there is nothing new to draw.
     *
     * This is the memoisation that matters for the render path. React's
     * `useMemo` cannot serve here — it only evaluates during React's render
     * pass, and this loop deliberately runs outside it — so the equivalent
     * mechanism is a cache key compared once per frame.
     */
    let lastSignature = "";

    // Rolling metrics window.
    let frames = 0;
    let drawnFrames = 0;
    let drawTimeSum = 0;
    let drawTimePeak = 0;
    let dropped = 0;
    let lastFrameAt = 0;
    let lastEmitAt = 0;
    let lastPointsRendered = 0;
    let lastPointsExamined = 0;

    // Allocated once for the lifetime of the loop, not per frame.
    const active: Array<VertexBuffer | undefined> = new Array(
      CATEGORIES.length,
    );

    const frame = (now: number) => {
      if (!running) return;
      rafId = requestAnimationFrame(frame);

      const s = stateRef.current;
      const pool = poolRef.current;

      if (lastFrameAt !== 0) {
        const delta = now - lastFrameAt;
        // Only count a stall as dropped when we were actually asked to draw;
        // an idle paused chart legitimately does nothing.
        if (delta > FRAME_BUDGET_MS * 1.5 && (s.following || s.forceRedraw)) {
          dropped++;
        }
      }
      lastFrameAt = now;
      frames++;

      if (s.width <= 0 || s.height <= 0) return;

      const resized = resizeCanvas(
        canvas,
        ctx,
        s.width,
        s.height,
        window.devicePixelRatio || 1,
      );

      const rect = computePlotRect(s.width, s.height, DEFAULT_MARGINS);
      if (rect.width <= 0 || rect.height <= 0) return;

      const bufferEnd = s.buffer.endTime;
      const bufferStart = s.buffer.startTime;
      if (bufferEnd === null || bufferStart === null) return;

      // Following pins the right edge to wall-clock, so the window advances
      // every frame and the plot scrolls continuously instead of stepping
      // forward 10 times a second with the data.
      const spanMs = Math.max(1000, bufferEnd - bufferStart);
      const xEnd = s.following ? Date.now() : bufferEnd;
      const xStart = xEnd - spanMs;

      const signature = s.forceRedraw
        ? `${now}`
        : `${s.buffer.revision}|${xStart}|${s.width}|${s.height}|${s.theme.mode}|${s.series.length}|${s.yDomain[0]}|${s.yDomain[1]}`;

      if (!resized && signature === lastSignature) {
        maybeEmitMetrics(now);
        return;
      }
      lastSignature = signature;

      const drawStart = performance.now();

      const xMap = linearMap(xStart, xEnd, rect.x, rect.x + rect.width);
      // Inverted: value 0 sits at the bottom of the plot.
      const yMap = linearMap(
        s.yDomain[0],
        s.yDomain[1],
        rect.y + rect.height,
        rect.y,
      );

      clearCanvas(ctx, s.width, s.height, s.theme.surface);

      const yStep = niceStep(s.yDomain[1] - s.yDomain[0], 5);
      drawYAxis(
        ctx,
        rect,
        linearTicks(s.yDomain[0], s.yDomain[1], 5),
        yMap,
        yStep,
        s.axisTheme,
      );
      drawXAxis(
        ctx,
        rect,
        timeTicks(xStart, xEnd, Math.max(2, Math.floor(rect.width / 90))),
        xMap,
        spanMs,
        s.axisTheme,
      );

      // Only project series that are actually visible: leaving holes in this
      // array lets the projection loop skip hidden points without a per-point
      // set lookup. Reused across frames rather than reallocated.
      active.fill(undefined);
      for (const descriptor of s.series) {
        active[descriptor.id] = pool[descriptor.id];
      }

      const startIndex = s.buffer.lowerBound(xStart);
      const examined = projectSeries(
        s.buffer,
        CATEGORIES.length,
        startIndex,
        s.buffer.length,
        xMap,
        yMap,
        active as VertexBuffer[],
      );

      clipToPlot(ctx, rect);
      let vertices = 0;
      for (const descriptor of s.series) {
        const vb = pool[descriptor.id];
        if (vb === undefined) continue;
        drawPolyline(ctx, vb, descriptor.color, 2);
        vertices += vb.count;
      }
      ctx.restore();

      drawDirectLabels(ctx, s, pool, rect);

      const drawMs = performance.now() - drawStart;
      drawnFrames++;
      drawTimeSum += drawMs;
      if (drawMs > drawTimePeak) drawTimePeak = drawMs;
      lastPointsRendered = vertices;
      lastPointsExamined = examined;

      maybeEmitMetrics(now);
    };

    const maybeEmitMetrics = (now: number) => {
      const s = stateRef.current;
      if (s.onMetrics === undefined) return;
      if (lastEmitAt === 0) {
        // Start the window here and discard frames counted before it, or the
        // first reading averages over an unknown span and reports nonsense.
        lastEmitAt = now;
        frames = 0;
        drawnFrames = 0;
        drawTimeSum = 0;
        drawTimePeak = 0;
        dropped = 0;
        return;
      }
      const elapsed = now - lastEmitAt;
      if (elapsed < METRICS_INTERVAL_MS) return;

      const memory = (
        performance as Performance & {
          memory?: { usedJSHeapSize: number };
        }
      ).memory;

      s.onMetrics({
        fps: (frames * 1000) / elapsed,
        avgFrameMs: drawnFrames === 0 ? 0 : drawTimeSum / drawnFrames,
        peakFrameMs: drawTimePeak,
        pointsRendered: lastPointsRendered,
        pointsInBuffer: lastPointsExamined,
        droppedFrames: dropped,
        heapUsedMb:
          memory === undefined
            ? null
            : Math.round((memory.usedJSHeapSize / 1048576) * 10) / 10,
        lastInteractionMs: null,
      });

      frames = 0;
      drawnFrames = 0;
      drawTimeSum = 0;
      drawTimePeak = 0;
      dropped = 0;
      lastEmitAt = now;
    };

    rafId = requestAnimationFrame(frame);
    return () => {
      running = false;
      cancelAnimationFrame(rafId);
    };
    // Started once and never restarted — all inputs are read through refs.
  }, []);

  return (
    <div>
      <Legend series={series} />
      <div
        ref={containerRef}
        style={{ width: "100%", height, position: "relative" }}
      >
        <canvas
          ref={canvasRef}
          style={{ display: "block", width: "100%", height: "100%" }}
          role="img"
          aria-label={`Line chart of ${series
            .map((s) => s.label)
            .join(", ")} over time`}
        />
      </div>
    </div>
  );
}

/**
 * Value labels at the live edge.
 *
 * Not decoration: aqua and yellow both fall below 3:1 contrast on the light
 * surface, so identity cannot rest on the line colour alone. Labels are nudged
 * apart when they would collide.
 */
function drawDirectLabels(
  ctx: CanvasRenderingContext2D,
  state: LoopState,
  pool: VertexBuffer[],
  rect: { x: number; y: number; width: number; height: number },
): void {
  const entries: Array<{ y: number; color: string; text: string }> = [];
  for (const descriptor of state.series) {
    const vb = pool[descriptor.id];
    if (vb === undefined || vb.count === 0) continue;
    entries.push({
      y: vb.ys[vb.count - 1]!,
      color: descriptor.color,
      text: descriptor.label,
    });
  }
  if (entries.length === 0) return;

  // Nudge apart, top to bottom, so labels never overlap each other.
  entries.sort((a, b) => a.y - b.y);
  const minGap = 13;
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]!;
    const cur = entries[i]!;
    if (cur.y - prev.y < minGap) cur.y = prev.y + minGap;
  }
  // Then pull the whole stack back inside the plot if it overflowed either end.
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
    // Drawn in the right-hand gutter, clear of the plot area entirely.
    ctx.fillText(entry.text, rect.x + rect.width + 6, entry.y);
  }
  ctx.restore();
}

function Legend({ series }: { series: SeriesDescriptor[] }) {
  if (series.length < 2) return null;
  return (
    <ul
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "4px 16px",
        listStyle: "none",
        margin: "0 0 8px",
        padding: 0,
        fontSize: 12,
        color: "var(--text-muted)",
      }}
    >
      {series.map((s) => (
        <li
          key={s.category}
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          <span
            aria-hidden
            style={{
              width: 10,
              height: 2,
              borderRadius: 1,
              background: s.color,
              flex: "0 0 auto",
            }}
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}
