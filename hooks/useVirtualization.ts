"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

export interface UseVirtualizationOptions {
  /** Total rows in the list. */
  itemCount: number;
  /** Fixed row height in CSS pixels. */
  itemHeight: number;
  /** Rows rendered beyond each edge, to cover fast scrolls. */
  overscan?: number;
}

export interface Virtualization<T extends HTMLElement> {
  /** Attach to the scrolling container. */
  containerRef: RefObject<T>;
  /** First rendered row, inclusive. */
  startIndex: number;
  /** Last rendered row, exclusive. */
  endIndex: number;
  /** Pixel offset of the rendered window from the top of the list. */
  offsetY: number;
  /** Full scrollable height, so the scrollbar reflects the real list. */
  totalHeight: number;
  /** True when scrolled to the very top. */
  isAtTop: boolean;
  scrollToTop: () => void;
  /**
   * Shift the scroll position by whole rows without firing a visible jump.
   * Used to hold position when rows are prepended.
   */
  shiftByRows: (rows: number) => void;
}

/**
 * Windowed list virtualization, hand-rolled.
 *
 * Renders only the rows intersecting the viewport (plus overscan) while a
 * spacer of the full list height keeps the scrollbar honest. With a 10,000-row
 * buffer that is roughly 25 DOM nodes instead of 10,000 — the difference
 * between a table that scrolls at 60fps and one that locks the main thread for
 * seconds on mount.
 *
 * Row height is fixed rather than measured. Variable heights would need a
 * measurement pass and a prefix-sum index, and every row here is one line of
 * tabular data, so the constraint costs nothing and keeps index math to
 * a division.
 *
 * State only changes when the *row window* moves. Scrolling within a single
 * row updates nothing, so a fast drag re-renders at most once per row crossed
 * rather than once per scroll event.
 */
export function useVirtualization<T extends HTMLElement>({
  itemCount,
  itemHeight,
  overscan = 6,
}: UseVirtualizationOptions): Virtualization<T> {
  const containerRef = useRef<T>(null);

  const [startIndex, setStartIndex] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [isAtTop, setIsAtTop] = useState(true);

  // Mirrors of the state, so the scroll handler can compare without re-reading
  // React state (which would be stale inside a listener registered once).
  const startIndexRef = useRef(0);
  const isAtTopRef = useRef(true);

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (el === null) return;

    const nextStart = Math.max(
      0,
      Math.floor(el.scrollTop / itemHeight) - overscan,
    );
    if (nextStart !== startIndexRef.current) {
      startIndexRef.current = nextStart;
      setStartIndex(nextStart);
    }

    // 1px of slack: browsers report fractional scrollTop at some zoom levels.
    const atTop = el.scrollTop <= 1;
    if (atTop !== isAtTopRef.current) {
      isAtTopRef.current = atTop;
      setIsAtTop(atTop);
    }
  }, [itemHeight, overscan]);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;

    // Passive: this listener never calls preventDefault, and saying so lets the
    // browser scroll without waiting on it.
    el.addEventListener("scroll", measure, { passive: true });

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const height = Math.round(entry.contentRect.height);
      setViewportHeight((prev) => (prev === height ? prev : height));
    });
    observer.observe(el);

    measure();
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure]);

  // If the list shrinks under the current scroll position, re-clamp before
  // paint so the viewport never shows a frame of empty space.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const maxScroll = Math.max(0, itemCount * itemHeight - viewportHeight);
    if (el.scrollTop > maxScroll) {
      el.scrollTop = maxScroll;
      measure();
    }
  }, [itemCount, itemHeight, viewportHeight, measure]);

  const scrollToTop = useCallback(() => {
    const el = containerRef.current;
    if (el === null) return;
    el.scrollTop = 0;
    measure();
  }, [measure]);

  const shiftByRows = useCallback(
    (rows: number) => {
      const el = containerRef.current;
      if (el === null || rows === 0) return;
      el.scrollTop += rows * itemHeight;
      measure();
    },
    [itemHeight, measure],
  );

  const visibleCount =
    viewportHeight === 0 ? 0 : Math.ceil(viewportHeight / itemHeight);
  const endIndex = Math.min(itemCount, startIndex + visibleCount + overscan * 2);

  return {
    containerRef,
    startIndex: Math.min(startIndex, Math.max(0, itemCount - 1)),
    endIndex,
    offsetY: startIndex * itemHeight,
    totalHeight: itemCount * itemHeight,
    isAtTop,
    scrollToTop,
    shiftByRows,
  };
}
