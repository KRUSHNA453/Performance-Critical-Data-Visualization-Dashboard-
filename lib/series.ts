import { CATEGORY_LABELS, type ChartTheme } from "./theme";
import { CATEGORIES, CATEGORY_IDS, type Category } from "./types";

/** One drawable series: identity, colour and label resolved together. */
export interface SeriesDescriptor {
  category: Category;
  /** Dense id matching the ring buffer's category column. */
  id: number;
  color: string;
  label: string;
}

/**
 * Maximum series a scatter plot may show at once.
 *
 * Not arbitrary. Charts where every mark can sit beside every other mark —
 * scatter, bubble — are judged on all colour pairs rather than only adjacent
 * ones, and the categorical palette's fourth slot (yellow) fails that bar
 * against the second (orange): ΔE 4.8 under deuteranopia and 10.6 even with
 * full colour vision on the dark surface, both below the floor. The first
 * three slots pass all-pairs in both modes, so scatter caps there. Line and
 * bar charts are judged adjacent-only and can carry all four.
 */
export const SCATTER_SERIES_LIMIT = 3;

/**
 * Resolve visible categories into drawable series, in fixed palette order.
 *
 * Order is always the canonical `CATEGORIES` order, never the order the user
 * toggled them in — colour follows the entity, so hiding a series must never
 * repaint the ones that remain.
 */
export function buildSeries(
  visible: ReadonlySet<Category>,
  theme: ChartTheme,
  limit = CATEGORIES.length,
): SeriesDescriptor[] {
  const out: SeriesDescriptor[] = [];
  for (const category of CATEGORIES) {
    if (!visible.has(category)) continue;
    if (out.length >= limit) break;
    out.push({
      category,
      id: CATEGORY_IDS[category],
      color: theme.series[category],
      label: CATEGORY_LABELS[category],
    });
  }
  return out;
}

/** Per-series visibility mask indexed by category id, for hot loops. */
export function seriesMask(series: SeriesDescriptor[]): Uint8Array {
  const mask = new Uint8Array(CATEGORIES.length);
  for (const s of series) mask[s.id] = 1;
  return mask;
}
