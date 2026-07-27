import type { SeriesRingBuffer } from "./ringBuffer";

/**
 * Canvas drawing primitives shared by every chart.
 *
 * Everything in the per-frame path is written to avoid allocation: vertex
 * buffers are pooled and reused, scales are plain numbers rather than closures,
 * and the inner loops read straight out of typed arrays. Allocating inside the
 * render loop is what turns a smooth 60fps into periodic GC stutter, and that
 * stutter is exactly what the assignment's frame-time target measures.
 */

/** Padding between the canvas edge and the plot area, in CSS pixels. */
export interface PlotMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The right margin is a gutter for direct series labels, not padding. Drawing
 * labels inside the plot puts text on top of the lines it is naming, which is
 * both unreadable and clipped at the edge.
 */
export const DEFAULT_MARGINS: PlotMargins = {
  top: 12,
  right: 62,
  bottom: 28,
  left: 44,
};

/** The drawable region, in CSS pixels, after margins are removed. */
export interface PlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function computePlotRect(
  cssWidth: number,
  cssHeight: number,
  margins: PlotMargins,
): PlotRect {
  return {
    x: margins.left,
    y: margins.top,
    width: Math.max(0, cssWidth - margins.left - margins.right),
    height: Math.max(0, cssHeight - margins.top - margins.bottom),
  };
}

/**
 * Size the canvas backing store for the current device pixel ratio and set a
 * transform so all drawing can be expressed in CSS pixels.
 *
 * Returns true when the backing store was actually resized. Callers should
 * treat that as "the canvas was cleared, redraw everything" — assigning to
 * width/height resets the bitmap even if the value is unchanged, which is why
 * this guards before writing.
 */
export function resizeCanvas(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): boolean {
  // Cap DPR: a 3x backing store on a phone triples fill cost for a difference
  // nobody can see on a 1px line.
  const ratio = Math.min(dpr, 2);
  const targetW = Math.max(1, Math.round(cssWidth * ratio));
  const targetH = Math.max(1, Math.round(cssHeight * ratio));

  if (canvas.width === targetW && canvas.height === targetH) return false;

  canvas.width = targetW;
  canvas.height = targetH;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return true;
}

/** Reset the whole canvas to `background`, or to transparent if omitted. */
export function clearCanvas(
  ctx: CanvasRenderingContext2D,
  cssWidth: number,
  cssHeight: number,
  background?: string,
): void {
  if (background === undefined) {
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    return;
  }
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, cssWidth, cssHeight);
}

/* ------------------------------------------------------------------ *
 * Coordinate mapping
 * ------------------------------------------------------------------ */

/**
 * An affine data->pixel map, flattened to two numbers.
 *
 * Deliberately not a closure: `px = value * scale + offset` gets inlined by the
 * JIT inside a hot loop, whereas a megamorphic `scale(v)` call does not.
 */
export interface LinearMap {
  scale: number;
  offset: number;
}

/** Map domain `[d0, d1]` onto pixel range `[p0, p1]`. */
export function linearMap(
  d0: number,
  d1: number,
  p0: number,
  p1: number,
): LinearMap {
  const span = d1 - d0;
  // A zero-width domain would divide by zero; pin it to the range start.
  if (span === 0) return { scale: 0, offset: p0 };
  const scale = (p1 - p0) / span;
  return { scale, offset: p0 - d0 * scale };
}

export function applyMap(m: LinearMap, value: number): number {
  return value * m.scale + m.offset;
}

/** Pixel back to data space — used by hit-testing and pan/zoom. */
export function invertMap(m: LinearMap, pixel: number): number {
  if (m.scale === 0) return 0;
  return (pixel - m.offset) / m.scale;
}

/* ------------------------------------------------------------------ *
 * Vertex projection with min/max decimation
 * ------------------------------------------------------------------ */

/**
 * Upper bound on concurrent series. Fixed so the projection scratch below can
 * be allocated once at module load instead of per call.
 */
export const MAX_SERIES = 8;

/** Sentinel for "no column folded yet" — outside any real pixel coordinate. */
const COLUMN_NONE = -2147483648;

