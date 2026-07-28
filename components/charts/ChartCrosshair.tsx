"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type MutableRefObject,
} from "react";
import {
  clearCanvas,
  clipToPlot,
  resizeCanvas,
  type LinearMap,
  type PlotRect,
} from "@/lib/canvasUtils";
import {
  createCrosshairReading,
  formatCrosshairTime,
  resolveBucketCrosshair,
  resolveRawCrosshair,
} from "@/lib/crosshair";
import type { AggregationResult } from "@/lib/aggregation";
import type { SeriesDescriptor } from "@/lib/series";
import type { SeriesRingBuffer } from "@/lib/ringBuffer";
import { CATEGORY_LABELS, type ChartTheme } from "@/lib/theme";
import { CATEGORIES } from "@/lib/types";

/**
 * Tooltip geometry, duplicated from `.chart-tooltip` in globals.css.
 *
 * The alternative is reading `offsetHeight` on every pointer move, which forces
 * a synchronous layout inside the hover path. These are fixed in CSS precisely
 * so they can be computed here instead — keep the two in step.
 */
const TIP_WIDTH = 178;
const TIP_LINE_HEIGHT = 18;
/** Vertical padding plus borders: 8 + 8 + 1 + 1. */
const TIP_CHROME_HEIGHT = 18;
/** Gap between the crosshair and the tooltip's near edge. */
const TIP_OFFSET = 14;

/** Radius of the value marker, before its surface ring. */
const MARKER_RADIUS = 3.5;
const TAU = Math.PI * 2;

/**
 * Everything the overlay needs from the frame the base chart last painted.
 *
 * Published by the chart's `draw` callback into a ref rather than passed as
 * props: these change every frame, and routing them through React would
 * re-render the chart at display rate to service a hover affordance.
 */
export interface CrosshairFrame {
  /** False until the chart has drawn at least one frame with data. */
  ready: boolean;
  width: number;
  height: number;
  rect: PlotRect;
  xMap: LinearMap;
  yMap: LinearMap;
  /** Aggregation pass behind the current frame, or null on the raw path. */
  agg: AggregationResult | null;
}

export function createCrosshairFrame(): CrosshairFrame {
  return {
    ready: false,
    width: 0,
    height: 0,
    rect: { x: 0, y: 0, width: 0, height: 0 },
    xMap: { scale: 0, offset: 0 },
    yMap: { scale: 0, offset: 0 },
    agg: null,
  };
}

/**
 * Imperative surface. The chart drives this rather than the overlay binding
 * its own listeners, because the overlay renders *inside* `ChartCanvas` and so
 * its effects run before the one that publishes the canvas element — there is
 * nothing to bind to yet at that point. The chart owning the canvas is a
 * parent, so its effects run after, and it can bind safely.
 */
export interface CrosshairHandle {
  /** Pointer moved to `(x, y)`, in CSS pixels relative to the canvas. */
  move(x: number, y: number): void;
  /** Pointer left the chart. */
  leave(): void;
  /**
   * Redraw at the last cursor position. Called by the chart after it repaints
   * so the readout follows a live-scrolling line under a stationary cursor.
   * A no-op when the pointer is not over the plot.
   */
  refresh(): void;
}

export interface ChartCrosshairProps {
  /** Mutated in place by the chart's draw callback, read here on demand. */
  frameRef: MutableRefObject<CrosshairFrame>;
  buffer: SeriesRingBuffer;
  series: SeriesDescriptor[];
  theme: ChartTheme;
  /** Label for the aggregation window, shown when values are bucket means. */
  aggregationLabel?: string;
}

/** Latest props for the imperative path, refreshed on every React render. */
interface OverlayState {
  buffer: SeriesRingBuffer;
  series: SeriesDescriptor[];
  theme: ChartTheme;
  aggregationLabel: string | undefined;
  frameRef: MutableRefObject<CrosshairFrame>;
}

/**
 * Crosshair and tooltip layer for a time-series chart.
 *
 * Deliberately a *second* canvas stacked over the chart's own, rather than
 * extra drawing inside the chart's `draw` callback. Folding it in would make
 * every pointer move invalidate the frame signature, and each invalidation
 * re-rasterises the full decimated polyline — roughly 8ms of GPU work that
 * PERFORMANCE.md documents as the frame-rate limiter. Moving the mouse would
 * then cost more than the data stream does. On its own layer the hover redraw
 * touches one line and a handful of markers, and the base chart is untouched.
 *
 * The layer is `display: none` while the pointer is elsewhere, so a chart
 * nobody is hovering composites exactly as many layers as it did before.
 *
 * React is kept out of the loop entirely: the tooltip's DOM is built once and
 * then updated by writing `textContent` and a `transform`. Driving it from
 * state would reconcile the tree on every pointer move, which is the same
 * mistake the viewport ref exists to avoid.
 */
