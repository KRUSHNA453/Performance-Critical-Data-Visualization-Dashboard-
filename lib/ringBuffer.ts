import type { DataPoint, DataPointMetadata } from "./types";
import { CATEGORIES } from "./types";

/**
 * Fixed-capacity circular buffer for time series samples.
 *
 * Why this and not an array of objects:
 *   - Capacity is allocated once at construction and never grows. Ingesting for
 *     an hour costs exactly as much memory as ingesting for a second, which is
 *     what makes the "<1MB/hr growth" target achievable rather than aspirational.
 *   - Samples live in parallel typed arrays, so the render loop reads contiguous
 *     memory and allocates nothing per frame.
 *
 * Samples must be pushed in non-decreasing timestamp order. That invariant is
 * what lets `lowerBound` binary-search instead of scanning.
 *
 * Indexing convention: a *logical* index runs 0 .. length-1 from oldest to
 * newest. A *physical* index is the real slot in the backing arrays. Callers
 * outside this class should only ever deal in logical indices.
 */
export class SeriesRingBuffer {
  readonly capacity: number;

  private readonly ts: Float64Array;
  private readonly vals: Float64Array;
  private readonly cats: Uint8Array;
  /** Index-aligned with the typed arrays; almost always holes. */
  private readonly meta: Array<DataPointMetadata | undefined>;

  /** Physical slot the next push will write to. */
  private head = 0;
  private count = 0;

  /**
   * Bumped on every mutation. Consumers (the rAF render loop) compare this
   * against what they last drew to decide whether a redraw is needed, which
   * avoids re-rendering identical frames while the stream is paused.
   */
  revision = 0;

  /** Total samples ever pushed, including ones since overwritten. */
  totalPushed = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.ts = new Float64Array(capacity);
    this.vals = new Float64Array(capacity);
    this.cats = new Uint8Array(capacity);
    this.meta = new Array<DataPointMetadata | undefined>(capacity);
  }

  get length(): number {
    return this.count;
  }

  get isFull(): boolean {
    return this.count === this.capacity;
  }

  /**
   * Append one sample, evicting the oldest once at capacity.
   * O(1), allocation-free unless `metadata` is supplied.
   */
  push(
    timestamp: number,
    value: number,
    categoryId: number,
    metadata?: DataPointMetadata,
  ): void {
    const slot = this.head;
    this.ts[slot] = timestamp;
    this.vals[slot] = value;
    this.cats[slot] = categoryId;
    // Always assign, even when undefined — otherwise a wrapped slot would keep
    // the evicted sample's metadata and mislabel a new point as an anomaly.
    this.meta[slot] = metadata;

    this.head = slot + 1 === this.capacity ? 0 : slot + 1;
    if (this.count < this.capacity) this.count++;
    this.totalPushed++;
    this.revision++;
  }

  /** Physical slot backing logical index `i`. Caller guarantees `i` is in range. */
  private slotOf(i: number): number {
    // Oldest sample sits at `head` once wrapped, at 0 otherwise.
    const start = this.count === this.capacity ? this.head : 0;
    const s = start + i;
    return s >= this.capacity ? s - this.capacity : s;
  }

  timestampAt(i: number): number {
    return this.ts[this.slotOf(i)]!;
  }

  valueAt(i: number): number {
    return this.vals[this.slotOf(i)]!;
  }

  categoryIdAt(i: number): number {
    return this.cats[this.slotOf(i)]!;
  }

  metadataAt(i: number): DataPointMetadata | undefined {
    return this.meta[this.slotOf(i)];
  }

  /**
   * Materialise logical index `i` as a `DataPoint`.
   * Allocates — use for table rows and tooltips, never inside a render loop.
   */
  pointAt(i: number): DataPoint {
    const slot = this.slotOf(i);
    const category = CATEGORIES[this.cats[slot]!] ?? CATEGORIES[0];
    const metadata = this.meta[slot];
    const point: DataPoint = {
      timestamp: this.ts[slot]!,
      value: this.vals[slot]!,
      category,
    };
    if (metadata !== undefined) point.metadata = metadata;
    return point;
  }

  /** Oldest timestamp held, or null when empty. */
  get startTime(): number | null {
    return this.count === 0 ? null : this.timestampAt(0);
  }

  /** Newest timestamp held, or null when empty. */
  get endTime(): number | null {
    return this.count === 0 ? null : this.timestampAt(this.count - 1);
  }

  /**
   * First logical index whose timestamp is >= `t`, or `length` if none is.
   * O(log n) — relies on the non-decreasing push order.
   */
  lowerBound(t: number): number {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.timestampAt(mid) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** First logical index whose timestamp is > `t`, or `length` if none is. */
  upperBound(t: number): number {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.timestampAt(mid) <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Drop everything. Keeps the backing arrays — no reallocation. */
  clear(): void {
    this.head = 0;
    this.count = 0;
    this.meta.fill(undefined);
    this.revision++;
  }

  /** Fixed footprint of the backing arrays, in bytes (excludes metadata objects). */
  get byteLength(): number {
    return (
      this.ts.byteLength +
      this.vals.byteLength +
      this.cats.byteLength +
      // Rough: one pointer slot per capacity entry on a 64-bit runtime.
      this.capacity * 8
    );
  }
}
