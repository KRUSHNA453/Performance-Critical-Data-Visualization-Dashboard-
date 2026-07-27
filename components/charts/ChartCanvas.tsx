"use client";

import {
  useEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  DEFAULT_MARGINS,
  computePlotRect,
  resizeCanvas,
  type AxisTheme,
  type PlotMargins,
  type PlotRect,
} from "@/lib/canvasUtils";
import { AXIS_FONT, getChartTheme, type ChartTheme } from "@/lib/theme";
import type { PerformanceMetrics } from "@/lib/types";
import { useElementSize } from "@/hooks/useElementSize";
import { useThemeMode } from "@/hooks/useThemeMode";

/** How often metrics are pushed to React, in ms. */
const METRICS_INTERVAL_MS = 500;

/** A frame slower than this counts as dropped against a 60fps budget. */
const FRAME_BUDGET_MS = 1000 / 60;

/** Everything a chart's draw callback receives for one frame. */
export interface ChartFrame {
  ctx: CanvasRenderingContext2D;
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
  /** Drawable region inside the margins. */
  rect: PlotRect;
  theme: ChartTheme;
  axisTheme: AxisTheme;
  /** rAF timestamp for this frame. */
  now: number;
}

/** What a chart reports back so the metrics panel can show real counts. */
export interface DrawResult {
  /** Marks actually rasterised — vertices, bars, or points. */
  rendered: number;
  /** Source samples considered before decimation. */
  examined: number;
}

export interface ChartCanvasProps {
  height: number;
  margins?: PlotMargins;
  ariaLabel: string;
  /**
   * Cache key for the frame. When it is unchanged and `forceRedraw` is off,
   * the draw is skipped entirely.
   *
   * This is the memoisation that matters for the render path. React's
   * `useMemo` cannot serve the role — it only evaluates during React's render
   * pass, and this loop deliberately runs outside it — so the equivalent
   * mechanism is a cache key compared once per frame.
   */
  signature: (frame: ChartFrame) => string;
  draw: (frame: ChartFrame) => DrawResult;
  /** Redraw every frame regardless of the signature. Benchmark mode. */
  forceRedraw?: boolean;
  /** Whether the chart is expected to be animating; gates dropped-frame counting. */
  active?: boolean;
  onMetrics?: (metrics: PerformanceMetrics) => void;
  /**
   * Receives the canvas element so a caller can bind gesture listeners to it.
   * Populated on mount; child effects run before the parent's, so a parent
   * effect can rely on it being set.
   */
  canvasRefOut?: MutableRefObject<HTMLCanvasElement | null>;
  /**
   * Holds `performance.now()` of the oldest input not yet on screen, or 0.
   * The loop converts it into `lastInteractionMs` on the frame that draws,
   * measuring real input-to-pixels latency rather than estimating it.
   */
  interactionLatencyRef?: MutableRefObject<number>;
  /** Rendered above the canvas — legends, notes. */
  children?: ReactNode;
}

/** Latest props, read by the loop through a ref so it never has to restart. */
interface LoopState {
  width: number;
  height: number;
  margins: PlotMargins;
  theme: ChartTheme;
  axisTheme: AxisTheme;
  signature: (frame: ChartFrame) => string;
  draw: (frame: ChartFrame) => DrawResult;
  forceRedraw: boolean;
  active: boolean;
  onMetrics: ((metrics: PerformanceMetrics) => void) | undefined;
  interactionLatencyRef: MutableRefObject<number> | undefined;
}

/**
 * The shared render runtime for every chart in the dashboard.
 *
 * Owns the single requestAnimationFrame loop, canvas sizing and DPR handling,
 * the dirty check, and metrics collection — so LineChart, BarChart and
 * ScatterPlot differ only in their `draw` callback. Extracting this was the
 * point of adding the second and third chart: three copies of a hand-tuned rAF
 * loop is three places for a frame-pacing bug to hide.
 *
 * The loop is started once on mount and never restarted; all inputs reach it
 * through a ref that React refreshes on each render.
 */
