/**
 * Core domain types for the dashboard.
 *
 * Note on representation: `DataPoint` is the *logical* shape of a sample and is
 * what the generator emits and the data table consumes. It is deliberately NOT
 * how points are stored in bulk — 10,000 heap objects would blow the memory
 * budget and make every render allocation-heavy. Storage uses parallel typed
 * arrays (see `lib/ringBuffer.ts`); `DataPoint` is the boundary format.
 */

/** A single sample in a time series. */
export interface DataPoint {
  /** Epoch milliseconds. */
  timestamp: number;
  value: number;
  /** Series this sample belongs to, e.g. "cpu". */
  category: string;
  /**
   * Sparse extra context. Only attached to noteworthy samples (anomalies), so
   * the common case costs nothing.
   */
  metadata?: DataPointMetadata;
}

export interface DataPointMetadata {
  /** Set when the generator injected a spike, so the UI can flag it. */
  anomaly?: boolean;
  /** Magnitude of the spike, in the same units as `value`. */
  deviation?: number;
  [key: string]: string | number | boolean | undefined;
}

/** The four simulated series. Fixed set, so ids fit in a Uint8Array. */
export const CATEGORIES = ["cpu", "memory", "disk", "network"] as const;

export type Category = (typeof CATEGORIES)[number];

/** Category name -> dense integer id used by the ring buffer. */
export const CATEGORY_IDS: Readonly<Record<Category, number>> = {
  cpu: 0,
  memory: 1,
  disk: 2,
  network: 3,
};

export type ChartType = "line" | "bar" | "scatter" | "heatmap";

/** Half-open time window `[start, end)` in epoch milliseconds. */
export interface TimeRange {
  start: number;
  end: number;
}

/** Bucket size for downsampling. */
export type AggregationWindow = "raw" | "1m" | "5m" | "1h";

/** Bucket size in milliseconds. `raw` is 0 — no bucketing. */
export const AGGREGATION_WINDOW_MS: Readonly<
  Record<AggregationWindow, number>
> = {
  raw: 0,
  "1m": 60_000,
  "5m": 300_000,
  "1h": 3_600_000,
};

export const AGGREGATION_WINDOW_LABELS: Readonly<
  Record<AggregationWindow, string>
> = {
  raw: "Raw",
  "1m": "1 min",
  "5m": "5 min",
  "1h": "1 hour",
};

/** What the user has dialled in; drives every chart's render. */
export interface ChartConfig {
  type: ChartType;
  /** Which series are drawn. Hidden series stay in the buffer. */
  visibleCategories: ReadonlySet<Category>;
  aggregation: AggregationWindow;
  /** `null` means "follow the live edge" rather than a pinned window. */
  timeRange: TimeRange | null;
  /** Horizontal zoom factor; 1 = full extent. */
  zoom: number;
  /** Horizontal pan offset in milliseconds from the live edge. */
  panOffsetMs: number;
  /** Whether new ticks are being ingested. */
  streaming: boolean;
}

/** Rolling render statistics, sampled by the perf overlay. */
export interface PerformanceMetrics {
  /** Frames per second, averaged over the last sampling window. */
  fps: number;
  /** Mean milliseconds spent inside the draw call. */
  avgFrameMs: number;
  /** Worst draw call in the current window, in milliseconds. */
  peakFrameMs: number;
  /** Points actually rasterised on the last frame (post-decimation). */
  pointsRendered: number;
  /** Points considered before decimation. */
  pointsInBuffer: number;
  /** Frames that exceeded the 16.7ms budget in the current window. */
  droppedFrames: number;
  /** `performance.memory.usedJSHeapSize` in MB. Chromium only; null elsewhere. */
  heapUsedMb: number | null;
  /** Time from input event to the frame that reflected it, in milliseconds. */
  lastInteractionMs: number | null;
}
