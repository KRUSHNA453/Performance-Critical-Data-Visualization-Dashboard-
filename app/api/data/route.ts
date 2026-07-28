import { NextResponse, type NextRequest } from "next/server";
import { SAMPLE_INTERVAL_MS } from "@/lib/dataGenerator";
import {
  buildInitialDataset,
  datasetSize,
  toDataPoints,
} from "@/lib/serialization";

/**
 * Route handler for the simulated feed.
 *
 * The dashboard does not need this to run — it hydrates from the Server
 * Component's payload and then generates its own ticks in the browser, which
 * is what keeps a 100ms cadence from becoming 10 network round trips a second.
 * The endpoint exists so the data has a real, inspectable boundary: something
 * to curl, to point a second client at, and to swap for a genuine backend
 * without touching a line of rendering code.
 *
 * Timestamps are anchored to request time, so responses are never cacheable.
 */
export const dynamic = "force-dynamic";

/** Guard rails so a stray query string cannot ask for a million points. */
const MAX_COUNT = 100_000;
const DEFAULT_COUNT = 1_000;

function parseIntParam(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * GET /api/data
 *
 *   count    total samples across all series   (default 1000, max 100000)
 *   seed     PRNG seed
 *   endTime  epoch ms of the newest sample     (default: now)
 *   format   "compact" (default) columnar, or "points" for DataPoint objects
 *
 * On determinism: `seed` alone does not pin the output. Each series carries a
 * slow cycle evaluated against absolute timestamps, so the same seed at a
 * different wall-clock moment produces different values by design — it keeps
 * the shape stable across sessions rather than restarting at every reload.
 * Pass `endTime` as well as `seed` for a byte-identical reproducible response,
 * which is how the PERFORMANCE.md fixtures are pinned.
 *
 * "compact" mirrors what the Server Component sends the client: values only,
 * with timestamps and categories derived from a uniform grid. "points" is the
 * self-describing shape an external consumer would expect, at roughly ten
 * times the bytes.
 */
export function GET(request: NextRequest): NextResponse {
  const params = request.nextUrl.searchParams;

  const count = parseIntParam(params.get("count"), DEFAULT_COUNT, 1, MAX_COUNT);
  const seed = parseIntParam(params.get("seed"), 0x5eed, 0, 0xffffffff);
  const format = params.get("format") === "points" ? "points" : "compact";
  const endTime = parseIntParam(
    params.get("endTime"),
    Date.now(),
    0,
    Number.MAX_SAFE_INTEGER,
  );

  const dataset = buildInitialDataset({
    count,
    seed,
    endTime,
    intervalMs: SAMPLE_INTERVAL_MS,
  });

  const body =
    format === "points"
      ? {
          format: "points" as const,
          count: datasetSize(dataset),
          intervalMs: dataset.intervalMs,
          points: toDataPoints(dataset),
        }
      : {
          format: "compact" as const,
          count: datasetSize(dataset),
          dataset,
        };

  return NextResponse.json(body, {
    headers: {
      // Anchored to request time — a cached response would hand out stale
      // history that no longer meets the live edge.
      "Cache-Control": "no-store",
    },
  });
}
