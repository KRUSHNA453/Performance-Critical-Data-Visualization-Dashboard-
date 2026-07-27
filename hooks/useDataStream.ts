"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DataGenerator,
  SAMPLE_INTERVAL_MS,
  categoryId,
} from "@/lib/dataGenerator";
import { SeriesRingBuffer } from "@/lib/ringBuffer";

/** Default sliding-window size, in total samples across all series. */
export const DEFAULT_CAPACITY = 10_000;

/**
 * Most ticks we will replay in one catch-up pass. Background tabs get their
 * timers throttled to ~1Hz, so returning to a tab that sat hidden for ten
 * minutes would otherwise try to synthesise 6,000 ticks in a single frame and
 * freeze the UI — exactly the failure mode we are trying to avoid.
 */
const MAX_CATCHUP_TICKS = 20;

export interface UseDataStreamOptions {
  /** Sliding-window size. Memory is allocated once for this many samples. */
  capacity?: number;
  /** Tick cadence in milliseconds. */
  intervalMs?: number;
  /** PRNG seed — same seed replays the same dataset. */
  seed?: number;
  /** Begin ticking on mount. */
  autoStart?: boolean;
  /** Backfill the buffer to capacity before the first tick. */
  backfill?: boolean;
}

export interface DataStreamStats {
  /** Samples currently held. */
  size: number;
  capacity: number;
  /** Samples ever ingested, including evicted ones. */
  totalIngested: number;
  /** Ticks skipped by catch-up clamping — visible as gaps in the series. */
  skippedTicks: number;
  /** Fixed footprint of the ring buffer's backing arrays, in bytes. */
  bufferBytes: number;
}

export interface UseDataStreamResult {
  /**
   * The live buffer. This object identity is stable for the lifetime of the
   * hook — it is mutated in place, never replaced. Read it from a rAF loop and
   * watch `buffer.revision` to detect changes.
   */
  buffer: SeriesRingBuffer;
  isStreaming: boolean;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  /** Wipe the buffer and restart the walk from the original seed. */
  reset: () => void;
  /**
   * Register a callback fired after each tick. Returns an unsubscribe fn.
   * Fires at the tick rate (10Hz by default) — throttle before setting state.
   */
  subscribe: (listener: () => void) => () => void;
  getStats: () => DataStreamStats;
}

/**
 * Simulated real-time data stream over a bounded sliding window.
 *
 * The important property: **this hook does not re-render on tick.** Pushing a
 * sample mutates a pre-allocated ring buffer and notifies subscribers directly.
 * Re-rendering React ten times a second — and handing every consumer a freshly
 * copied 10,000-element array each time — is the single easiest way to miss the
 * 60fps target, so the data path deliberately bypasses React state. React state
 * here only tracks streaming on/off, which changes at human speed.
 */
export function useDataStream(
  options: UseDataStreamOptions = {},
): UseDataStreamResult {
  const {
    capacity = DEFAULT_CAPACITY,
    intervalMs = SAMPLE_INTERVAL_MS,
    seed = 0x5eed,
    autoStart = true,
    backfill = true,
  } = options;

  // Lazily constructed once, then stable for the hook's lifetime.
  const bufferRef = useRef<SeriesRingBuffer | null>(null);
  if (bufferRef.current === null) {
    bufferRef.current = new SeriesRingBuffer(capacity);
  }
  const buffer = bufferRef.current;

  const generatorRef = useRef<DataGenerator | null>(null);
  if (generatorRef.current === null) {
    generatorRef.current = new DataGenerator({
      seed,
      sampleIntervalMs: intervalMs,
    });
  }

  const listenersRef = useRef(new Set<() => void>());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seededRef = useRef(false);
  const skippedTicksRef = useRef(0);

  const [isStreaming, setIsStreaming] = useState(autoStart);

  const notify = useCallback(() => {
    for (const listener of listenersRef.current) listener();
  }, []);

  const subscribe = useCallback((listener: () => void) => {
    const listeners = listenersRef.current;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  /** Seed the buffer with history so the first frame already renders at scale. */
  const fill = useCallback(() => {
    const generator = generatorRef.current!;
    const points = generator.generateInitial(capacity);
    // Backfill can exceed capacity; the ring buffer evicts as it goes, leaving
    // exactly the newest `capacity` samples.
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      buffer.push(p.timestamp, p.value, categoryId(p.category), p.metadata);
    }
  }, [buffer, capacity]);

  useEffect(() => {
    // Ref guard rather than an empty-deps assumption: React StrictMode mounts
    // effects twice in development, and backfilling twice would double-advance
    // the walk.
    if (seededRef.current) return;
    seededRef.current = true;
    if (backfill) {
      fill();
      notify();
    }
  }, [backfill, fill, notify]);

  useEffect(() => {
    if (!isStreaming) return;

    const generator = generatorRef.current!;

    const tick = () => {
      const now = Date.now();
      const last = generator.lastTimestamp;

      // How many whole intervals should have elapsed since the last sample.
      let steps = last === 0 ? 1 : Math.floor((now - last) / intervalMs);
      if (steps < 1) return; // timer fired early; nothing owed yet

      if (steps > MAX_CATCHUP_TICKS) {
        // Too far behind to replay. Jump the walk to now and accept a gap —
        // an honest hole in the series beats a multi-second freeze.
        skippedTicksRef.current += steps - 1;
        const points = generator.nextTick(now);
        for (let i = 0; i < points.length; i++) {
          const p = points[i]!;
          buffer.push(p.timestamp, p.value, categoryId(p.category), p.metadata);
        }
        notify();
        return;
      }

      for (let s = 0; s < steps; s++) {
        const points = generator.nextTick();
        for (let i = 0; i < points.length; i++) {
          const p = points[i]!;
          buffer.push(p.timestamp, p.value, categoryId(p.category), p.metadata);
        }
      }
      notify();
    };

    timerRef.current = setInterval(tick, intervalMs);
    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isStreaming, intervalMs, buffer, notify]);

  const start = useCallback(() => setIsStreaming(true), []);
  const stop = useCallback(() => setIsStreaming(false), []);
  const toggle = useCallback(() => setIsStreaming((s) => !s), []);

  const reset = useCallback(() => {
    buffer.clear();
    generatorRef.current = new DataGenerator({
      seed,
      sampleIntervalMs: intervalMs,
    });
    skippedTicksRef.current = 0;
    if (backfill) fill();
    notify();
  }, [buffer, seed, intervalMs, backfill, fill, notify]);

  const getStats = useCallback(
    (): DataStreamStats => ({
      size: buffer.length,
      capacity: buffer.capacity,
      totalIngested: buffer.totalPushed,
      skippedTicks: skippedTicksRef.current,
      bufferBytes: buffer.byteLength,
    }),
    [buffer],
  );

  // Drop listeners on unmount so a stale closure can't retain the buffer.
  useEffect(() => {
    const listeners = listenersRef.current;
    return () => {
      listeners.clear();
    };
  }, []);

  return {
    buffer,
    isStreaming,
    start,
    stop,
    toggle,
    reset,
    subscribe,
    getStats,
  };
}
