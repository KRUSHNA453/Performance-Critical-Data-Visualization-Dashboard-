import { applyMap, bucketMean, invertMap, type BucketSet, type LinearMap } from "./canvasUtils";
import type { SeriesRingBuffer } from "./ringBuffer";

/**
 * Nearest-point lookup behind the chart crosshair.
 *
 * Kept free of React and of the DOM so it can be reasoned about — and tested —
 * on its own. Nothing here allocates: the caller owns a `CrosshairReading` for
 * the component's lifetime and each resolve overwrites it in place. That is not
 * premature; a pointer at 120Hz calls this as often as the render loop draws,
 * and handing the collector a fresh object plus N sample objects per move is
 * exactly the steady drip of garbage the rest of the render path avoids.
 *
 * Both resolvers reuse the machinery that already exists: `invertMap` to go
 * from a cursor pixel back to a timestamp, and the buffer's `lowerBound`
 * binary search to land on the sample. There is deliberately no bespoke
 * nearest-point scan — a linear walk would be O(n) per pointer move against an
 * O(log n) search that is already written and already relied on by the
 * projection path.
 */

/** One series' reading at the crosshair position. */
export interface CrosshairSample {
  /** Dense category id, matching the ring buffer's category column. */
  seriesId: number;
  /** Raw sample value, or the bucket mean on the aggregated path. */
  value: number;
  /** Pixel y of `value` under the frame's current y map. */
  y: number;
  /** Whether the generator flagged this sample as a spike. Always false when aggregated. */
  anomaly: boolean;
}

/** Everything the overlay needs to draw one crosshair position. */
export interface CrosshairReading {
  /** Timestamp of the resolved sample, or the bucket midpoint when aggregated. */
  timestamp: number;
  /**
   * Pixel x to draw at — the position of the *mark*, not of the cursor. The
   * crosshair snapping to real data is what makes it a readout rather than a
   * ruler.
   */
  x: number;
  /** Entries `[0, count)` of `samples` are valid; the rest are stale. */
  count: number;
  /** Preallocated and reused. Ordered by ascending `seriesId`. */
  samples: CrosshairSample[];
  /** True when the values are bucket means rather than raw samples. */
  aggregated: boolean;
  /** Width of the bucket the values came from; 0 on the raw path. */
  bucketMs: number;
}

export function createCrosshairReading(seriesCount: number): CrosshairReading {
  const samples: CrosshairSample[] = new Array<CrosshairSample>(seriesCount);
  for (let i = 0; i < seriesCount; i++) {
    samples[i] = { seriesId: 0, value: 0, y: 0, anomaly: false };
  }
  return {
    timestamp: 0,
    x: 0,
    count: 0,
    samples,
    aggregated: false,
    bucketMs: 0,
  };
}

/**
 * Resolve the raw sample nearest `pixelX`, filling `out` with one entry per
 * visible series recorded at that timestamp.
 *
 * Every tick writes one sample per series sharing a single timestamp, so
 * "nearest point" is really "nearest tick": find the tick, then sweep the
 * equal-timestamp run to collect each series' value. The sweep is bounded by
 * the number of series, not by the buffer length.
 *
 * @returns false when nothing could be resolved — an empty buffer, or a tick
 * that holds no visible series. The caller should hide the crosshair rather
 * than draw a stale one.
 */
export function resolveRawCrosshair(
  buffer: SeriesRingBuffer,
  mask: Uint8Array,
  seriesCount: number,
  xMap: LinearMap,
  yMap: LinearMap,
  pixelX: number,
  out: CrosshairReading,
): boolean {
  const n = buffer.length;
  if (n === 0) return false;

  const t = invertMap(xMap, pixelX);
  const hi = buffer.lowerBound(t);

  // `hi` is the first sample at or after the cursor; `hi - 1` is the last one
  // before it. Pick whichever tick is closer in time, clamping at both ends so
  // a cursor past the live edge still reads the newest tick.
  let ts: number;
  if (hi >= n) {
    ts = buffer.timestampAt(n - 1);
  } else if (hi === 0) {
    ts = buffer.timestampAt(0);
  } else {
    const before = buffer.timestampAt(hi - 1);
    const after = buffer.timestampAt(hi);
    ts = t - before <= after - t ? before : after;
  }

  const capacity = out.samples.length;
  out.count = 0;
  for (let j = buffer.lowerBound(ts); j < n; j++) {
    if (buffer.timestampAt(j) !== ts) break;
    const s = buffer.categoryIdAt(j);
    if (s >= seriesCount || mask[s] !== 1) continue;
    if (out.count >= capacity) break;

    const value = buffer.valueAt(j);
    const sample = out.samples[out.count]!;
    sample.seriesId = s;
    sample.value = value;
    sample.y = applyMap(yMap, value);
    sample.anomaly = buffer.metadataAt(j)?.anomaly === true;
    out.count++;
  }
  if (out.count === 0) return false;

  out.timestamp = ts;
  out.x = applyMap(xMap, ts);
  out.aggregated = false;
  out.bucketMs = 0;
  return true;
}

/**
 * Resolve the bucket under `pixelX` from an aggregation pass the render loop
 * has already computed.
 *
 * The tooltip must report what is actually on screen. When a window is
 * aggregated the line is a series of bucket means, so reading the underlying
 * raw sample would put a number in the tooltip that appears nowhere in the
 * chart. Reading straight out of the same `BucketSet` the frame was drawn from
 * makes that mismatch impossible, and costs nothing — the pass is already
 * cached against the buffer revision.
 *
 * An empty bucket resolves to false rather than to zero, matching
 * `projectBuckets`: a gap in the data is not a reading of zero, and reporting
 * one would invent a value the instrument never produced.
 */
export function resolveBucketCrosshair(
  set: BucketSet,
  mask: Uint8Array,
  seriesCount: number,
  bucketCount: number,
  rangeStartMs: number,
  bucketMs: number,
  xMap: LinearMap,
  yMap: LinearMap,
  pixelX: number,
  out: CrosshairReading,
): boolean {
  if (bucketMs <= 0 || bucketCount <= 0) return false;

  const t = invertMap(xMap, pixelX);
  let b = Math.floor((t - rangeStartMs) / bucketMs);
  if (b < 0) b = 0;
  else if (b >= bucketCount) b = bucketCount - 1;

  const capacity = out.samples.length;
  out.count = 0;
  for (let s = 0; s < seriesCount && out.count < capacity; s++) {
    if (mask[s] !== 1) continue;
    const mean = bucketMean(set, s, b);
    if (Number.isNaN(mean)) continue; // gap, not zero

    const sample = out.samples[out.count]!;
    sample.seriesId = s;
    sample.value = mean;
    sample.y = applyMap(yMap, mean);
    // A mean is not a spike, however extreme the samples behind it were.
    sample.anomaly = false;
    out.count++;
  }
  if (out.count === 0) return false;

  // The midpoint, because that is where `projectBuckets` places the vertex.
  out.timestamp = rangeStartMs + b * bucketMs + bucketMs / 2;
  out.x = applyMap(xMap, out.timestamp);
  out.aggregated = true;
  out.bucketMs = bucketMs;
  return true;
}

/**
 * Full clock time for the tooltip, `HH:MM:SS.mmm`.
 *
 * Unlike `formatTimeTick` this does not drop precision with the visible span.
 * An axis label is read at a glance and has a neighbour to give it context; a
 * tooltip is the one place the exact timestamp of a sample is available, so it
 * shows all of it regardless of zoom.
 */
export function formatCrosshairTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const mmm = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${mmm}`;
}
