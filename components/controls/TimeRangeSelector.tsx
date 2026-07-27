"use client";

import {
  SPAN_ALL,
  isLiveAtSpan,
  liveViewport,
  zoomLevel,
  type TimeWindow,
  type ViewportState,
} from "@/lib/viewport";

const PRESETS: Array<{ label: string; spanMs: number }> = [
  { label: "30s", spanMs: 30_000 },
  { label: "1m", spanMs: 60_000 },
  { label: "5m", spanMs: 300_000 },
  { label: "15m", spanMs: 900_000 },
  { label: "All", spanMs: SPAN_ALL },
];

function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function formatSpan(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export interface TimeRangeSelectorProps {
  viewport: ViewportState;
  /** Resolved window, for the readout. Null before any data arrives. */
  window: TimeWindow | null;
  onChange: (viewport: ViewportState) => void;
}

/**
 * Preset time ranges plus a readout of the current window.
 *
 * Presets return the chart to following the live edge at a fixed span, which
 * is also how the user escapes a pan — panning deliberately pins the window,
 * and "Live" is the way back.
 */
export function TimeRangeSelector({
  viewport,
  window: timeWindow,
  onChange,
}: TimeRangeSelectorProps) {
  const live = timeWindow?.live ?? true;
  const magnification = timeWindow === null ? 1 : zoomLevel(timeWindow);

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          color: "var(--text-muted)",
        }}
      >
        Range
      </span>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {PRESETS.map((preset) => {
          const selected = isLiveAtSpan(viewport, preset.spanMs);
          return (
            <button
              key={preset.label}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(liveViewport(preset.spanMs))}
              style={{
                background: "transparent",
                border: "1px solid",
                borderColor: selected ? "var(--series-cpu)" : "var(--border)",
                color: selected ? "var(--series-cpu)" : "var(--text)",
                fontWeight: selected ? 600 : 400,
                borderRadius: 6,
                padding: "4px 10px",
                fontSize: 12,
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => onChange(liveViewport(viewport.spanMs))}
        disabled={live}
        style={{
          background: "transparent",
          border: "1px solid",
          borderColor: live ? "var(--border)" : "#0ca30c",
          color: live ? "var(--text-muted)" : "#0ca30c",
          borderRadius: 6,
          padding: "4px 10px",
          fontSize: 12,
          fontFamily: "inherit",
          cursor: live ? "default" : "pointer",
          opacity: live ? 0.6 : 1,
        }}
      >
        {/* Dot plus the word, so state is never carried by colour alone. */}
        {live ? "● Live" : "○ Go live"}
      </button>

      {timeWindow !== null && (
        <span
          className="mono"
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginLeft: "auto",
          }}
        >
          {formatClock(timeWindow.start)} → {formatClock(timeWindow.end)} ·{" "}
          {formatSpan(timeWindow.span)} · {magnification.toFixed(1)}×
        </span>
      )}
    </div>
  );
}
