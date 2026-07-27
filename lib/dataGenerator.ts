import {
  CATEGORIES,
  CATEGORY_IDS,
  type Category,
  type DataPoint,
  type DataPointMetadata,
} from "./types";

/** Live tick cadence, and therefore the spacing of generated samples. */
export const SAMPLE_INTERVAL_MS = 100;

/**
 * mulberry32 — small, fast, seedable PRNG with a good enough distribution for
 * simulated telemetry. Seeding matters here: the same seed replays the exact
 * same dataset, which is what makes performance numbers in PERFORMANCE.md
 * comparable between runs.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shape of one simulated series. */
interface SeriesProfile {
  /** Level the series is pulled back toward. */
  base: number;
  /** Per-step standard deviation of the noise term. */
  volatility: number;
  /** How hard the series reverts to `base`, per step. 0 = pure random walk. */
  reversion: number;
  /** Amplitude of the slow cycle layered on top of `base`. */
  cycleAmplitude: number;
  /** Period of that slow cycle, in milliseconds. */
  cyclePeriodMs: number;
  /** Per-step probability of a spike. */
  spikeChance: number;
  /** Peak size of a spike, in series units. */
  spikeMagnitude: number;
}

/**
 * Four series chosen to look like host telemetry and to exercise different
 * render characteristics: a jittery one, a slow-drifting one, a bursty one,
 * and a high-variance one.
 */
const PROFILES: Readonly<Record<Category, SeriesProfile>> = {
  // Busy but mean-reverting — the "normal" line.
  cpu: {
    base: 46,
    volatility: 2.1,
    reversion: 0.035,
    cycleAmplitude: 12,
    cyclePeriodMs: 1_200_000,
    spikeChance: 0.004,
    spikeMagnitude: 26,
  },
  // Slow ramps and plateaus; barely any high-frequency noise.
  memory: {
    base: 63,
    volatility: 0.55,
    reversion: 0.006,
    cycleAmplitude: 8,
    cyclePeriodMs: 2_700_000,
    spikeChance: 0.0008,
    spikeMagnitude: 11,
  },
  // Mostly idle, punctuated by IO bursts.
  disk: {
    base: 21,
    volatility: 1.3,
    reversion: 0.05,
    cycleAmplitude: 5,
    cyclePeriodMs: 900_000,
    spikeChance: 0.009,
    spikeMagnitude: 42,
  },
  // Wide swings, weak reversion.
  network: {
    base: 54,
    volatility: 3.4,
    reversion: 0.018,
    cycleAmplitude: 15,
    cyclePeriodMs: 1_800_000,
    spikeChance: 0.005,
    spikeMagnitude: 29,
  },
};

const VALUE_MIN = 0;
const VALUE_MAX = 100;

export interface DataGeneratorOptions {
  seed?: number;
  sampleIntervalMs?: number;
}

/**
 * Continuous random-walk source for all four series.
 *
 * The walk is stateful and shared between backfill and live ticks: whatever
 * `generateInitial` leaves the series at is exactly where `nextTick` picks up,
 * so there is no visible discontinuity where history meets the live edge.
 */
export class DataGenerator {
  private readonly rng: () => number;
  private readonly sampleIntervalMs: number;
  /** Current level of each series, indexed by category id. */
  private readonly levels: Float64Array;
  /** Cached second value from Box–Muller; NaN when empty. */
  private spareGaussian = NaN;

  private lastTimestampMs: number;

  constructor(options: DataGeneratorOptions = {}) {
    const { seed = 0x5eed, sampleIntervalMs = SAMPLE_INTERVAL_MS } = options;
    this.rng = mulberry32(seed);
    this.sampleIntervalMs = sampleIntervalMs;
    this.levels = new Float64Array(CATEGORIES.length);
    for (let i = 0; i < CATEGORIES.length; i++) {
      const category = CATEGORIES[i]!;
      // Start a little off-base so the opening frames already have shape.
      this.levels[i] = PROFILES[category].base + this.gaussian() * 3;
    }
    this.lastTimestampMs = 0;
  }

