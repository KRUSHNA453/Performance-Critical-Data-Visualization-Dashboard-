import {
  aggregateBuckets,
  createBucketSet,
  ensureBucketSet,
  type BucketSet,
} from "./canvasUtils";
import type { SeriesRingBuffer } from "./ringBuffer";
import { AGGREGATION_WINDOW_MS, type AggregationWindow } from "./types";

/**
 * Time-window aggregation over the ring buffer.
 *
 * A note on what this is and is not for. Rendering 10,000 raw points was
 * already affordable — min/max decimation bounds vertex count by the plot's
 * pixel width, so the raw path costs the same whether 10,000 or 200,000
 * samples are in range. Aggregation earns its place for two other reasons:
 *
 *   - **Readability.** A zoomed-out view of raw telemetry is a noise band.
 *     Bucketed means show the trend the noise is hiding.
 *   - **Work per frame.** Buckets are cached against the buffer's revision, so
 *     the scan happens once per data tick (10Hz) instead of once per frame
 *     (60Hz) — a 6x reduction in the per-frame scan at the default rates.
 *
 * Bucket boundaries snap to absolute multiples of the bucket width, so they
 * stay put as the window scrolls rather than sliding underneath the axis, and
 * so the cache key only changes when the window actually crosses a boundary.
 */

/** Bucket width in ms for a window, or 0 for raw (no bucketing). */
export function bucketMsFor(window: AggregationWindow): number {
  return AGGREGATION_WINDOW_MS[window];
}

/** First bucket boundary at or before `t`. */
export function snapToBucket(t: number, bucketMs: number): number {
  return Math.floor(t / bucketMs) * bucketMs;
}

/**
 * Buckets needed to cover `[rangeStart, rangeEnd]`.
 *
 * floor + 1, not ceil: buckets are half-open, so the sample landing exactly on
 * `rangeEnd` needs a bucket to exist at its index.
 */
export function bucketCountFor(
  rangeStart: number,
  rangeEnd: number,
  bucketMs: number,
): number {
  return Math.max(1, Math.floor((rangeEnd - rangeStart) / bucketMs) + 1);
}

export interface AggregationResult {
  set: BucketSet;
  bucketMs: number;
  rangeStart: number;
  bucketCount: number;
  /** Samples folded on the pass that produced this result. */
  examined: number;
  /** True when this result came from cache rather than a fresh scan. */
  cached: boolean;
}

/**
 * Caches one aggregation pass, reusing it while nothing relevant has changed.
 *
 * Owned by a chart and kept in a ref, so the backing arrays are allocated once
 * and reused for the lifetime of the component.
 */
export class AggregationCache {
  private set: BucketSet;
  private key = "";
  private examined = 0;

  constructor(seriesCount: number, initialBuckets = 64) {
    this.set = createBucketSet(seriesCount, initialBuckets);
  }

  /**
   * Aggregate the visible range, or return the previous result when the
   * inputs are unchanged.
   *
   * Returns null for the raw window — callers should take their raw path.
   */
  compute(
    buffer: SeriesRingBuffer,
    window: AggregationWindow,
    rangeStartMs: number,
    rangeEndMs: number,
    visible: Uint8Array,
    seriesCount: number,
  ): AggregationResult | null {
    const bucketMs = bucketMsFor(window);
    if (bucketMs <= 0) return null;

    const rangeStart = snapToBucket(rangeStartMs, bucketMs);
    const bucketCount = bucketCountFor(rangeStart, rangeEndMs, bucketMs);

    // The mask is part of the key: hiding a series changes what was folded.
    let maskKey = 0;
    for (let i = 0; i < seriesCount; i++) {
      if (visible[i] === 1) maskKey |= 1 << i;
    }
    const key = `${buffer.revision}|${bucketMs}|${rangeStart}|${bucketCount}|${maskKey}`;

    if (key === this.key) {
      return {
        set: this.set,
        bucketMs,
        rangeStart,
        bucketCount,
        examined: this.examined,
        cached: true,
      };
    }

    this.set = ensureBucketSet(this.set, seriesCount, bucketCount);
    this.examined = aggregateBuckets(
      buffer,
      this.set,
      buffer.lowerBound(rangeStart),
      buffer.length,
      rangeStart,
      bucketMs,
      bucketCount,
      visible,
    );
    this.key = key;

    return {
      set: this.set,
      bucketMs,
      rangeStart,
      bucketCount,
      examined: this.examined,
      cached: false,
    };
  }

  /** Drop the cached pass — used when the buffer is replaced or cleared. */
  invalidate(): void {
    this.key = "";
  }
}

/**
 * How many buckets a window would produce over a given span.
 * Used by the UI to warn when a window is coarser than the data behind it.
 */
export function bucketsInSpan(
  spanMs: number,
  window: AggregationWindow,
): number {
  const bucketMs = bucketMsFor(window);
  if (bucketMs <= 0) return 0;
  return Math.max(1, Math.floor(spanMs / bucketMs));
}
