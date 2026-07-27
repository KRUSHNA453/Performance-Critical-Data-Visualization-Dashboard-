"use client";

import { bucketsInSpan } from "@/lib/aggregation";
import {
  AGGREGATION_WINDOW_LABELS,
  type AggregationWindow,
} from "@/lib/types";

const WINDOWS: AggregationWindow[] = ["raw", "1m", "5m", "1h"];

/** Below this many buckets the chart stops conveying a shape. */
const COARSE_BUCKET_THRESHOLD = 3;

export interface AggregationControlProps {
  value: AggregationWindow;
  onChange: (next: AggregationWindow) => void;
  /** Visible span in ms, used to warn when a window is coarser than the data. */
  spanMs: number;
}

/**
 * Bucket-size selector.
 *
 * Windows coarser than the visible span are still selectable — they are not
 * wrong, just uninformative — but they are marked, and the reason is stated
 * rather than left for the user to infer from a chart that looks broken.
 */
export function AggregationControl({
  value,
  onChange,
  spanMs,
}: AggregationControlProps) {
  const buckets = value === "raw" ? 0 : bucketsInSpan(spanMs, value);
  const coarse = value !== "raw" && buckets < COARSE_BUCKET_THRESHOLD;

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
        Aggregate
      </span>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {WINDOWS.map((window) => {
          const selected = value === window;
          const wouldBeCoarse =
            window !== "raw" &&
            bucketsInSpan(spanMs, window) < COARSE_BUCKET_THRESHOLD;
          return (
            <button
              key={window}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(window)}
              title={
                wouldBeCoarse
                  ? `${AGGREGATION_WINDOW_LABELS[window]} buckets are wider than the visible range`
                  : undefined
              }
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
                opacity: wouldBeCoarse && !selected ? 0.55 : 1,
              }}
            >
              {AGGREGATION_WINDOW_LABELS[window]}
            </button>
          );
        })}
      </div>

      <span
        className="mono"
        style={{ fontSize: 12, color: "var(--text-muted)" }}
      >
        {value === "raw"
          ? "every sample"
          : `${buckets} bucket${buckets === 1 ? "" : "s"} in view`}
      </span>

      {coarse && (
        <span style={{ fontSize: 12, color: "#ec835a" }}>
          {/* Icon plus words: a status colour never carries meaning alone. */}
          ▲ bucket is wider than the visible range — widen the time range or
          pick a smaller window
        </span>
      )}
    </div>
  );
}
