"use client";

import { useCallback, type MutableRefObject } from "react";
import type { SeriesRingBuffer } from "@/lib/ringBuffer";
import {
  resolveWindow,
  type TimeWindow,
  type ViewportState,
} from "@/lib/viewport";

/**
 * Resolve the current visible window from the buffer and the shared viewport.
 *
 * Returned as a callback rather than a value because it must be evaluated
 * inside the render loop, once per frame — a live window's right edge is the
 * clock, so any value computed during React's render pass is already stale.
 */
export function useTimeWindow(
  buffer: SeriesRingBuffer,
  viewportRef: MutableRefObject<ViewportState>,
): () => TimeWindow | null {
  return useCallback(
    () =>
      resolveWindow(
        buffer.startTime,
        buffer.endTime,
        viewportRef.current,
        Date.now(),
      ),
    [buffer, viewportRef],
  );
}