/*
 * Per-series accumulators for the column currently being folded by
 * `projectSeries`. Module-scope and reused across calls: allocating five typed
 * arrays per frame is only a few hundred bytes, but at 60fps that is a steady
 * drip of garbage for no benefit. `projectSeries` resets them on entry, so
 * reuse is safe. Not reentrant — projection is single-threaded on the main
 * thread by construction.
 */
const scratchCol = new Int32Array(MAX_SERIES);
const scratchMin = new Float64Array(MAX_SERIES);
const scratchMax = new Float64Array(MAX_SERIES);
const scratchMinFirst = new Uint8Array(MAX_SERIES);
const scratchSeen = new Uint8Array(MAX_SERIES);

/** Pooled, reusable vertex storage for one series. */
export interface VertexBuffer {
  xs: Float32Array;
  ys: Float32Array;
  count: number;
}

export function createVertexBuffer(capacity: number): VertexBuffer {
  return {
    xs: new Float32Array(capacity),
    ys: new Float32Array(capacity),
    count: 0,
  };
}

/**
 * Grow a pooled buffer only when the plot got wider. Shrinking would just churn
 * allocations during a resize drag.
 */
export function ensureVertexCapacity(
  buffer: VertexBuffer,
  capacity: number,
): VertexBuffer {
  if (buffer.xs.length >= capacity) return buffer;
  return createVertexBuffer(capacity);
}

/**
 * Vertices needed per series for a plot `pixelWidth` wide. Two per column
 * (the min and the max), plus slack for the partial column at each end.
 */
export function vertexCapacityFor(pixelWidth: number): number {
  return Math.max(64, Math.ceil(pixelWidth) * 2 + 8);
}

/**
 * Project a time range of the ring buffer into per-series pixel vertices,
 * decimating to at most two vertices per pixel column.
 *
 * This is the single most important optimisation in the project. Without it,
 * a 10,000-point buffer issues 10,000 `lineTo` calls per frame; with it, the
 * vertex count is bounded by the plot's pixel width no matter how much data is
 * in range — so 10,000 points and 1,000,000 points cost the same to draw. The
 * min/max pair per column preserves the visual envelope, so the decimated line
 * is not just fast but indistinguishable from the full-resolution one: any
 * spike tall enough to see is by definition the min or max of its column.
 *
 * Emits the column's min and max in the order they actually occurred, which
 * keeps the polyline's left-to-right continuity intact.
 *
 * One pass over the buffer services every series at once — iterating per series
 * would multiply the scan cost by the series count for no benefit.
 *
 * @returns the number of source points examined.
 */
export function projectSeries(
  buffer: SeriesRingBuffer,
  seriesCount: number,
  startIndex: number,
  endIndex: number,
  xMap: LinearMap,
  yMap: LinearMap,
  out: VertexBuffer[],
): number {
  if (seriesCount > MAX_SERIES) {
    throw new RangeError(
      `projectSeries supports at most ${MAX_SERIES} series, got ${seriesCount}`,
    );
  }

  for (let s = 0; s < seriesCount; s++) {
    const vb = out[s];
    if (vb !== undefined) vb.count = 0;
    // Module-scope scratch is reused across calls, so it must be reset here
    // rather than relying on fresh zeroed arrays.
    scratchCol[s] = COLUMN_NONE;
    scratchSeen[s] = 0;
  }

  const xScale = xMap.scale;
  const xOffset = xMap.offset;
  const yScale = yMap.scale;
  const yOffset = yMap.offset;

  let examined = 0;
  for (let i = startIndex; i < endIndex; i++) {
    const s = buffer.categoryIdAt(i);
    if (s >= seriesCount) continue;
    const vb = out[s];
    if (vb === undefined) continue; // series hidden — skip without projecting

    examined++;
    const px = buffer.timestampAt(i) * xScale + xOffset;
    const py = buffer.valueAt(i) * yScale + yOffset;
    // Round to whole columns so decimation buckets align with real pixels.
    const col = px | 0;

    if (scratchCol[s] !== col) {
      flushColumn(s, vb);
      scratchCol[s] = col;
      scratchMin[s] = py;
      scratchMax[s] = py;
      scratchMinFirst[s] = 1;
      scratchSeen[s] = 1;
    } else {
      if (py < scratchMin[s]!) {
        scratchMin[s] = py;
        scratchMinFirst[s] = 0; // the max was encountered first
      } else if (py > scratchMax[s]!) {
        scratchMax[s] = py;
        scratchMinFirst[s] = 1;
      }
    }
  }

  // Emit the trailing partial column for each series.
  for (let s = 0; s < seriesCount; s++) {
    const vb = out[s];
    if (vb !== undefined) flushColumn(s, vb);
  }
  return examined;
}

