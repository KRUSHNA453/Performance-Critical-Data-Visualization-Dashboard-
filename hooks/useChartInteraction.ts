"use client";

import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { DEFAULT_MARGINS } from "@/lib/canvasUtils";
import {
  liveViewport,
  panViewport,
  zoomViewport,
  type ViewportState,
} from "@/lib/viewport";

/** Wheel sensitivity. Tuned so one detent is a comfortable step, not a jump. */
const WHEEL_ZOOM_RATE = 0.0015;

/** Ignore sub-pixel pointer jitter so a click is not treated as a tiny pan. */
const DRAG_THRESHOLD_PX = 2;

/** Upper bound on how often React hears about a gesture. */
const NOTIFY_INTERVAL_MS = 100;

export interface UseChartInteractionOptions {
  /** Element that receives the gestures — the canvas. */
  targetRef: RefObject<HTMLElement>;
  /** Mutated in place; the render loop reads it every frame. */
  viewportRef: MutableRefObject<ViewportState>;
  /** Current buffer extent, read at gesture time. */
  getExtent: () => { start: number | null; end: number | null };
  /** Coalesced to one call per frame, for UI that must re-render. */
  onChange?: (viewport: ViewportState) => void;
  enabled?: boolean;
}

export interface ChartInteraction {
  /**
   * `performance.now()` of the oldest input not yet reflected on screen, or 0.
   *
   * The render loop reads this on the frame it draws, giving a true
   * input-to-pixels latency rather than a guess. Only the oldest pending input
   * is kept, so the number reports the worst case within a burst.
   */
  latencyRef: MutableRefObject<number>;
}

/**
 * Mouse, wheel and touch navigation for a time-series chart.
 *
 * The viewport lives in a ref and is mutated directly, never in React state.
 * A pointermove at 120Hz driving `setState` would re-render the tree on every
 * event and blow the 100ms interaction budget on reconciliation alone; instead
 * the gesture writes to the ref, the rAF loop reads it on the next frame, and
 * React only hears about it once per frame for the parts of the UI that
 * display the range.
 *
 * Wheel is bound natively rather than through React's `onWheel` because React
 * registers wheel listeners as passive at the root, and a passive listener
 * cannot call `preventDefault` — the page would scroll while you zoomed.
 */
export function useChartInteraction({
  targetRef,
  viewportRef,
  getExtent,
  onChange,
  enabled = true,
}: UseChartInteractionOptions): ChartInteraction {
  const latencyRef = useRef(0);

  // Read through refs so the listeners can be bound once.
  const getExtentRef = useRef(getExtent);
  getExtentRef.current = getExtent;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const el = targetRef.current;
    if (el === null || !enabled) return;

    /** Active pointers, for distinguishing drag from pinch. */
    const pointers = new Map<number, { x: number; y: number }>();
    let dragging = false;
    let lastX = 0;
    let pinchDistance = 0;
    let lastNotifyAt = 0;
    let trailingNotify: ReturnType<typeof setTimeout> | null = null;

    const markInput = () => {
      // Keep the oldest pending input so the reported latency is the worst
      // case in a burst, not the most flattering one.
      if (latencyRef.current === 0) latencyRef.current = performance.now();
    };

    /**
     * Tell React at most 10 times a second, with a trailing call so the final
     * position is never lost.
     *
     * The canvas does not need this at all — it reads the ref every frame. This
     * exists only for the DOM that displays the range, and notifying it once
     * per frame during a drag would re-render the tree 60 times a second for a
     * label that a human reads a few times a second.
     */
    const notify = () => {
      if (onChangeRef.current === undefined) return;
      const now = performance.now();
      const elapsed = now - lastNotifyAt;
      if (elapsed >= NOTIFY_INTERVAL_MS) {
        lastNotifyAt = now;
        onChangeRef.current(viewportRef.current);
        return;
      }
      if (trailingNotify !== null) return;
      trailingNotify = setTimeout(() => {
        trailingNotify = null;
        lastNotifyAt = performance.now();
        onChangeRef.current?.(viewportRef.current);
      }, NOTIFY_INTERVAL_MS - elapsed);
    };

    const plotGeometry = () => {
      const rect = el.getBoundingClientRect();
      const left = rect.left + DEFAULT_MARGINS.left;
      const width = Math.max(
        1,
        rect.width - DEFAULT_MARGINS.left - DEFAULT_MARGINS.right,
      );
      return { left, width };
    };

    const applyZoom = (factor: number, clientX: number) => {
      const { left, width } = plotGeometry();
      const extent = getExtentRef.current();
      viewportRef.current = zoomViewport(
        viewportRef.current,
        extent.start,
        extent.end,
        Date.now(),
        factor,
        (clientX - left) / width,
      );
      markInput();
      notify();
    };

    const applyPan = (deltaPx: number) => {
      const { width } = plotGeometry();
      const extent = getExtentRef.current();
      const span = viewportRef.current.spanMs;
      const fullSpan =
        extent.start !== null && extent.end !== null
          ? extent.end - extent.start
          : span;
      const visible = Math.min(span, fullSpan);
      // Dragging right walks backwards in time, like dragging a paper strip.
      viewportRef.current = panViewport(
        viewportRef.current,
        extent.start,
        extent.end,
        Date.now(),
        -(deltaPx / width) * visible,
      );
      markInput();
      notify();
    };

    const onPointerDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        dragging = false;
        lastX = e.clientX;
        el.setPointerCapture(e.pointerId);
        el.style.cursor = "grabbing";
      } else if (pointers.size === 2) {
        // Second finger down: switch from pan to pinch.
        dragging = false;
        const [a, b] = [...pointers.values()];
        if (a !== undefined && b !== undefined) {
          pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
        }
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        if (a === undefined || b === undefined) return;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDistance > 0 && distance > 0) {
          applyZoom(distance / pinchDistance, (a.x + b.x) / 2);
        }
        pinchDistance = distance;
        return;
      }

      const dx = e.clientX - lastX;
      if (!dragging && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      lastX = e.clientX;
      applyPan(dx);
    };

    const endPointer = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDistance = 0;
      if (pointers.size === 0) {
        dragging = false;
        el.style.cursor = "grab";
        if (el.hasPointerCapture(e.pointerId)) {
          el.releasePointerCapture(e.pointerId);
        }
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // deltaMode 1 is lines, 2 is pages; normalise to something pixel-ish.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      applyZoom(Math.exp(-e.deltaY * unit * WHEEL_ZOOM_RATE), e.clientX);
    };

    const onDoubleClick = () => {
      viewportRef.current = liveViewport();
      markInput();
      notify();
    };

    el.style.cursor = "grab";
    el.style.touchAction = "none"; // or the browser scrolls instead of panning

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", endPointer);
    el.addEventListener("pointercancel", endPointer);
    el.addEventListener("dblclick", onDoubleClick);
    el.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      if (trailingNotify !== null) clearTimeout(trailingNotify);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", endPointer);
      el.removeEventListener("pointercancel", endPointer);
      el.removeEventListener("dblclick", onDoubleClick);
      el.removeEventListener("wheel", onWheel);
      el.style.cursor = "";
      el.style.touchAction = "";
    };
  }, [targetRef, viewportRef, enabled]);

  return { latencyRef };
}
