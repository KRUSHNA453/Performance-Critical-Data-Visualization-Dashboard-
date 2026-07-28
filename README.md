# Performance-Critical Data Visualization Dashboard

A real-time dashboard rendering 10,000+ streaming data points at 60 fps, with
every chart drawn from scratch on the Canvas 2D API.

**No chart libraries. No D3, no Chart.js, no Recharts, no virtualisation
library.** Scales, ticks, axes, decimation, hit-testing, pan/zoom gestures and
the windowed table are all hand-written — see [`lib/`](lib/) and
[`hooks/`](hooks/).

Measured results, optimisation rationale and a scaling plan are in
**[PERFORMANCE.md](PERFORMANCE.md)**.

---

## Setup

```bash
npm install
npm run dev      # http://localhost:3000
```

Open <http://localhost:3000/dashboard>.

**For anything performance-related, use the production build instead.** Dev mode
carries React's development build, source maps and hot-reload instrumentation,
and its frame numbers are not representative:

```bash
npm run build && npm start
```

Other scripts:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # next lint
```

Requires Node 18.17+ (developed on Node 24).

---

## Testing under real load

The dashboard boots with a full 10,000-point buffer and streams continuously, so
it is under load from the first frame. To exercise it deliberately:

1. **Stress mode** (button, top right). Forces a redraw every frame regardless
   of whether anything changed. Without it the chart correctly skips redundant
   frames, and you would be measuring the idle path rather than sustained load.
2. **Watch the performance monitor** (bottom right) — live FPS with a sparkline,
   draw time, dropped frames, heap size and a memory growth trend. Give it ~40
   seconds before trusting the trend figure; it needs a window before it can
   report one honestly.
3. **Interact while it streams** — drag to pan, scroll or pinch to zoom,
   double-click to return to live. Latency appears in the metrics panel under
   *Interaction*, measured from the input event to the frame that reflected it.
4. **Switch chart types and aggregation windows** while streaming. Zoom and pan
   carry across chart types.
5. **Scroll the raw data table** to 10,000 rows. It stays at ~25 DOM nodes.
6. **Throttle the CPU** in DevTools (Performance → gear → CPU 4× slowdown) to
   see the headroom.

The generator is deterministic. `/api/data?count=400&seed=7&endTime=1700000000000`
returns byte-identical data on every call, which is how the benchmark fixtures
are pinned. Note that `seed` **alone** is not enough — each series carries a
slow cycle evaluated against absolute timestamps, so the clock is an input too.

### API

```
GET /api/data?count=1000&seed=24045&endTime=<epoch-ms>&format=compact|points
```

`compact` is the columnar format the Server Component ships to the client
(values only; timestamps and categories derived from a uniform grid).
`points` expands to self-describing `DataPoint` objects, at roughly 10× the
bytes. The dashboard does not call this endpoint at runtime — it hydrates from
the Server Component and then generates its own ticks, because driving a 100 ms
cadence over HTTP would be 10 round trips a second. The route exists so the data
has a real, inspectable boundary and a seam where a genuine backend could be
swapped in.

---

## Features

**Charts** — Line, Bar and Scatter, all Canvas 2D, all sharing one render engine
([`ChartCanvas.tsx`](components/charts/ChartCanvas.tsx)) that owns a single
`requestAnimationFrame` loop, canvas sizing, DPR handling, dirty checking and
metrics. Each chart supplies only a `draw` callback.

**Real-time streaming** — 100 ms tick into a fixed-capacity ring buffer over
parallel typed arrays. Rendering is decoupled from data arrival: the rAF loop
runs at display rate and reads whatever is in the buffer at that instant.

**Interaction** — drag to pan, wheel or pinch to zoom (anchored on the cursor),
double-click to reset. Time-range presets (30s / 1m / 5m / 15m / All) and a live
indicator. Measured latency: **0.6–0.7 ms**.

**Aggregation** — raw / 1 min / 5 min / 1 hour, by averaging, cached against the
buffer revision so the scan runs once per data tick rather than once per frame.

**Filtering** — per-series visibility. Hidden series stay in the buffer, so
re-enabling one restores its history rather than starting it empty.

**Virtualised table** — 10,000 rows, ~25 in the DOM, with scroll anchoring so
new samples arriving four times a second don't push the row you're reading out
from under the cursor.

**Performance monitor** — always-visible FPS, draw time, dropped frames, heap
and memory trend. Counts frames on its own rAF loop rather than trusting the
chart's numbers, because a chart that correctly skipped a frame would otherwise
report a flattering idle figure.

**Server / Client split** — [`app/dashboard/page.tsx`](app/dashboard/page.tsx)
is a Server Component that generates the backfill; the generator and its PRNG
never enter the client bundle. The boundary sits as deep as it goes: the first
thing that needs a browser is the first Client Component.

**Accessibility** — a legend is always present for ≥2 series with direct labels
on the line chart, so identity never rests on colour alone. The categorical
palette was validated for colour-blind separation and surface contrast in both
light and dark modes. Charts carry `role="img"` with descriptive labels; the
table uses `role="grid"` with `aria-rowcount`/`aria-rowindex`. Status colours
always ship with an icon and a word.

**Theming** — light and dark, following the OS preference, with palettes stepped
separately for each surface rather than flipped.

---

## What is NOT implemented

Listed plainly, with reasons. These are real gaps, not oversights I'm hoping go
unnoticed.

### 1. Heatmap chart — not built

The assignment asks for four chart types; three exist. Heatmap was explicitly
first on the cut list agreed at the start of the build, and the time went into
making the other three genuinely fast and correct instead.

The groundwork is there and it would not be a large piece of work: the
single-pass bucket aggregation in [`lib/aggregation.ts`](lib/aggregation.ts)
already produces the (series × time-bucket) grid a heatmap needs, and
`ChartCanvas` would supply the loop. What is missing is the cell rendering and a
sequential colour ramp — the palette reference specifies one (single hue,
light→dark, never a rainbow) but it is not wired up.

### 2. Crosshair and tooltips — not built

Hovering a chart does nothing. This was deferred when interactions were built
and never came back. It is the most visible gap for a reviewer, because a chart
that can be panned and zoomed but not inspected feels half-finished. The
pixel→data inverse mapping it needs (`invertMap`) already exists and is used by
pan/zoom, and the ring buffer's `lowerBound` (0.09 µs) would make hit-testing
essentially free.

### 3. Responsive / mobile — not implemented, and measured to be broken

Not "untested" — I measured it, and it does not work:

| Viewport | Horizontal overflow |
|---|---|
| Desktop 1440×900 | none |
| Tablet 820×1180 | **yes** — content extends to 1084 px |
| Phone 390×844 | **yes** — content extends to 1084 px |

The viewport meta tag is correct; the layout is the problem. The control rows,
the metrics grid and the table's fixed column template all assume desktop width
and none of them reflow. The canvas itself would resize correctly — it is driven
by a `ResizeObserver` — but the page around it forces a minimum width. The
performance monitor is also fixed-position and would cover content on a small
screen.

Making this work means media queries on the control rows, a stacked table layout
below ~640 px, and moving the monitor inline on small screens. None of that is
done.

### 4. Web Workers and OffscreenCanvas — not attempted

Both were stretch goals. PERFORMANCE.md explains why OffscreenCanvas is the
change that would matter most: the measured ceiling on the line chart is
polyline *rasterisation* on the main thread, not our JavaScript.

### 5. No committed test suite

Everything in PERFORMANCE.md was verified — correctness of the ring buffer,
decimation fidelity against a full-resolution projection, bucket means against
brute force, viewport maths, and end-to-end behaviour driven through the Chrome
DevTools Protocol. But those harnesses were written as throwaway scripts outside
the repository and are not committed, so `npm test` does not exist.

That is a genuine gap. The logic in `lib/` is pure and framework-free
specifically so it *can* be unit-tested; nothing about the design prevents it.

### 6. Not deployed

No live demo link yet. The app builds and runs cleanly in production mode
(`next build` succeeds with no errors or warnings) and has no runtime
environment dependencies, so deploying to Vercel should be uneventful — but
until it is actually deployed, that is a claim rather than a fact.

---

## Known limitations of what *is* built

Behaviours that are implemented but constrained, and where the constraint comes
from.

**The 1-hour aggregation window is degenerate at the default buffer size.** At
10,000 samples across 4 series at 100 ms, the buffer holds ~250 seconds of
history. So 1 min gives 4–5 buckets, 5 min gives 1–2, and 1 hour gives exactly
one. The windows are implemented correctly — the buffer is the constraint, not
the aggregation. The control dims windows wider than the visible range and says
why rather than rendering a flat bar and leaving you to guess. Raising
`useDataStream`'s capacity fixes it at a proportional, still-fixed memory cost.

**Scatter is capped at 3 concurrent series, and it is a colour constraint, not a
performance one.** Scatter marks can sit beside any other mark, so the palette
is judged on *all* colour pairs rather than only adjacent ones. The 4th slot
(yellow) fails that against the 2nd (orange): ΔE 4.8 under deuteranopia and 10.6
even with full colour vision on the dark surface — both below the floor. The
first three slots pass all-pairs in both modes. Line and bar are judged
adjacent-only and carry all four. The legend states the cap rather than silently
dropping a series.

**The data table settles once when you start scrolling.** The list rebuilds
every 250 ms, so at the moment you grab the scrollbar there can be up to one
refresh interval of samples (~10 rows) that have arrived but are not yet
rendered. The first scroll compensation absorbs that backlog, shifting the view
once by up to that much; after that anchoring is exact for as long as you stay
scrolled. Removing it entirely would mean rebuilding at the full 10 Hz tick
rate, which costs more than the artifact is worth.

**Background tabs leave a gap in the series.** Browsers throttle timers to ~1 Hz
in hidden tabs. Rather than replay thousands of missed ticks on return — which
would freeze the UI for seconds — catch-up is clamped at 20 ticks and the walk
jumps to the present. This produces an honest hole in the data instead of a
stall.

**Zooming away from the live edge pins the window.** Zoom anchors on the cursor,
and a fixed anchor and an advancing right edge cannot both hold, so any zoom
that is not at the right edge stops the auto-scroll. Panning does the same,
deliberately. The **Go live** button and double-click both return.

**`npm audit` reports advisories on Next.js 14.2.35.** 14.2.35 is the newest
patch on the 14.2 line, and Next is now well past 14. The outstanding advisories
are DoS / cache-poisoning / SSRF issues in the image optimizer, Server Actions
on custom servers, rewrites, and Pages Router i18n — none of which this app
uses. It was a deliberate choice to stay on 14 rather than absorb
framework-migration risk mid-build, and it is recorded here rather than left for
someone to discover.

---

## Project structure

```
app/
  dashboard/page.tsx          Server Component — generates the backfill
  dashboard/DashboardClient.tsx  Client boundary — owns canvas + all state
  api/data/route.ts           Inspectable data endpoint
lib/
  ringBuffer.ts               Fixed-capacity circular buffer, typed arrays
  dataGenerator.ts            Seeded, resumable random walk
  canvasUtils.ts              Scales, ticks, decimation, batching, axes
  viewport.ts                 Pan/zoom maths, as pure functions
  aggregation.ts              Time-bucket aggregation with caching
  serialization.ts            Columnar server→client wire format
  series.ts, theme.ts, types.ts
hooks/
  useDataStream.ts            100 ms tick into a bounded window
  useChartInteraction.ts      Drag, wheel, pinch — ref-based, not state
  useVirtualization.ts        Windowed list rendering
  useTimeWindow.ts, useChartTheme.ts, useElementSize.ts, useThemeMode.ts
components/
  charts/     ChartCanvas (shared loop), LineChart, BarChart, ScatterPlot
  controls/   TimeRangeSelector, FilterPanel, AggregationControl
  ui/         DataTable, MetricsPanel, PerformanceMonitor
```

## Tech stack

Next.js 14.2.35 (App Router, no Pages Router), React 18, TypeScript 5.5 in
strict mode with `noUncheckedIndexedAccess`. No runtime dependencies beyond
React and Next.