/**
 * Emit the folded column for series `s` into `vb`.
 *
 * A module-level function rather than a closure over `projectSeries` locals:
 * a closure would be allocated on every call, which at 60fps is exactly the
 * kind of steady drip of garbage this module exists to avoid.
 */
function flushColumn(s: number, vb: VertexBuffer): void {
  if (scratchSeen[s] === 0) return;
  const cap = vb.xs.length;
  const x = scratchCol[s]!;
  const lo = scratchMin[s]!;
  const hi = scratchMax[s]!;

  if (lo === hi) {
    if (vb.count < cap) {
      vb.xs[vb.count] = x;
      vb.ys[vb.count] = lo;
      vb.count++;
    }
  } else if (vb.count + 1 < cap) {
    // Temporal order matters: emitting max-then-min for a falling column would
    // zig-zag the polyline backwards through the column.
    const first = scratchMinFirst[s] === 1 ? lo : hi;
    const second = scratchMinFirst[s] === 1 ? hi : lo;
    vb.xs[vb.count] = x;
    vb.ys[vb.count] = first;
    vb.count++;
    vb.xs[vb.count] = x;
    vb.ys[vb.count] = second;
    vb.count++;
  }
  scratchSeen[s] = 0;
}

/** Stroke a pooled vertex buffer as one polyline. */
export function drawPolyline(
  ctx: CanvasRenderingContext2D,
  vb: VertexBuffer,
  color: string,
  lineWidth = 2,
): void {
  if (vb.count === 0) return;
  ctx.beginPath();
  ctx.moveTo(vb.xs[0]!, vb.ys[0]!);
  for (let i = 1; i < vb.count; i++) {
    ctx.lineTo(vb.xs[i]!, vb.ys[i]!);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
}

/* ------------------------------------------------------------------ *
 * Time-bucket aggregation (shared by BarChart, and the basis for the
 * 1min/5min/1hour aggregation windows)
 * ------------------------------------------------------------------ */

/**
 * Per-series, per-bucket accumulators in flat typed arrays.
 * Indexed `series * bucketCount + bucket` so a whole series is contiguous.
 */
export interface BucketSet {
  seriesCount: number;
  bucketCount: number;
  sums: Float64Array;
  counts: Uint32Array;
  mins: Float64Array;
  maxs: Float64Array;
}

export function createBucketSet(
  seriesCount: number,
  bucketCount: number,
): BucketSet {
  const size = seriesCount * bucketCount;
  return {
    seriesCount,
    bucketCount,
    sums: new Float64Array(size),
    counts: new Uint32Array(size),
    mins: new Float64Array(size),
    maxs: new Float64Array(size),
  };
}

/** Reallocate only when the shape grew; otherwise reuse in place. */
export function ensureBucketSet(
  set: BucketSet,
  seriesCount: number,
  bucketCount: number,
): BucketSet {
  if (set.seriesCount >= seriesCount && set.bucketCount >= bucketCount) {
    return set;
  }
  return createBucketSet(
    Math.max(set.seriesCount, seriesCount),
    Math.max(set.bucketCount, bucketCount),
  );
}

/**
 * Fold a time range into fixed-width buckets, one pass over the buffer.
 *
 * `visible` is a per-series mask; hidden series are skipped before any
 * arithmetic. Returns the number of samples folded.
 *
 * Buckets are half-open `[lo, lo + bucketMs)`. `bucketCount` must therefore be
 * `floor((rangeEnd - rangeStartMs) / bucketMs) + 1` to give the sample sitting
 * exactly on the range end somewhere to land — sizing it with `ceil` drops
 * that sample whenever the span divides evenly.
 */
export function aggregateBuckets(
  buffer: SeriesRingBuffer,
  set: BucketSet,
  startIndex: number,
  endIndex: number,
  rangeStartMs: number,
  bucketMs: number,
  bucketCount: number,
  visible: Uint8Array,
): number {
  const stride = set.bucketCount;
  // Only clear the region actually in use — the pool may be much larger.
  for (let s = 0; s < set.seriesCount; s++) {
    const base = s * stride;
    set.sums.fill(0, base, base + bucketCount);
    set.counts.fill(0, base, base + bucketCount);
  }

  if (bucketMs <= 0) return 0;

  let examined = 0;
  for (let i = startIndex; i < endIndex; i++) {
    const s = buffer.categoryIdAt(i);
    if (s >= set.seriesCount || visible[s] === 0) continue;

    const bucket = ((buffer.timestampAt(i) - rangeStartMs) / bucketMs) | 0;
    if (bucket < 0 || bucket >= bucketCount) continue;

    const value = buffer.valueAt(i);
    const idx = s * stride + bucket;
    if (set.counts[idx] === 0) {
      set.mins[idx] = value;
      set.maxs[idx] = value;
    } else {
      if (value < set.mins[idx]!) set.mins[idx] = value;
      else if (value > set.maxs[idx]!) set.maxs[idx] = value;
    }
    set.sums[idx]! += value;
    set.counts[idx]!++;
    examined++;
  }
  return examined;
}

/** Mean of a bucket, or NaN when the bucket is empty. */
export function bucketMean(set: BucketSet, series: number, bucket: number): number {
  const idx = series * set.bucketCount + bucket;
  const n = set.counts[idx]!;
  return n === 0 ? NaN : set.sums[idx]! / n;
}

/**
 * Project bucket means into per-series pixel vertices, one vertex per
 * non-empty bucket, positioned at the bucket's midpoint.
 *
 * The aggregated counterpart to `projectSeries`. Empty buckets are skipped
 * rather than drawn as zero — a gap in the data is not a reading of zero, and
 * plotting it as one would invent a value the instrument never reported.
 *
 * @returns total vertices written across all series.
 */
export function projectBuckets(
  set: BucketSet,
  seriesCount: number,
  bucketCount: number,
  rangeStartMs: number,
  bucketMs: number,
  xMap: LinearMap,
  yMap: LinearMap,
  out: Array<VertexBuffer | undefined>,
): number {
  const halfBucket = bucketMs / 2;
  let total = 0;

  for (let s = 0; s < seriesCount; s++) {
    const vb = out[s];
    if (vb === undefined) continue;
    vb.count = 0;

    const capacity = vb.xs.length;
    const base = s * set.bucketCount;
    for (let b = 0; b < bucketCount && vb.count < capacity; b++) {
      const idx = base + b;
      const n = set.counts[idx]!;
      if (n === 0) continue; // gap, not zero

      const mean = set.sums[idx]! / n;
      const t = rangeStartMs + b * bucketMs + halfBucket;
      vb.xs[vb.count] = t * xMap.scale + xMap.offset;
      vb.ys[vb.count] = mean * yMap.scale + yMap.offset;
      vb.count++;
    }
    total += vb.count;
  }
  return total;
}

/* ------------------------------------------------------------------ *
 * Bars
 * ------------------------------------------------------------------ */

/**
 * Add a bar to the current path with its data-end rounded and its baseline
 * end square, so the bar reads as anchored to the axis rather than floating.
 *
 * Adds to the path rather than filling, so a whole series batches into one
 * `fill()` call instead of one per bar.
 */
export function addBarToPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 4,
): void {
  if (height <= 0 || width <= 0) return;
  const r = Math.min(radius, width / 2, height);
  ctx.moveTo(x, y + height);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height);
  ctx.closePath();
}