function ChartCrosshairImpl(
  { frameRef, buffer, series, theme, aggregationLabel }: ChartCrosshairProps,
  handleRef: React.ForwardedRef<CrosshairHandle>,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLDivElement>(null);
  // Fixed-length, indexed by category id, so lookups are an array read.
  const rowRefs = useRef<Array<HTMLDivElement | null>>(
    new Array<HTMLDivElement | null>(CATEGORIES.length).fill(null),
  );
  const valueRefs = useRef<Array<HTMLSpanElement | null>>(
    new Array<HTMLSpanElement | null>(CATEGORIES.length).fill(null),
  );
  const flagRefs = useRef<Array<HTMLSpanElement | null>>(
    new Array<HTMLSpanElement | null>(CATEGORIES.length).fill(null),
  );
  const swatchRefs = useRef<Array<HTMLSpanElement | null>>(
    new Array<HTMLSpanElement | null>(CATEGORIES.length).fill(null),
  );

  // Reused across every pointer move — see lib/crosshair.ts.
  const readingRef = useRef(createCrosshairReading(CATEGORIES.length));
  const maskRef = useRef(new Uint8Array(CATEGORIES.length));
  const colorsRef = useRef<string[]>(new Array<string>(CATEGORIES.length).fill(""));
  const cursorRef = useRef({ active: false, x: 0, y: 0 });
  const shownRef = useRef(false);
  /**
   * Signature of what is currently painted on the overlay.
   *
   * The same trick `ChartCanvas` uses for the base chart, and for the same
   * reason. Two things ask for a repaint: pointer moves, and `refresh()` after
   * every base-chart frame. Without a dirty check a hovering pointer repaints
   * twice per frame — once for the move, once for the frame that follows it —
   * and under a *stationary* cursor it repaints at display rate to show a
   * reading that only changes when data arrives at 10Hz. Comparing a cheap
   * signature turns both of those into a no-op.
   */
  const paintedRef = useRef("");

  const stateRef = useRef<OverlayState>({
    buffer,
    series,
    theme,
    aggregationLabel,
    frameRef,
  });
  stateRef.current = { buffer, series, theme, aggregationLabel, frameRef };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    ctxRef.current = canvas.getContext("2d");
  }, []);

  const renderRef = useRef<() => void>(() => {});
  renderRef.current = () => {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    const tip = tipRef.current;
    if (canvas === null || ctx === null || tip === null) return;

    const s = stateRef.current;
    const frame = s.frameRef.current;
    const cursor = cursorRef.current;
    const rect = frame.rect;

    // Hit test before doing any work: outside the plot there is nothing to read.
    const inside =
      cursor.active &&
      frame.ready &&
      rect.width > 0 &&
      cursor.x >= rect.x &&
      cursor.x <= rect.x + rect.width &&
      cursor.y >= 0 &&
      cursor.y <= frame.height;
    if (!inside) {
      hide(canvas, tip, shownRef);
      return;
    }

    const mask = maskRef.current;
    const colors = colorsRef.current;
    mask.fill(0);
    for (const descriptor of s.series) {
      mask[descriptor.id] = 1;
      colors[descriptor.id] = descriptor.color;
    }

    const reading = readingRef.current;
    const agg = frame.agg;
    const resolved =
      agg === null
        ? resolveRawCrosshair(
            s.buffer,
            mask,
            CATEGORIES.length,
            frame.xMap,
            frame.yMap,
            cursor.x,
            reading,
          )
        : resolveBucketCrosshair(
            agg.set,
            mask,
            CATEGORIES.length,
            agg.bucketCount,
            agg.rangeStart,
            agg.bucketMs,
            frame.xMap,
            frame.yMap,
            cursor.x,
            reading,
          );
    if (!resolved) {
      hide(canvas, tip, shownRef);
      return;
    }

    // Everything that affects a pixel on this layer, and nothing that does not.
    // `cursor.y` is in because the tooltip follows it vertically; the theme and
    // canvas size are in because they change what is drawn without changing
    // the reading.
    // `devicePixelRatio` is in the key because a DPR change resizes the backing
    // store, and resizing clears it — a cache hit there would leave the layer
    // blank until the reading happened to change.
    let signature = `${reading.x}|${reading.count}|${reading.aggregated}|${reading.timestamp}|${cursor.y}|${frame.width}|${frame.height}|${s.theme.mode}|${window.devicePixelRatio}`;
    for (let i = 0; i < reading.count; i++) {
      const sample = reading.samples[i]!;
      signature += `|${sample.seriesId},${sample.y},${sample.value},${sample.anomaly ? 1 : 0}`;
    }
    if (signature === paintedRef.current && shownRef.current) return;
    paintedRef.current = signature;

    if (!shownRef.current) {
      canvas.style.display = "block";
      tip.style.visibility = "visible";
      shownRef.current = true;
    }

    resizeCanvas(canvas, ctx, frame.width, frame.height, window.devicePixelRatio || 1);
    clearCanvas(ctx, frame.width, frame.height);

    clipToPlot(ctx, rect);

    // Half-pixel so a 1px rule renders as one crisp line, not two grey ones —
    // same reason the gridlines do it.
    const x = Math.round(reading.x) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, rect.y);
    ctx.lineTo(x, rect.y + rect.height);
    ctx.strokeStyle = s.theme.crosshair;
    ctx.lineWidth = 1;
    ctx.stroke();

    for (let i = 0; i < reading.count; i++) {
      const sample = reading.samples[i]!;
      const color = colors[sample.seriesId] ?? s.theme.text;
      ctx.beginPath();
      ctx.arc(x, sample.y, MARKER_RADIUS, 0, TAU);
      ctx.fillStyle = color;
      ctx.fill();
      // A surface-coloured ring keeps two markers legible where series cross.
      ctx.strokeStyle = s.theme.surface;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (sample.anomaly) {
        ctx.beginPath();
        ctx.arc(x, sample.y, MARKER_RADIUS + 3, 0, TAU);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    ctx.restore();

    /* -------- tooltip: written straight to the DOM, never through state ---- */

    const time = timeRef.current;
    if (time !== null) {
      time.textContent = reading.aggregated
        ? `${formatCrosshairTime(reading.timestamp)} · ${s.aggregationLabel ?? "bucket"} mean`
        : formatCrosshairTime(reading.timestamp);
    }

    // Walk both lists at once: `reading.samples` is ordered by ascending
    // series id, and so are the rows, so hidden series fall out for free.
    let next = 0;
    for (let id = 0; id < CATEGORIES.length; id++) {
      const row = rowRefs.current[id];
      if (row === undefined || row === null) continue;
      const sample = next < reading.count ? reading.samples[next] : undefined;
      if (sample === undefined || sample.seriesId !== id) {
        row.style.display = "none";
        continue;
      }
      next++;
      row.style.display = "flex";
      const swatch = swatchRefs.current[id];
      if (swatch !== undefined && swatch !== null) {
        swatch.style.background = colors[id] ?? "";
      }
      const value = valueRefs.current[id];
      if (value !== undefined && value !== null) {
        value.textContent = sample.value.toFixed(2);
      }
      const flag = flagRefs.current[id];
      if (flag !== undefined && flag !== null) {
        flag.style.display = sample.anomaly ? "inline" : "none";
      }
    }

    const tipHeight = TIP_CHROME_HEIGHT + TIP_LINE_HEIGHT * (1 + reading.count);

    // Flip to the other side of the crosshair rather than let the tooltip run
    // off the canvas — the right margin is only a label gutter, not room.
    let left = reading.x + TIP_OFFSET;
    if (left + TIP_WIDTH > frame.width) left = reading.x - TIP_OFFSET - TIP_WIDTH;
    if (left < 0) left = 0;

    let top = cursor.y - tipHeight / 2;
    const maxTop = rect.y + rect.height - tipHeight;
    if (top > maxTop) top = maxTop;
    if (top < rect.y) top = rect.y;

    // `transform` rather than `left`/`top`: it moves the layer on the
    // compositor instead of dirtying layout on every pointer move.
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  };

  useImperativeHandle(
    handleRef,
    () => ({
      move: (x: number, y: number) => {
        const cursor = cursorRef.current;
        cursor.active = true;
        cursor.x = x;
        cursor.y = y;
        // Drawn synchronously in the event handler rather than deferred to the
        // next frame: the work is one line and a few markers, and a crosshair
        // that lags the pointer by a frame reads as a broken one.
        renderRef.current();
      },
      leave: () => {
        cursorRef.current.active = false;
        renderRef.current();
      },
      refresh: () => {
        if (cursorRef.current.active) renderRef.current();
      },
    }),
    [],
  );

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          display: "none",
          pointerEvents: "none",
        }}
      />
      {/*
        aria-hidden because this is a pointer-only affordance with no keyboard
        or screen-reader path to it. The same numbers are reachable in the
        virtualized data table, which is the accessible route to the values.
      */}
      <div ref={tipRef} className="chart-tooltip" aria-hidden="true">
        <div ref={timeRef} className="chart-tooltip__time" />
        {CATEGORIES.map((category, id) => (
          <div
            key={category}
            className="chart-tooltip__row"
            ref={(node) => {
              rowRefs.current[id] = node;
            }}
          >
            <span
              className="chart-tooltip__swatch"
              ref={(node) => {
                swatchRefs.current[id] = node;
              }}
            />
            <span className="chart-tooltip__label">
              {CATEGORY_LABELS[category]}
            </span>
            <span
              className="chart-tooltip__flag"
              ref={(node) => {
                flagRefs.current[id] = node;
              }}
            >
              spike
            </span>
            <span
              className="chart-tooltip__value mono"
              ref={(node) => {
                valueRefs.current[id] = node;
              }}
            />
          </div>
        ))}
      </div>
    </>
  );
}

function hide(
  canvas: HTMLCanvasElement,
  tip: HTMLDivElement,
  shownRef: MutableRefObject<boolean>,
): void {
  if (!shownRef.current) return;
  // `display: none` and not just `visibility: hidden` — a hidden layer is
  // still a layer to composite, and the point of this overlay is that a chart
  // nobody is hovering pays nothing for it.
  canvas.style.display = "none";
  tip.style.visibility = "hidden";
  shownRef.current = false;
}

export const ChartCrosshair = forwardRef(ChartCrosshairImpl);
