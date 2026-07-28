import {
  DataGenerator,
  SAMPLE_INTERVAL_MS,
  categoryId,
  type GeneratorSnapshot,
} from "./dataGenerator";
import type { SeriesRingBuffer } from "./ringBuffer";
import { CATEGORIES, type Category, type DataPoint } from "./types";

/**
 * Wire format for the server-generated backfill.
 *
 * Why not just an array of `DataPoint`: 10,000 objects serialise to roughly
 * 200KB of JSON, most of it repeated 13-digit timestamps and repeated category
 * names, and all of it lands inline in the RSC flight payload — paid on every
 * request, before the page is interactive.
 *
 * The generator emits a strictly regular grid: every tick produces exactly one
 * sample per series, all sharing a timestamp, spaced by a fixed interval. So
 * the timestamp and category columns are *derivable* and only the values need
 * to cross the wire. That drops the payload by roughly 4x with no loss —
 * `hydrate` reconstructs the identical samples.
 *
 * The tradeoff is honest: this format is specific to a uniform, complete grid.
 * A real feed with gaps or per-series rates would need explicit timestamps,
 * which is why the API route can also emit plain `DataPoint` objects.
 */
export interface SerializedDataset {
  /** Epoch ms of the first tick. */
  startTime: number;
  /** Spacing between ticks, in ms. */
  intervalMs: number;
  /** Number of ticks. Total samples = tickCount * categories.length. */
  tickCount: number;
  /** Series order within each tick; index into this is the category id. */
  categories: readonly Category[];
  /** Values in tick-major order: tick0[cat0..catN], tick1[cat0..catN], … */
  values: number[];
  /** Flat indices into `values` that carry an anomaly. */
  anomalyIndices: number[];
  /** Deviation for each entry in `anomalyIndices`, same order. */
  anomalyDeviations: number[];
  /** Walk state, so the client's live ticks continue without a seam. */
  generator: GeneratorSnapshot;
}

export interface BuildDatasetOptions {
  /** Total samples across all series. Rounded down to whole ticks. */
  count?: number;
  seed?: number;
  /** Timestamp of the newest sample. Defaults to now. */
  endTime?: number;
  intervalMs?: number;
}

/**
 * Generate a backfill and pack it for transport.
 *
 * Single place that knows both the generator and the wire format, so the two
 * cannot drift apart.
 */
export function buildInitialDataset(
  options: BuildDatasetOptions = {},
): SerializedDataset {
  const {
    count = 10_000,
    seed = 0x5eed,
    endTime = Date.now(),
    intervalMs = SAMPLE_INTERVAL_MS,
  } = options;

  const generator = new DataGenerator({ seed, sampleIntervalMs: intervalMs });
  const points = generator.generateInitial(count, endTime);
  const seriesCount = CATEGORIES.length;
  const tickCount = Math.floor(points.length / seriesCount);

  const values = new Array<number>(points.length);
  const anomalyIndices: number[] = [];
  const anomalyDeviations: number[] = [];

  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    values[i] = point.value;
    const metadata = point.metadata;
    if (metadata?.anomaly === true) {
      anomalyIndices.push(i);
      anomalyDeviations.push(
        typeof metadata.deviation === "number" ? metadata.deviation : 0,
      );
    }
  }

  return {
    startTime: points.length === 0 ? endTime : points[0]!.timestamp,
    intervalMs,
    tickCount,
    categories: CATEGORIES,
    values,
    anomalyIndices,
    anomalyDeviations,
    generator: generator.snapshot(),
  };
}

/** Total samples described by a dataset. */
export function datasetSize(dataset: SerializedDataset): number {
  return dataset.tickCount * dataset.categories.length;
}

/**
 * Push a serialized dataset into a ring buffer.
 *
 * Reconstructs timestamps and categories from the grid rather than reading
 * them off the wire. Anomalies are applied by index, so the sparse metadata
 * survives the round trip.
 */
export function hydrateBuffer(
  buffer: SeriesRingBuffer,
  dataset: SerializedDataset,
): number {
  const seriesCount = dataset.categories.length;

  // Index -> deviation, so the push loop stays a single pass.
  const anomalies = new Map<number, number>();
  for (let i = 0; i < dataset.anomalyIndices.length; i++) {
    anomalies.set(
      dataset.anomalyIndices[i]!,
      dataset.anomalyDeviations[i] ?? 0,
    );
  }

  let pushed = 0;
  for (let tick = 0; tick < dataset.tickCount; tick++) {
    const timestamp = dataset.startTime + tick * dataset.intervalMs;
    for (let c = 0; c < seriesCount; c++) {
      const index = tick * seriesCount + c;
      const value = dataset.values[index];
      if (value === undefined) continue;
      const deviation = anomalies.get(index);
      buffer.push(
        timestamp,
        value,
        c,
        deviation === undefined
          ? undefined
          : { anomaly: true, deviation },
      );
      pushed++;
    }
  }
  return pushed;
}

/** Resume the walk the dataset left off at. */
export function restoreGenerator(dataset: SerializedDataset): DataGenerator {
  return DataGenerator.restore(dataset.generator);
}

/**
 * Expand to plain `DataPoint` objects.
 *
 * The verbose, self-describing shape — what an external consumer of the API
 * would expect, and what a feed with gaps would have to use.
 */
export function toDataPoints(dataset: SerializedDataset): DataPoint[] {
  const seriesCount = dataset.categories.length;
  const anomalies = new Map<number, number>();
  for (let i = 0; i < dataset.anomalyIndices.length; i++) {
    anomalies.set(dataset.anomalyIndices[i]!, dataset.anomalyDeviations[i] ?? 0);
  }

  const out: DataPoint[] = [];
  for (let tick = 0; tick < dataset.tickCount; tick++) {
    const timestamp = dataset.startTime + tick * dataset.intervalMs;
    for (let c = 0; c < seriesCount; c++) {
      const index = tick * seriesCount + c;
      const value = dataset.values[index];
      if (value === undefined) continue;
      const deviation = anomalies.get(index);
      const point: DataPoint = {
        timestamp,
        value,
        category: dataset.categories[c] ?? CATEGORIES[0],
      };
      if (deviation !== undefined) {
        point.metadata = { anomaly: true, deviation };
      }
      out.push(point);
    }
  }
  return out;
}

/** Category name -> dense id, re-exported so consumers need one import. */
export { categoryId };