/* ------------------------------------------------------------------ *
 * Scatter: pixel de-duplication
 * ------------------------------------------------------------------ */

/**
 * Occupancy grid that avoids overdrawing marks onto pixels already covered.
 *
 * Uses a monotonically increasing stamp instead of clearing: a cell counts as
 * occupied when its stamp equals the current one, so starting a new pass is a
 * single increment rather than a memset of the whole grid. At 60fps across
 * several series that difference is most of the cost of the technique.
 */
export interface StampGrid {
  cols: number;
  rows: number;
  /** Cell size in CSS pixels. */
  cell: number;
  stamps: Uint32Array;
  current: number;
}

export function createStampGrid(
  cols: number,
  rows: number,
  cell: number,
): StampGrid {
  return {
    cols,
    rows,
    cell,
    stamps: new Uint32Array(Math.max(1, cols * rows)),
    current: 0,
  };
}

export function ensureStampGrid(
  grid: StampGrid,
  plotWidth: number,
  plotHeight: number,
  cell: number,
): StampGrid {
  const cols = Math.max(1, Math.ceil(plotWidth / cell) + 1);
  const rows = Math.max(1, Math.ceil(plotHeight / cell) + 1);
  if (grid.cell === cell && grid.cols >= cols && grid.rows >= rows) return grid;
  return createStampGrid(Math.max(grid.cols, cols), Math.max(grid.rows, rows), cell);
}

