"use client";

import type { PerformanceMetrics } from "@/lib/types";

/** Colour the FPS readout by how close it is to the 60fps target. */
function fpsStatus(fps: number): string {
  if (fps >= 55) return "#0ca30c"; // good
  if (fps >= 40) return "#fab219"; // warning
  return "#d03b3b"; // critical
}

export interface MetricsPanelProps {
  metrics: PerformanceMetrics | null;
  bufferSize: number;
  bufferBytes: number;
}

/**
 * Live render statistics.
 *
 * Deliberately a plain readout rather than a chart — these are five unrelated
 * scalars, and a stat row reads faster than any plot of them would.
 */
export function MetricsPanel({
  metrics,
  bufferSize,
  bufferBytes,
}: MetricsPanelProps) {
  const stats: Array<{ label: string; value: string; color?: string }> = [
    {
      label: "FPS",
      value: metrics === null ? "—" : metrics.fps.toFixed(0),
      color: metrics === null ? undefined : fpsStatus(metrics.fps),
    },
    {
      label: "Draw time",
      value: metrics === null ? "—" : `${metrics.avgFrameMs.toFixed(2)} ms`,
    },
    {
      label: "Peak draw",
      value: metrics === null ? "—" : `${metrics.peakFrameMs.toFixed(2)} ms`,
    },
    {
      label: "Dropped",
      value: metrics === null ? "—" : `${metrics.droppedFrames}`,
    },
    {
      label: "Points in view",
      value:
        metrics === null ? "—" : metrics.pointsInBuffer.toLocaleString("en-US"),
    },
    {
      label: "Vertices drawn",
      value:
        metrics === null ? "—" : metrics.pointsRendered.toLocaleString("en-US"),
    },
    {
      // Input-to-pixels, measured on the frame that consumed the gesture.
      label: "Interaction",
      value:
        metrics === null || metrics.lastInteractionMs === null
          ? "—"
          : `${metrics.lastInteractionMs.toFixed(1)} ms`,
      color:
        metrics === null || metrics.lastInteractionMs === null
          ? undefined
          : metrics.lastInteractionMs < 100
            ? "#0ca30c"
            : "#d03b3b",
    },
    { label: "Buffer", value: bufferSize.toLocaleString("en-US") },
    { label: "Buffer bytes", value: `${(bufferBytes / 1024).toFixed(0)} KiB` },
    {
      label: "JS heap",
      value:
        metrics === null || metrics.heapUsedMb === null
          ? "n/a"
          : `${metrics.heapUsedMb.toFixed(1)} MB`,
    },
  ];

  return (
    <dl
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(104px, 1fr))",
        gap: 12,
        margin: 0,
      }}
    >
      {stats.map((stat) => (
        <div key={stat.label}>
          <dt
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
          >
            {stat.label}
          </dt>
          <dd
            className="mono"
            style={{
              margin: "2px 0 0",
              fontSize: 18,
              color: stat.color ?? "var(--text)",
            }}
          >
            {stat.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
