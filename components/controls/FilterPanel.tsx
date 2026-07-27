"use client";

import { useChartTheme } from "@/hooks/useChartTheme";
import { CATEGORY_LABELS } from "@/lib/theme";
import { CATEGORIES, type Category } from "@/lib/types";

export interface FilterPanelProps {
  visible: ReadonlySet<Category>;
  onChange: (next: ReadonlySet<Category>) => void;
  /** Streaming controls, grouped here so all chart inputs sit in one row. */
  isStreaming: boolean;
  onToggleStream: () => void;
  onReset: () => void;
}

/**
 * Series visibility and stream controls.
 *
 * Hidden series stay in the ring buffer — filtering changes what is drawn, not
 * what is retained, so re-enabling a series brings its history back rather
 * than starting it from empty.
 *
 * Colour follows the entity: the swatch for a series is fixed by its slot in
 * the palette, so hiding one never repaints the others.
 */
export function FilterPanel({
  visible,
  onChange,
  isStreaming,
  onToggleStream,
  onReset,
}: FilterPanelProps) {
  const theme = useChartTheme();

  const toggle = (category: Category) => {
    const next = new Set(visible);
    if (next.has(category)) next.delete(category);
    else next.add(category);
    onChange(next);
  };

  const allOn = visible.size === CATEGORIES.length;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 12,
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
        Series
      </span>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {CATEGORIES.map((category) => (
          <label
            key={category}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              cursor: "pointer",
              // Dim rather than hide, so the set of series stays legible.
              opacity: visible.has(category) ? 1 : 0.5,
            }}
          >
            <input
              type="checkbox"
              checked={visible.has(category)}
              onChange={() => toggle(category)}
            />
            <span
              aria-hidden
              style={{
                width: 9,
                height: 9,
                borderRadius: 2,
                background: theme.series[category],
                flex: "0 0 auto",
              }}
            />
            {CATEGORY_LABELS[category]}
          </label>
        ))}
      </div>

      <button
        type="button"
        onClick={() => onChange(allOn ? new Set() : new Set(CATEGORIES))}
        style={ghostButton}
      >
        {allOn ? "Hide all" : "Show all"}
      </button>

      <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
        <button type="button" onClick={onToggleStream} style={ghostButton}>
          {isStreaming ? "Pause stream" : "Resume stream"}
        </button>
        <button type="button" onClick={onReset} style={ghostButton}>
          Reset data
        </button>
      </div>
    </div>
  );
}

const ghostButton: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  padding: "4px 10px",
  fontSize: 12,
  fontFamily: "inherit",
  cursor: "pointer",
};