/** Begin a new de-duplication pass. */
export function beginStampPass(grid: StampGrid): void {
  grid.current++;
  // Wrapping would make stale cells look current; reset on overflow.
  if (grid.current === 0xffffffff) {
    grid.stamps.fill(0);
    grid.current = 1;
  }
}

/* ------------------------------------------------------------------ *
 * Scatter marks
 * ------------------------------------------------------------------ */

/**
 * Draw one series as square marks, skipping marks that would land on an
 * already-covered cell.
 *
 * Every mark is added to a single path and filled once. Issuing `fillRect`
 * per point costs a separate rasteriser call each time; batching 10,000 marks
 * into one `fill()` is roughly an order of magnitude cheaper, and is what
 * keeps a dense scatter inside the frame budget.
 *
 * @returns the number of marks actually drawn after de-duplication.
 */
export function drawPointsBatched(
  ctx: CanvasRenderingContext2D,
  buffer: SeriesRingBuffer,
  seriesId: number,
  startIndex: number,
  endIndex: number,
  xMap: LinearMap,
  yMap: LinearMap,
  rect: PlotRect,
  color: string,
  markSize: number,
  grid: StampGrid,
): number {
  const xScale = xMap.scale;
  const xOffset = xMap.offset;
  const yScale = yMap.scale;
  const yOffset = yMap.offset;
  const half = markSize / 2;
  const cell = grid.cell;
  const cols = grid.cols;
  const stamps = grid.stamps;
  const stamp = grid.current;

  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

  let drawn = 0;
  ctx.beginPath();
  for (let i = startIndex; i < endIndex; i++) {
    if (buffer.categoryIdAt(i) !== seriesId) continue;

    const px = buffer.timestampAt(i) * xScale + xOffset;
    if (px < left || px > right) continue;
    const py = buffer.valueAt(i) * yScale + yOffset;
    if (py < top || py > bottom) continue;

    const col = ((px - left) / cell) | 0;
    const row = ((py - top) / cell) | 0;
    const cellIndex = row * cols + col;
    if (stamps[cellIndex] === stamp) continue; // already covered
    stamps[cellIndex] = stamp;

    ctx.rect(px - half, py - half, markSize, markSize);
    drawn++;
  }
  ctx.fillStyle = color;
  ctx.fill();
  return drawn;
}

/* ------------------------------------------------------------------ *
 * Axes and ticks
 * ------------------------------------------------------------------ */

/** Round `span / count` to a 1/2/5 x 10^n step so tick labels read cleanly. */
export function niceStep(span: number, targetCount: number): number {
  if (span <= 0 || targetCount <= 0) return 1;
  const rough = span / targetCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / magnitude;
  let nice: number;
  if (normalized < 1.5) nice = 1;
  else if (normalized < 3) nice = 2;
  else if (normalized < 7) nice = 5;
  else nice = 10;
  return nice * magnitude;
}

/** Tick values covering `[min, max]` at a nice step. Allocates — not per-frame hot. */
export function linearTicks(
  min: number,
  max: number,
  targetCount: number,
): number[] {
  const step = niceStep(max - min, targetCount);
  const first = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  // Guard against a pathological step producing an unbounded loop.
  for (let v = first, guard = 0; v <= max && guard < 1000; v += step, guard++) {
    // Re-round to kill floating point drift like 0.30000000000000004.
    ticks.push(Math.round(v / step) * step);
  }
  return ticks;
}

