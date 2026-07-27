"use client";

import type { SeriesDescriptor } from "@/lib/series";

export interface ChartLegendProps {
  series: SeriesDescriptor[];
  /** Swatch shape should match the mark the chart actually draws. */
  mark?: "line" | "block";
  /** Shown after the swatches — used to explain a series cap. */
  note?: string;
}

/**
 * Series legend.
 *
 * Present whenever two or more series are drawn, so identity never rests on
 * colour alone — which matters here because aqua and yellow both fall below
 * 3:1 contrast on the light surface. A single series needs no legend; the
 * chart title names it.
 */
export function ChartLegend({ series, mark = "line", note }: ChartLegendProps) {
  if (series.length < 2 && note === undefined) return null;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "4px 16px",
        margin: "0 0 8px",
        fontSize: 12,
        color: "var(--text-muted)",
      }}
    >
      <ul
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "4px 16px",
          listStyle: "none",
          margin: 0,
          padding: 0,
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
                width: mark === "line" ? 12 : 9,
                height: mark === "line" ? 2 : 9,
                borderRadius: mark === "line" ? 1 : 2,
                background: s.color,
                flex: "0 0 auto",
              }}
            />
            {s.label}
          </li>
        ))}
      </ul>
      {note !== undefined && <span style={{ opacity: 0.85 }}>{note}</span>}
    </div>
  );
}
