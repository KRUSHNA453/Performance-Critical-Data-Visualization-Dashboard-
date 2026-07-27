"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Observe an element's content-box size.
 *
 * Sizes are rounded to whole pixels and only committed when they actually
 * change: a ResizeObserver fires with sub-pixel deltas during layout settling,
 * and every commit here forces a canvas backing-store reallocation, which is
 * one of the more expensive things we can do per frame.
 */
export function useElementSize<T extends HTMLElement>(): [
  RefObject<T>,
  ElementSize,
] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  const lastRef = useRef<ElementSize>({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const box = entry.contentRect;
      const width = Math.round(box.width);
      const height = Math.round(box.height);
      const last = lastRef.current;
      if (last.width === width && last.height === height) return;
      lastRef.current = { width, height };
      setSize({ width, height });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}
