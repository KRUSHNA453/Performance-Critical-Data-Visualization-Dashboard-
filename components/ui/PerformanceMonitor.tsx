"use client";

import { useEffect, useRef, useState } from "react";
import { useChartTheme } from "@/hooks/useChartTheme";
import type { PerformanceMetrics } from "@/lib/types";

/** How often the readout commits to React. Fast enough to feel live, slow
 *  enough that the monitor is not itself a measurable cost. */
const SAMPLE_INTERVAL_MS = 500;

/** Frames-per-second history retained for the sparkline, at one sample per commit. */
const HISTORY = 60;

/** Heap samples kept for the growth-rate fit — 240 x 500ms = two minutes. */
const HEAP_HISTORY = 240;

/**
 * Minimum observation window before a growth rate is shown, in ms.
 *
 * Extrapolating to an hour from a few seconds of GC sawtooth produces numbers
 * like "-1116 MB/hr" — arithmetically correct, physically meaningless, and
 * worse than showing nothing, because it invites the reader to believe it.
 *
 * 90 seconds rather than 40: the first minute after load is dominated by
 * one-time warm-up (JIT, the pooled vertex buffers, the scatter occupancy
 * grid, the table's index map), and a window that straddles it reports that
 * warm-up as ongoing growth. Measured on the deployed build, a 40s window read
 * +95 MB/hr for a heap that is flat once warm. Waiting until the window is
 * mostly past warm-up costs a minute of patience and buys a number that means
 * what it says.
 */
const MIN_TREND_WINDOW_MS = 90_000;

/** Width of each baseline bucket. One collection typically lands per bucket. */
const TREND_BUCKET_MS = 10_000;

/** Baseline points required before a slope is reported. */
const MIN_TREND_BUCKETS = 4;

const GOOD = "#0ca30c";
const WARNING = "#fab219";
const CRITICAL = "#d03b3b";

interface Sample {
  t: number;
  bytes: number;
}

function fpsColor(fps: number): string {
  if (fps >= 55) return GOOD;
  if (fps >= 40) return WARNING;
  return CRITICAL;
}

/**
 * Growth rate of the post-GC heap baseline, in MB/hour.
 *
 * Fitting a line through *every* sample does not measure what it looks like it
 * measures. A healthy heap sawtooths — allocate, collect, repeat — and over a
 * two-minute window this one swings between roughly 4 and 10 MB while ending
 * exactly where it started. A naive least-squares fit across those samples
 * reported +110 MB/hr for a heap that was not growing at all, because the slope
 * is dominated by where in the sawtooth the samples happened to land.
 *
 * What actually distinguishes a leak is the *floor*: retained objects raise the
 * post-collection baseline, while churn does not. So samples are bucketed by
 * time, the minimum of each bucket is taken as that period's baseline, and the
 * line is fitted through those minima. Noise from the sawtooth drops out and
 * genuine retention still shows.
 *
 * Approximate by nature — GC scheduling is not ours to control — which is why
 * it is labelled a trend rather than a measurement.
 */
function heapTrendMbPerHour(samples: Sample[]): number | null {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined) return null;
  if (last.t - first.t < MIN_TREND_WINDOW_MS) return null;

  // Lowest reading in each bucket ~ the heap immediately after a collection.
  const baselines = new Map<number, Sample>();
  for (const s of samples) {
    const key = Math.floor(s.t / TREND_BUCKET_MS);
    const current = baselines.get(key);
    if (current === undefined || s.bytes < current.bytes) baselines.set(key, s);
  }

  const points = [...baselines.values()].sort((a, b) => a.t - b.t);
  if (points.length < MIN_TREND_BUCKETS) return null;

  const n = points.length;
  let sumT = 0;
  let sumY = 0;
  for (const p of points) {
    sumT += p.t;
    sumY += p.bytes;
  }
  const meanT = sumT / n;
  const meanY = sumY / n;

  let num = 0;
  let den = 0;
  for (const p of points) {
    const dt = p.t - meanT;
    num += dt * (p.bytes - meanY);
    den += dt * dt;
  }
  if (den === 0) return null;

  const bytesPerMs = num / den;
  return (bytesPerMs * 3_600_000) / 1048576;
}

export interface PerformanceMonitorProps {
  /** Draw-time stats from the active chart, if one is mounted. */
  drawMetrics: PerformanceMetrics | null;
}

/**
 * Always-visible FPS and memory readout.
 *
 * Counts frames on its own requestAnimationFrame loop rather than trusting the
 * chart's numbers. The chart only reports on frames it actually draws, so a
 * chart that has correctly decided nothing changed would report an idle,
 * flattering figure; an independent counter measures what the browser is
 * really doing. Draw-time and dropped-frame figures still come from the chart,
 * since only it knows how long its own rasterisation took.
 *
 * The monitor commits to React twice a second and keeps its history in refs,
 * so it costs one small re-render per 500ms rather than one per frame.
 */