/** Human-scale time steps, in milliseconds. */
const TIME_STEPS_MS = [
  100, 250, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000,
  300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000,
  43_200_000, 86_400_000,
];

/**
 * Smallest human-scale interval that divides `spanMs` into at most
 * `targetCount` pieces. Shared by time axes and bar bucketing so tick
 * boundaries and bucket boundaries line up.
 */
export function niceTimeStep(spanMs: number, targetCount: number): number {
  const rough = spanMs / Math.max(1, targetCount);
  for (const candidate of TIME_STEPS_MS) {
    if (candidate >= rough) return candidate;
  }
  return TIME_STEPS_MS[TIME_STEPS_MS.length - 1]!;
}

/** Tick timestamps across `[startMs, endMs]`, snapped to a readable interval. */
export function timeTicks(
  startMs: number,
  endMs: number,
  targetCount: number,
): number[] {
  const span = endMs - startMs;
  if (span <= 0) return [];
  const step = niceTimeStep(span, targetCount);
  const first = Math.ceil(startMs / step) * step;
  const ticks: number[] = [];
  for (let t = first, guard = 0; t <= endMs && guard < 1000; t += step, guard++) {
    ticks.push(t);
  }
  return ticks;
}

/** Clock label whose precision matches the visible span. */
export function formatTimeTick(ms: number, spanMs: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  if (spanMs < 10_000) {
    return `${mm}:${ss}.${String(Math.floor(d.getMilliseconds() / 100))}`;
  }
  if (spanMs < 3_600_000) return `${mm}:${ss}`;
  return `${hh}:${mm}`;
}

/** Trim trailing zeros so axis labels stay short. */
export function formatValueTick(value: number, step: number): string {
  const decimals = step < 1 ? Math.min(3, Math.ceil(-Math.log10(step))) : 0;
  return value.toFixed(decimals);
}

export interface AxisTheme {
  grid: string;
  axis: string;
  label: string;
  font: string;
}

/**
 * Horizontal gridlines plus the y-axis labels.
 *
 * Gridlines land on the half-pixel so a 1px hairline renders as one crisp line
 * rather than two grey ones.
 */
export function drawYAxis(
  ctx: CanvasRenderingContext2D,
  rect: PlotRect,
  ticks: number[],
  yMap: LinearMap,
  step: number,
  theme: AxisTheme,
): void {
  ctx.save();
  ctx.font = theme.font;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.strokeStyle = theme.grid;
  for (const t of ticks) {
    const y = Math.round(applyMap(yMap, t)) + 0.5;
    ctx.moveTo(rect.x, y);
    ctx.lineTo(rect.x + rect.width, y);
  }
  ctx.stroke();

  ctx.fillStyle = theme.label;
  for (const t of ticks) {
    const y = applyMap(yMap, t);
    ctx.fillText(formatValueTick(t, step), rect.x - 8, y);
  }
  ctx.restore();
}

/** X-axis baseline and time labels. */
export function drawXAxis(
  ctx: CanvasRenderingContext2D,
  rect: PlotRect,
  ticks: number[],
  xMap: LinearMap,
  spanMs: number,
  theme: AxisTheme,
): void {
  ctx.save();
  ctx.font = theme.font;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineWidth = 1;

  const baselineY = Math.round(rect.y + rect.height) + 0.5;
  ctx.beginPath();
  ctx.strokeStyle = theme.axis;
  ctx.moveTo(rect.x, baselineY);
  ctx.lineTo(rect.x + rect.width, baselineY);
  ctx.stroke();

  ctx.fillStyle = theme.label;
  for (const t of ticks) {
    const x = applyMap(xMap, t);
    // Drop labels that would be clipped by the plot edge.
    if (x < rect.x - 1 || x > rect.x + rect.width + 1) continue;
    ctx.fillText(formatTimeTick(t, spanMs), x, rect.y + rect.height + 6);
  }
  ctx.restore();
}

/** Confine subsequent drawing to the plot area. Caller must `ctx.restore()`. */
export function clipToPlot(
  ctx: CanvasRenderingContext2D,
  rect: PlotRect,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
}
