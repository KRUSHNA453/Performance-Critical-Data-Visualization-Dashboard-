"use client";

import { useCallback, useRef, useState } from "react";
import { LineChart } from "@/components/charts/LineChart";
import { MetricsPanel } from "@/components/ui/MetricsPanel";
import { useDataStream } from "@/hooks/useDataStream";
import { CATEGORIES, type Category, type PerformanceMetrics } from "@/lib/types";
import { CATEGORY_LABELS } from "@/lib/theme";

export default function DashboardPage() {
  const { buffer, isStreaming, toggle, reset, getStats } = useDataStream({
    capacity: 10_000,
  });

  const [visible, setVisible] = useState<ReadonlySet<Category>>(
    () => new Set(CATEGORIES),
  );
  const [stress, setStress] = useState(false);
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);

  // Metrics arrive twice a second; committing them straight to state is fine
  // at that rate and keeps the readout honest.
  const handleMetrics = useCallback((next: PerformanceMetrics) => {
    setMetrics(next);
  }, []);

  const toggleCategory = useCallback((category: Category) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }, []);

  // Read once per render rather than per frame — these change slowly.
  const statsRef = useRef(getStats);
  statsRef.current = getStats;
  const stats = getStats();

  return (
    <main
      style={{
        maxWidth: 1100,
        margin: "0 auto",
        padding: "24px 16px 64px",
        display: "grid",
        gap: 16,
      }}
    >
      <header>
        <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>
          Line chart — {stats.size.toLocaleString("en-US")} points, live
        </h1>
        <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 13 }}>
          Canvas 2D, no chart libraries. Data ticks at 100ms; rendering runs on
          its own requestAnimationFrame loop at display rate.
        </p>
      </header>

      <section className="panel">
        <LineChart
          buffer={buffer}
          visibleCategories={visible}
          following={isStreaming}
          forceRedraw={stress}
          onMetrics={handleMetrics}
          height={360}
        />
      </section>

      <section className="panel">
        <MetricsPanel
          metrics={metrics}
          bufferSize={stats.size}
          bufferBytes={stats.bufferBytes}
        />
      </section>

      <section
        className="panel"
        style={{ display: "flex", flexWrap: "wrap", gap: 12 }}
      >
        <button type="button" onClick={toggle} style={buttonStyle}>
          {isStreaming ? "Pause stream" : "Resume stream"}
        </button>
        <button type="button" onClick={reset} style={buttonStyle}>
          Reset data
        </button>
        <button
          type="button"
          onClick={() => setStress((s) => !s)}
          style={{
            ...buttonStyle,
            borderColor: stress ? "#fab219" : "var(--border)",
            color: stress ? "#fab219" : "var(--text)",
          }}
        >
          {stress ? "Stress mode: ON" : "Stress mode: off"}
        </button>

        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "center",
            marginLeft: "auto",
          }}
        >
          {CATEGORIES.map((category) => (
            <label
              key={category}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={visible.has(category)}
                onChange={() => toggleCategory(category)}
              />
              {CATEGORY_LABELS[category]}
            </label>
          ))}
        </div>
      </section>

      <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
        Stress mode forces a redraw every frame regardless of whether anything
        changed — use it when profiling, so the numbers reflect sustained
        worst-case render load rather than the idle path.
      </p>
    </main>
  );
}

const buttonStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  padding: "6px 12px",
  fontSize: 13,
  fontFamily: "inherit",
  cursor: "pointer",
};