export function PerformanceMonitor({ drawMetrics }: PerformanceMonitorProps) {
  const theme = useChartTheme();
  const [collapsed, setCollapsed] = useState(false);
  /** null until the first sampling window closes — distinct from a real zero. */
  const [fps, setFps] = useState<number | null>(null);
  const [heapMb, setHeapMb] = useState<number | null>(null);
  const [trend, setTrend] = useState<number | null>(null);
  /**
   * Whether this browser exposes `performance.memory` at all.
   *
   * Kept separate from `heapMb` because "not measured yet" and "cannot be
   * measured here" are different states, and conflating them made the page
   * claim, for the first half-second after load, that the browser did not
   * support heap reporting when it plainly did.
   */
  const [heapSupported, setHeapSupported] = useState<boolean | null>(null);

  const sparkRef = useRef<HTMLCanvasElement>(null);
  const fpsHistoryRef = useRef<number[]>([]);
  const heapHistoryRef = useRef<Sample[]>([]);

  useEffect(() => {
    let rafId = 0;
    let running = true;
    let frames = 0;
    let windowStart = performance.now();

    const tick = (now: number) => {
      if (!running) return;
      rafId = requestAnimationFrame(tick);
      frames++;

      const elapsed = now - windowStart;
      if (elapsed < SAMPLE_INTERVAL_MS) return;

      const measured = (frames * 1000) / elapsed;
      frames = 0;
      windowStart = now;

      const history = fpsHistoryRef.current;
      history.push(measured);
      if (history.length > HISTORY) history.shift();
      setFps(measured);

      const memory = (
        performance as Performance & { memory?: { usedJSHeapSize: number } }
      ).memory;
      setHeapSupported(memory !== undefined);
      if (memory !== undefined) {
        const bytes = memory.usedJSHeapSize;
        const samples = heapHistoryRef.current;
        samples.push({ t: Date.now(), bytes });
        if (samples.length > HEAP_HISTORY) samples.shift();
        setHeapMb(bytes / 1048576);
        setTrend(heapTrendMbPerHour(samples));
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(rafId);
    };
  }, []);

  // Sparkline redraws only when a new sample lands, not every frame.
  useEffect(() => {
    const canvas = sparkRef.current;
    if (canvas === null || collapsed) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = 132;
    const cssHeight = 26;
    const targetW = Math.round(cssWidth * dpr);
    const targetH = Math.round(cssHeight * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const history = fpsHistoryRef.current;
    if (history.length === 0) return;

    // Fixed 0–70 scale: an autoscaled FPS chart hides exactly the drop you
    // are watching for, because the axis follows it down.
    const max = 70;
    const step = cssWidth / Math.max(1, HISTORY - 1);

    // 60fps reference line.
    const y60 = cssHeight - (60 / max) * cssHeight;
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y60) + 0.5);
    ctx.lineTo(cssWidth, Math.round(y60) + 0.5);
    ctx.stroke();

    ctx.beginPath();
    for (let i = 0; i < history.length; i++) {
      const x = i * step;
      const y = cssHeight - (Math.min(history[i]!, max) / max) * cssHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = fpsColor(history[history.length - 1] ?? 0);
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();
  }, [fps, collapsed, theme]);

  const trendOk = trend === null || trend < 1;

  return (
    <aside
      aria-label="Performance monitor"
      style={{
        position: "fixed",
        right: 12,
        bottom: 12,
        zIndex: 50,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: collapsed ? "6px 10px" : "10px 12px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.28)",
        fontSize: 12,
        minWidth: collapsed ? 0 : 168,
        // Never let the overlay swallow a drag aimed at the chart underneath.
        pointerEvents: "auto",
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          background: "transparent",
          border: "none",
          padding: 0,
          color: "var(--text)",
          font: "inherit",
          cursor: "pointer",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            // Muted until there is a real reading — a green dot beside "0 FPS"
            // would assert a measurement that has not been taken.
            background: fps === null ? "var(--text-muted)" : fpsColor(fps),
            flex: "0 0 auto",
          }}
        />
        <span className="mono" style={{ fontWeight: 600 }}>
          {fps === null ? "— FPS" : `${fps.toFixed(0)} FPS`}
        </span>
        <span style={{ marginLeft: "auto", color: "var(--text-muted)" }}>
          {collapsed ? "▲" : "▼"}
        </span>
      </button>

      {!collapsed && (
        <>
          <canvas
            ref={sparkRef}
            aria-hidden
            style={{ display: "block", margin: "8px 0 6px" }}
          />
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: "3px 10px",
              margin: 0,
              color: "var(--text-muted)",
            }}
          >
            <dt>Draw</dt>
            <dd className="mono" style={{ margin: 0, color: "var(--text)" }}>
              {drawMetrics === null
                ? "—"
                : `${drawMetrics.avgFrameMs.toFixed(2)} ms`}
            </dd>

            <dt>Dropped</dt>
            <dd className="mono" style={{ margin: 0, color: "var(--text)" }}>
              {drawMetrics === null ? "—" : drawMetrics.droppedFrames}
            </dd>

            <dt>Heap</dt>
            <dd className="mono" style={{ margin: 0, color: "var(--text)" }}>
              {heapMb !== null
                ? `${heapMb.toFixed(1)} MB`
                : heapSupported === false
                  ? "n/a"
                  : "—"}
            </dd>

            <dt title="Growth of the post-GC heap baseline">Trend</dt>
            <dd
              className="mono"
              style={{ margin: 0, color: trendOk ? GOOD : WARNING }}
            >
              {trend === null
                ? `warming up… ${Math.ceil(MIN_TREND_WINDOW_MS / 1000)}s`
                : `${trend >= 0 ? "+" : ""}${trend.toFixed(2)} MB/hr`}
            </dd>
          </dl>
          {/* Only once we know the API is genuinely absent — not merely
              before the first sample has been taken. */}
          {heapSupported === false && (
            <p
              style={{
                margin: "6px 0 0",
                color: "var(--text-muted)",
                fontSize: 11,
                maxWidth: 160,
              }}
            >
              {/* Said plainly rather than showing a fabricated number. */}
              Heap size is Chromium-only; other browsers do not expose it.
            </p>
          )}
        </>
      )}
    </aside>
  );
}
