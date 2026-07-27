import type { Category } from "./types";

/**
 * Chart palette.
 *
 * Canvas cannot resolve `var(--x)`, so series colours have to exist as literal
 * strings in JS. They are duplicated in `globals.css` for the DOM chrome
 * (legend swatches, table accents) — this file is the source of truth.
 *
 * The categorical slots are assigned in fixed order and validated for both
 * surfaces; light mode falls below 3:1 contrast on aqua and yellow, which is
 * why the legend and direct labels are mandatory rather than optional.
 */

export type ThemeMode = "light" | "dark";

export interface ChartTheme {
  mode: ThemeMode;
  surface: string;
  grid: string;
  axis: string;
  label: string;
  text: string;
  textMuted: string;
  crosshair: string;
  series: Readonly<Record<Category, string>>;
}

const LIGHT: ChartTheme = {
  mode: "light",
  surface: "#fcfcfb",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  label: "#898781",
  text: "#0b0b0b",
  textMuted: "#52514e",
  crosshair: "rgba(11,11,11,0.35)",
  series: {
    cpu: "#2a78d6", // slot 1 blue
    memory: "#eb6834", // slot 2 orange
    disk: "#1baf7a", // slot 3 aqua
    network: "#eda100", // slot 4 yellow
  },
};

const DARK: ChartTheme = {
  mode: "dark",
  surface: "#1a1a19",
  grid: "#2c2c2a",
  axis: "#383835",
  label: "#898781",
  text: "#ffffff",
  textMuted: "#c3c2b7",
  crosshair: "rgba(255,255,255,0.35)",
  series: {
    cpu: "#3987e5",
    memory: "#d95926",
    disk: "#199e70",
    network: "#c98500",
  },
};

export const CHART_THEMES: Readonly<Record<ThemeMode, ChartTheme>> = {
  light: LIGHT,
  dark: DARK,
};

export function getChartTheme(mode: ThemeMode): ChartTheme {
  return CHART_THEMES[mode];
}

/** Axis font, sized for legibility at the small end without crowding ticks. */
export const AXIS_FONT =
  '11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/** Human-readable series names for legends and labels. */
export const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  cpu: "CPU",
  memory: "Memory",
  disk: "Disk",
  network: "Network",
};
