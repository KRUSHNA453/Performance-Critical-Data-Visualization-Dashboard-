/**
 * The visible time window, and the operations that move it.
 *
 * Kept as pure functions over a small state object so the same logic serves
 * mouse drag, wheel zoom, pinch, and the preset buttons — and so it can be
 * tested without a browser.
 */

/** Narrowest window the user can zoom to. Below this, ticks stop being useful. */
export const MIN_SPAN_MS = 1_000;

/** Sentinel span meaning "everything in the buffer". Clamped down on resolve. */
export const SPAN_ALL = Number.MAX_SAFE_INTEGER;

export interface ViewportState {
  /** Visible span in milliseconds. */
  spanMs: number;
  /**
   * Absolute right edge in epoch ms, or `null` to track the live edge.
   *
   * `null` is what makes the chart scroll: the right edge is re-read from the
   * clock every frame. Any pan pins it to an absolute value, which is what
   * stops the scroll — that is the intended behaviour, not a side effect.
   */
  endMs: number | null;
}

export const LIVE_VIEWPORT: ViewportState = { spanMs: SPAN_ALL, endMs: null };

export interface TimeWindow {
  start: number;
  end: number;
  span: number;
  /** Span of everything currently in the buffer. */
  fullSpan: number;
  /** Whether the window is pinned to the live edge. */
  live: boolean;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Resolve a viewport against the buffer's extent and the current clock.
 *
 * Returns null when there is no data to frame.
 */
export function resolveWindow(
  bufferStart: number | null,
  bufferEnd: number | null,
  viewport: ViewportState,
  nowMs: number,
): TimeWindow | null {
  if (bufferStart === null || bufferEnd === null) return null;

  const fullSpan = Math.max(MIN_SPAN_MS, bufferEnd - bufferStart);
  const span = clamp(viewport.spanMs, MIN_SPAN_MS, fullSpan);

  const live = viewport.endMs === null;
  const desiredEnd = viewport.endMs ?? nowMs;

  // Don't let the window walk off the left end of the buffer, or past now.
  const minEnd = bufferStart + span;
  const maxEnd = Math.max(minEnd, nowMs);
  const end = clamp(desiredEnd, minEnd, maxEnd);

  return { start: end - span, end, span, fullSpan, live };
}

/** Current magnification: 1 = the whole buffer is on screen. */
export function zoomLevel(window: TimeWindow): number {
  return window.fullSpan / window.span;
}

/**
 * Zoom by `factor` (>1 zooms in) about a point `anchorFraction` across the
 * plot, keeping the timestamp under that point fixed.
 *
 * Zooming pins the window unless the anchor is effectively at the live edge —
 * otherwise the timestamp under the cursor could not stay put while the right
 * edge kept advancing.
 */
export function zoomViewport(
  viewport: ViewportState,
  bufferStart: number | null,
  bufferEnd: number | null,
  nowMs: number,
  factor: number,
  anchorFraction: number,
): ViewportState {
  const current = resolveWindow(bufferStart, bufferEnd, viewport, nowMs);
  if (current === null) return viewport;

  const f = clamp(anchorFraction, 0, 1);
  const anchorTime = current.start + f * current.span;

  const nextSpan = clamp(current.span / factor, MIN_SPAN_MS, current.fullSpan);
  const nextEnd = anchorTime + (1 - f) * nextSpan;

  // Staying live is only coherent when the anchor is at the right edge.
  const stayLive = current.live && f > 0.98;
  return { spanMs: nextSpan, endMs: stayLive ? null : nextEnd };
}

/**
 * Shift the window by `deltaMs` (positive moves toward the future).
 * Always pins the window — panning is how the user says "stop scrolling".
 */
export function panViewport(
  viewport: ViewportState,
  bufferStart: number | null,
  bufferEnd: number | null,
  nowMs: number,
  deltaMs: number,
): ViewportState {
  const current = resolveWindow(bufferStart, bufferEnd, viewport, nowMs);
  if (current === null) return viewport;
  return { spanMs: current.span, endMs: current.end + deltaMs };
}

/** Pin the window to an explicit absolute range. */
export function setWindow(start: number, end: number): ViewportState {
  const span = Math.max(MIN_SPAN_MS, end - start);
  return { spanMs: span, endMs: end };
}

/** Return to following the live edge at the given span. */
export function liveViewport(spanMs: number = SPAN_ALL): ViewportState {
  return { spanMs, endMs: null };
}

/** True when the viewport is already tracking the live edge at this span. */
export function isLiveAtSpan(viewport: ViewportState, spanMs: number): boolean {
  return viewport.endMs === null && viewport.spanMs === spanMs;
}