export function ChartCanvas({
  height,
  margins = DEFAULT_MARGINS,
  ariaLabel,
  signature,
  draw,
  forceRedraw = false,
  active = true,
  onMetrics,
  canvasRefOut,
  interactionLatencyRef,
  children,
}: ChartCanvasProps) {
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mode = useThemeMode();

  // Hand the element up so a parent can attach gesture listeners to it.
  useEffect(() => {
    if (canvasRefOut === undefined) return;
    canvasRefOut.current = canvasRef.current;
    return () => {
      canvasRefOut.current = null;
    };
  }, [canvasRefOut]);

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

  const stateRef = useRef<LoopState>({
    width: size.width,
    height,
    margins,
    theme,
    axisTheme,
    signature,
    draw,
    forceRedraw,
    active,
    onMetrics,
    interactionLatencyRef,
  });
  stateRef.current = {
    width: size.width,
    height,
    margins,
    theme,
    axisTheme,
    signature,
    draw,
    forceRedraw,
    active,
    onMetrics,
    interactionLatencyRef,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    // `alpha: false` lets the compositor skip per-pixel blending of the canvas
    // against the page; the chart paints its own opaque surface anyway.
    const ctx = canvas.getContext("2d", { alpha: false });
    if (ctx === null) return;

    let rafId = 0;
    let running = true;
    let lastSignature = "";

    // Rolling metrics window, reset on every emit.
    let frames = 0;
    let drawnFrames = 0;
    let drawTimeSum = 0;
    let drawTimePeak = 0;
    let dropped = 0;
    let lastFrameAt = 0;
    let lastEmitAt = 0;
    let lastRendered = 0;
    let lastExamined = 0;
    let lastInteractionMs: number | null = null;

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
        performance as Performance & { memory?: { usedJSHeapSize: number } }
      ).memory;

      s.onMetrics({
        fps: (frames * 1000) / elapsed,
        avgFrameMs: drawnFrames === 0 ? 0 : drawTimeSum / drawnFrames,
        peakFrameMs: drawTimePeak,
        pointsRendered: lastRendered,
        pointsInBuffer: lastExamined,
        droppedFrames: dropped,
        heapUsedMb:
          memory === undefined
            ? null
            : Math.round((memory.usedJSHeapSize / 1048576) * 10) / 10,
        lastInteractionMs,
      });

      frames = 0;
      drawnFrames = 0;
      drawTimeSum = 0;
      drawTimePeak = 0;
      dropped = 0;
      lastEmitAt = now;
    };

    const frame = (now: number) => {
      if (!running) return;
      rafId = requestAnimationFrame(frame);

      const s = stateRef.current;

      if (lastFrameAt !== 0) {
        const delta = now - lastFrameAt;
        // Only count a stall as dropped when we were actually asked to draw;
        // an idle paused chart legitimately does nothing.
        if (delta > FRAME_BUDGET_MS * 1.5 && (s.active || s.forceRedraw)) {
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

      const rect = computePlotRect(s.width, s.height, s.margins);
      if (rect.width <= 0 || rect.height <= 0) return;

      const chartFrame: ChartFrame = {
        ctx,
        width: s.width,
        height: s.height,
        rect,
        theme: s.theme,
        axisTheme: s.axisTheme,
        now,
      };

      const sig = s.forceRedraw ? String(now) : s.signature(chartFrame);
      if (!resized && sig === lastSignature) {
        maybeEmitMetrics(now);
        return;
      }
      lastSignature = sig;

      const drawStart = performance.now();
      const result = s.draw(chartFrame);
      const drawMs = performance.now() - drawStart;

      // Measured here, after the draw that consumed the input, so the number
      // covers dispatch + gesture math + projection + rasterisation rather
      // than just the handler.
      const pendingInput = s.interactionLatencyRef?.current ?? 0;
      if (pendingInput !== 0) {
        lastInteractionMs = performance.now() - pendingInput;
        if (s.interactionLatencyRef !== undefined) {
          s.interactionLatencyRef.current = 0;
        }
      }

      drawnFrames++;
      drawTimeSum += drawMs;
      if (drawMs > drawTimePeak) drawTimePeak = drawMs;
      lastRendered = result.rendered;
      lastExamined = result.examined;

      maybeEmitMetrics(now);
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
      {children}
      <div
        ref={containerRef}
        style={{ width: "100%", height, position: "relative" }}
      >
        <canvas
          ref={canvasRef}
          style={{ display: "block", width: "100%", height: "100%" }}
          role="img"
          aria-label={ariaLabel}
        />
      </div>
    </div>
  );
}
