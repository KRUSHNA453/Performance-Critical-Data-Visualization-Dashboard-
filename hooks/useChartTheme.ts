"use client";

import { useMemo } from "react";
import { getChartTheme, type ChartTheme } from "@/lib/theme";
import { useThemeMode } from "./useThemeMode";

/**
 * The resolved chart palette for the current colour scheme.
 *
 * Charts need this outside `ChartCanvas` too — to build series descriptors for
 * the legend — so it lives in its own hook rather than being threaded back out
 * of the render loop.
 */
export function useChartTheme(): ChartTheme {
  const mode = useThemeMode();
  return useMemo(() => getChartTheme(mode), [mode]);
}