  /** Standard normal via Box–Muller, generating two at a time. */
  private gaussian(): number {
    if (!Number.isNaN(this.spareGaussian)) {
      const spare = this.spareGaussian;
      this.spareGaussian = NaN;
      return spare;
    }
    // Guard against log(0).
    let u = this.rng();
    while (u === 0) u = this.rng();
    const v = this.rng();
    const mag = Math.sqrt(-2 * Math.log(u));
    this.spareGaussian = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  }

  /** Advance one series by one step and return the new value. */
  private step(categoryId: number, timestamp: number): {
    value: number;
    metadata?: DataPointMetadata;
  } {
    const category = CATEGORIES[categoryId]!;
    const p = PROFILES[category];

    // Slow cycle keeps the chart from looking like undifferentiated noise.
    const cycle =
      p.cycleAmplitude * Math.sin((2 * Math.PI * timestamp) / p.cyclePeriodMs);
    const target = p.base + cycle;

    let value = this.levels[categoryId]!;
    value += p.reversion * (target - value) + p.volatility * this.gaussian();

    let metadata: DataPointMetadata | undefined;
    if (this.rng() < p.spikeChance) {
      const direction = this.rng() < 0.5 ? -1 : 1;
      const deviation =
        direction * p.spikeMagnitude * (0.5 + this.rng() * 0.5);
      value += deviation;
      metadata = { anomaly: true, deviation: round2(deviation) };
    }

    // Clamp, and write the clamped value back so the walk cannot wander off
    // and then take thousands of steps to come home.
    if (value < VALUE_MIN) value = VALUE_MIN;
    else if (value > VALUE_MAX) value = VALUE_MAX;
    this.levels[categoryId] = value;

    return metadata === undefined
      ? { value: round2(value) }
      : { value: round2(value), metadata };
  }

  /** Newest timestamp this generator has produced. */
  get lastTimestamp(): number {
    return this.lastTimestampMs;
  }

  /**
   * Backfill `count` points ending at `endTime`, walked forward in time so the
   * series arrive at their live state naturally.
   *
   * `count` is a total across all series, so 10,000 points at four series is
   * 2,500 ticks — roughly four minutes of history at a 100ms cadence.
   */
  generateInitial(count: number, endTime: number = Date.now()): DataPoint[] {
    const seriesCount = CATEGORIES.length;
    const ticks = Math.max(1, Math.floor(count / seriesCount));
    const startTime = endTime - (ticks - 1) * this.sampleIntervalMs;

    const points: DataPoint[] = new Array<DataPoint>(ticks * seriesCount);
    let w = 0;

    for (let t = 0; t < ticks; t++) {
      const timestamp = startTime + t * this.sampleIntervalMs;
      for (let c = 0; c < seriesCount; c++) {
        const { value, metadata } = this.step(c, timestamp);
        const point: DataPoint = {
          timestamp,
          value,
          category: CATEGORIES[c]!,
        };
        if (metadata !== undefined) point.metadata = metadata;
        points[w++] = point;
      }
    }

    this.lastTimestampMs = startTime + (ticks - 1) * this.sampleIntervalMs;
    return points;
  }

  /**
   * Produce the next tick: one sample per series, sharing a timestamp,
   * continuing the same walk `generateInitial` left off at.
   *
   * Pass `timestamp` to pin to wall-clock; otherwise the tick lands exactly one
   * sample interval after the previous one, which keeps spacing uniform even
   * when the browser fires the interval late.
   */
  nextTick(timestamp?: number): DataPoint[] {
    const ts = timestamp ?? this.lastTimestampMs + this.sampleIntervalMs;
    this.lastTimestampMs = ts;

    const out: DataPoint[] = new Array<DataPoint>(CATEGORIES.length);
    for (let c = 0; c < CATEGORIES.length; c++) {
      const { value, metadata } = this.step(c, ts);
      const point: DataPoint = { timestamp: ts, value, category: CATEGORIES[c]! };
      if (metadata !== undefined) point.metadata = metadata;
      out[c] = point;
    }
    return out;
  }
}

/** Convenience factory. */
export function createDataGenerator(
  options: DataGeneratorOptions = {},
): DataGenerator {
  return new DataGenerator(options);
}

/** Category name -> id, falling back to 0 for unknown names. */
export function categoryId(category: string): number {
  return CATEGORY_IDS[category as Category] ?? 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
