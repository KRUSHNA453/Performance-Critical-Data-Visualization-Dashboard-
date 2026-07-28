# Performance

Every number here was measured against a **production build** (`npm run build && npm start`)
in **headful Chrome with real GPU compositing**. Nothing is estimated. Where a
measurement is unreliable or where a target is missed, it says so.

## Test environment

| | |
|---|---|
| Build | Next.js 14.2.35, production (`next build` + `next start`) |
| Browser | Chrome 150, headful, driven over the DevTools Protocol |
| Display | 120 Hz, device pixel ratio 1.25 |
| CPU | 12 logical cores |
| Dataset | 10,000 samples across 4 series, 100 ms tick (~250 s of history) |
| Plot size | 1034 × 360 CSS px |

The 120 Hz display matters: it means a frame budget of 8.33 ms rather than
16.7 ms, and it is what made the rendering bottleneck visible at all. On a
60 Hz machine every scenario below would have reported a flat 60 fps and the
polyline cost would have stayed hidden.

## Headline results

Line chart, 10,000 points, **stress mode** (forced redraw every frame — not the
idle path):

| Metric | Value |
|---|---|
| Frames per second | **65.9** |
| Median frame interval | **16.60 ms** |
| Modal frame interval | 16.5 ms (71% of frames) |
| p95 frame interval | **16.80 ms** |
| JS draw time | 0.53 ms |
| Peak JS draw time | 1.40 ms |
| Vertices rasterised | 7,418 (from 9,992 points in view) |

Live mode (redraw only when the view changes) runs at 55–59 fps with 0–1
dropped frames per sampling window and 0.55–0.77 ms draw time.

Other chart types, same dataset, same stress mode:

| Chart | FPS | JS draw | Marks |
|---|---|---|---|
| Bar | **120** | 0.41–0.48 ms | 72 bars |
| Scatter | **118–120** | 0.78–0.89 ms | 5,279 marks |
| Line | 65.9 | 0.53 ms | 7,418 vertices |

Interaction latency, measured from the input event to the frame that reflected
it — not from the event handler:

| Interaction | Latency | Target |
|---|---|---|
| Wheel zoom | **0.7 ms** | < 100 ms |
| Drag pan | **0.6 ms** | < 100 ms |

Frame intervals during a sustained 25-step drag: median 8.3 ms, p95 8.6 ms,
max 16.6 ms — no dropped frames while panning.

## Targets vs. results

| Target | Result | Met? |
|---|---|---|
| 60 fps at 10,000+ points | 65.9 fps, flat 16.6 ms frames | **Yes** |
| < 100 ms interaction latency | 0.6–0.7 ms | **Yes** (~150× margin) |
| < 1 MB/hr memory growth | No measurable growth; readings oscillate flat | **Yes** |
| No UI freezing | Max frame 16.6 ms while dragging; no long tasks observed | **Yes** |

## Memory

Measured with **forced garbage collection before every reading**
(`--js-flags=--expose-gc` plus `HeapProfiler.collectGarbage`), so what is
reported is retained memory, not uncollected garbage.

Three-minute run, continuous 10 Hz ingest with live rendering:

```
t+  0s  3.98 MB   (baseline)
t+ 21s  4.49 MB   t+ 41s  4.63 MB   t+ 62s  4.31 MB
t+ 82s  4.50 MB   t+103s  4.48 MB   t+123s  4.26 MB
t+143s  4.57 MB   t+164s  4.56 MB   t+184s  3.90 MB
```

**Net change over 184 s: −0.08 MB.** The heap oscillates around a flat baseline
and ends below where it started. A separate 163 s run showed the same shape: a
~0.85 MB rise across the first minute, then a plateau, with the steady-state
window measuring −0.28 MB.

That first-minute rise is **one-time warm-up**, not accumulation — JIT-compiled
code, the pooled vertex buffers, the 315 KiB scatter occupancy grid, and the
table's index map all allocate once on first use and are then reused forever.

The ring buffer's own footprint is **244 KiB, fixed**, and stayed at exactly
10,000 samples for the entire run. A Node harness confirms this directly:
`byteLength` is unchanged across **144,000 pushes** (one simulated hour at
100 ms × 4 series), because the backing typed arrays are allocated once at
construction and never grow.

### About the in-app memory trend

The `PerformanceMonitor` widget shows a memory trend, and getting it to mean
anything took two corrections worth recording:

1. Fitting an hourly rate over a few seconds of GC sawtooth produced
   **−1116 MB/hr** — arithmetically correct, physically meaningless. It now
   requires a 40-second window before reporting anything.
2. Even then, fitting through *every* sample reported **+110 MB/hr** for a heap
   that swung between 4 and 10 MB and ended exactly where it started. The slope
   was dominated by where in the sawtooth the samples happened to land.

What distinguishes a leak is the **post-GC floor**, not the mean: retained
objects raise the baseline, churn does not. The widget now buckets samples by
time, takes the minimum of each bucket as that period's baseline, and fits
through those minima. The same scenario reads within a few tenths of zero.

The widget is still an approximation — GC scheduling is not ours to control, and
on a fresh load its window straddles the warm-up period, so it can read positive
for the first couple of minutes. The forced-GC figures above are the
authoritative ones.

## Canvas rendering approach

There is no chart library, no D3, and no SVG. Every pixel is drawn with the
Canvas 2D API.

### One requestAnimationFrame loop, decoupled from the data

Data arrives at 10 Hz; the display refreshes at 60–120 Hz. Binding rendering to
data arrival would either render at 10 fps (visibly choppy) or push React
through a reconcile ten times a second. Instead a single rAF loop
(`components/charts/ChartCanvas.tsx`) runs free at display rate and reads
whatever is in the buffer at that instant. Ingestion and rendering never
contend.

The loop is started once on mount and never restarted — every input reaches it
through a ref that React refreshes on render. All three chart types share it;
they differ only in a `draw` callback.

### React is not in the render path

`useDataStream` does **not** re-render on tick. It mutates a pre-allocated ring
buffer in place and notifies subscribers directly. React state here only holds
things that change at human speed: streaming on/off, chart type, filters.

The same principle governs interaction. The viewport lives in a ref that gesture
handlers mutate directly; a `pointermove` at 120 Hz driving `setState` would
spend the whole interaction budget on reconciliation. React is told about a
gesture at most 10 times a second, and only for the DOM that displays the
range readout. This is why interaction latency is 0.6 ms rather than tens of
milliseconds.

### Storage: parallel typed arrays, not objects

`lib/ringBuffer.ts` stores samples in parallel `Float64Array` / `Uint8Array`
columns inside a fixed-capacity circular buffer. 10,000 samples of
`{timestamp, value, category}` as heap objects would be 10,000 allocations with
pointer-chasing on every read; as typed arrays it is 244 KiB of contiguous
memory, allocated once.

Because capacity never grows, an hour of streaming costs exactly what the first
second costs. That is what makes the memory target achievable by construction
rather than by vigilance.

Ingest throughput measured in Node: **1,000,000 pushes in 6.3 ms (~159 M/s)**,
against the 40 samples/second the app actually produces.

## Optimisation techniques, and why each one is there

### 1. Min/max decimation — the load-bearing optimisation

For each pixel column, the series is folded to its **minimum and maximum**, in
the order they occurred. Vertex count is therefore bounded by the plot's pixel
width, not by how many samples are in range.

Measured, with the plot at 1034 px:

| Points in buffer | Vertices produced |
|---|---|
| 10,000 | 8,313 |
| 50,000 | 8,324 |
| 200,000 | 8,324 |

**10,000 points and 200,000 points cost the same to draw.** This is why the
scaling strategy below is credible rather than aspirational.

It is also visually lossless in the way that matters: any spike tall enough to
see is, by definition, the min or max of its column. Verified against a naive
full-resolution projection — per-series pixel extremes match to within 1e-3.

Projection cost for 10,000 points: **0.113 ms per frame**, about 0.7% of a
16.7 ms budget.

### 2. Zero allocation in the frame path

Vertex buffers are pooled and reused. Column accumulators are module-scope
scratch arrays. The flush step is a module-level function rather than a
per-call closure, because a closure allocated 60 times a second is a steady
drip of garbage for no benefit.

Measured over 2,000 consecutive projections: **−2 B/frame**. Over 2,000
aggregate-and-project passes: **1.0 B/frame**. There is no per-frame garbage to
collect, which is why the GC sawtooth is as shallow as it is.

### 3. Frame signature (dirty checking)

Each chart computes a cheap signature — buffer revision, viewport, size, theme,
series count, aggregation window — and the loop skips the entire draw when it is
unchanged. A paused chart costs nothing.

React's `useMemo` cannot serve this role: it only evaluates during React's
render pass, and this loop deliberately runs outside it. The equivalent
mechanism is a cache key compared once per frame.

### 4. Batched paths, one fill per series

The scatter plot adds every mark to a single path and issues one `fill()`.
Issuing `fillRect` per point costs a separate rasteriser call each time.
Combined with an occupancy grid that skips marks landing on already-covered
pixels, 9,992 points in view become 5,279 drawn marks in 0.78 ms.

The occupancy grid uses a **monotonic stamp** rather than clearing: starting a
new pass is a single integer increment instead of a 315 KiB memset.

### 5. Cached aggregation

Bucket aggregation is cached against buffer revision, window, snapped range and
series mask, so the scan runs once per data tick (10 Hz) rather than once per
frame (60 Hz).

| Operation | Cost |
|---|---|
| Cache miss (full scan of 10,000 points) | 86 µs |
| Cache hit | **0.45 µs** |

Bucket means were verified against a brute-force computation and match to 1e-9.

Worth stating plainly: **aggregation is not what makes this fast.** Decimation
already bounded the render cost. Aggregation earns its place for *readability*
— a zoomed-out view of raw telemetry is a noise band — and for cutting the
per-frame scan. It is not rescuing a frame rate that was failing.

### 6. Virtualised table

`hooks/useVirtualization.ts` renders only the rows intersecting the viewport
plus overscan, with a spacer carrying the full list height so the scrollbar
stays proportional. **10,000 rows become 25 DOM nodes; the whole page is 278
nodes.** State changes only when the row *window* moves, so scrolling within a
single row re-renders nothing.

Filtering goes through a pooled `Int32Array` of logical indices rather than
allocating a filtered array — one O(n) rebuild at 4 Hz instead of per frame.

### 7. React-level memoisation, applied where it changes something

- `React.memo` on the three charts and the table. The dashboard re-renders about
  twice a second to publish metrics; without this, each of those renders would
  walk every chart and rebuild its callbacks for a canvas that is driven by a
  rAF loop and never reads React's output.
- `useDeferredValue` on the series filter. Charts absorb a filter change almost
  for free (hidden series are skipped by a mask inside the projection loop); the
  table is the expensive consumer. They are split deliberately — charts and
  checkboxes read the urgent value, the table lags with a visible marker.
  Measured across 12 rapid toggles: **no frame longer than 33 ms**.
- `useTransition` on chart-type switching, the heaviest single state change.
  Two pieces of state rather than one: the tab highlight is urgent so it
  responds on the next frame, the mount is transitioned so it can be
  interrupted.

### 8. Server-side generation with a columnar wire format

The initial 10,000-point backfill is generated in a Server Component. Sending it
as `DataPoint` objects would put **596 KiB** of JSON into the RSC payload, most
of it repeated 13-digit timestamps and repeated category names, paid on every
request before the page is interactive.

The generator emits a uniform grid, so timestamps and categories are derivable
and only values cross the wire:

| Format | Raw | Gzipped |
|---|---|---|
| `DataPoint` objects | 596.3 KiB | 56.4 KiB |
| Columnar (what ships) | **58.0 KiB** | **22.7 KiB** |

**10.3× smaller raw, 2.5× gzipped, lossless.**

Bundle cost: `/dashboard` is 15.5 kB, **103 kB First Load JS** — with zero chart
libraries.

## The bottleneck we found, and the fix

The most useful measurement in this project was isolating *what* was limiting
frame rate. On the 120 Hz display:

| Scenario | FPS |
|---|---|
| Blank page (hardware ceiling) | 120.3 |
| Trivial canvas animation (one moving rect) | 120.1 |
| Dashboard with all series hidden (axes only, 0 vertices) | 120.2 |
| Dashboard with 7,418 polyline vertices | **52.4** |

Everything except the polyline ran at full refresh. The JS draw time was
0.47 ms — so the cost was **not** in our JavaScript. `ctx.stroke()` only
*queues* work; the rasterisation of a stroked polyline happens afterwards and
our metric never saw it.

The culprit was `lineJoin: "round"` and `lineCap: "round"`. Round joins cost
per-vertex rasterisation work, and on a decimated series the vertices are one
pixel apart — the arc is smaller than the line is wide, so it is invisible.

Switching to `bevel` / `butt`:

| | Before | After |
|---|---|---|
| FPS at 10,000 points | 52.4 | **65.9** |
| Median frame | 16.70 ms | 16.60 ms |
| **p95 frame** | **25.10 ms** | **16.80 ms** |

The p95 collapse matters more than the mean: frame time went from
intermittently missing a vsync to locked flat. Visually identical.

### Two honest caveats

**We hit 60 fps, not 120.** The target is 60 and it is met with a flat 16.6 ms
frame time. But on a 120 Hz display the line chart locks to every other vsync,
because polyline rasterisation is roughly 8 ms of GPU work that Canvas 2D gives
us no way to avoid. Bar and scatter, which rasterise far less area, *do* reach
120 fps. Getting the line chart there needs WebGL or OffscreenCanvas — see
below.

**The "Draw time" figure in the UI measures JavaScript, not rasterisation.**
Axes-only is 0.17 ms → 120 fps; with polylines it is 0.53 ms → 66 fps. A
0.36 ms JS delta produced an 8.3 ms frame-time delta. The widget is useful for
spotting JS regressions but it understates true frame cost, and no figure in
this document treats it as the whole story.

## Crosshair and tooltip

Added after the numbers above were taken, so the question was specifically
whether it costs frames. It does not.

**Cost of one crosshair update**, measured in-page over 3,000 consecutive
pointer moves against the production build:

| | |
|---|---|
| Median | **0.10–0.20 ms** |
| p95 | 0.20–0.50 ms |
| Nearest-point resolve alone | **0.229 µs**, allocation-free over 200,000 calls |

**Frame rate with and without hovering.** Three arms — no pointer, cursor parked
on the plot, and a synthetic pointer swept across the plot *once per frame*
(harsher than a real mouse, which the browser coalesces):

| Arm | Mean FPS | Best frame gap | Frames < 20 ms | JS draw |
|---|---|---|---|---|
| No pointer | 63.1 | **16.60 ms** | 95% | 0.61 ms |
| Cursor parked | 61.1 | **16.60 ms** | 95% | 0.79 ms |
| Sweeping (1,083 moves) | 59.9 | **16.60 ms** | 93% | 0.75 ms |

All three arms reach the same 16.60 ms frame interval. The draw figure rises by
~0.2 ms while hovering because `refresh()` is called at the end of the chart's
timed draw, so that number honestly includes the crosshair's own repaint.

### Why it is a second canvas

The obvious implementation — draw the crosshair inside the chart's `draw`
callback — would have been the expensive one. Every pointer move would change
the frame signature, and each invalidation re-rasterises the full decimated
polyline: the ~8 ms of GPU work identified as the frame-rate limiter below.
Moving the mouse would then cost more than the data stream does.

On its own layer the hover repaint touches one line and a handful of markers,
and the base chart is never invalidated. The layer is `display: none` until
pointed at — not merely `visibility: hidden`, because a hidden layer is still a
layer to composite, and a chart nobody is hovering should pay nothing.

Two further details earned their place by measurement:

- **A dirty check on the overlay.** Two things request a repaint: pointer moves,
  and `refresh()` after every base frame. Without a signature comparison a
  hovering pointer repaints *twice per frame*, and a stationary cursor repaints
  at display rate to show a reading that only changes at 10 Hz. Adding the check
  brought the hover cost inside the 0.35 ms bar it was previously missing.
- **No `will-change: transform`** on the tooltip, despite it being moved by
  transform — it would promote the element to its own compositing layer
  permanently, including while hidden. An A/B/A/B toggling it at runtime could
  not separate its cost from noise, so this is a decision on principle rather
  than a measured win; it is recorded that way rather than dressed up.

### A measurement caveat worth recording

Frame-rate numbers for the line chart are **bimodal and machine-sensitive**, and
this took several runs to establish rather than assume. The chart needs ~8 ms of
polyline rasterisation against an 8.33 ms vsync interval on a 120 Hz panel, so it
sits exactly on a boundary: with headroom it holds 16.6 ms frames, and under
external GPU load from other applications every arm drops together to 25 ms
(3 vsync intervals, ~40 fps). Runs on a quiet machine have also shown it reaching
the full 8.30 ms / 120 fps.

Consequences for anyone reproducing this:

- **Measure the arms interleaved, not back to back.** Sequential A/B runs
  attribute session drift to whichever change was measured second. An early
  sequential comparison here showed a 9% "regression" that interleaving proved
  did not exist.
- **Compare arms relatively; the absolute figure is a property of the desktop.**
- **Keep the window foregrounded.** Headful Chrome throttles `requestAnimationFrame`
  when its window is occluded — that alone produced readings from 0 fps to 120 fps
  for identical code, and was the single largest source of noise in these runs.
  `--disable-backgrounding-occluded-windows` is not sufficient; the harness calls
  `Page.bringToFront` before every sampling window.

### Correctness, not just speed

The tooltip reports what the chart drew. When an aggregation window is active it
reads the **bucket mean** out of the same `BucketSet` the frame was rendered
from, rather than looking up a raw sample that appears nowhere on screen. An
empty bucket resolves to *nothing* rather than to zero, matching `projectBuckets`
— a gap in the data is not a reading of zero.

Verified against the generator's own output: every resolved timestamp is a real
sample, every value matches the source data exactly, the snap moves the crosshair
by under 1 px, and bucket means match a hand-computed mean of the 600 raw samples
behind them.

## Scaling strategy: 100,000+ points

The render path is already there; the data path is what would need work.

### What already scales

**Decimation makes rendering independent of dataset size.** Measured above:
200,000 points produce the same ~8,324 vertices as 10,000. Rendering 100k or
1M points costs what 10k costs today. This is not a projection — it is measured.

**Memory scales linearly and stays fixed.** The ring buffer is ~25 bytes per
sample: 100,000 points ≈ 2.4 MB, 1,000,000 ≈ 24 MB. Allocated once, never grown.

### What would break first

The remaining O(n) work is the per-frame **scan**, not the draw:

| Operation | at 10k | projected at 100k | projected at 1M |
|---|---|---|---|
| Projection scan | 0.113 ms | ~1.1 ms | ~11 ms |
| Aggregation (cache miss) | 0.086 ms | ~0.9 ms | ~8.6 ms |
| Table index rebuild | O(n) at 4 Hz | ~10× | ~100× |

At 100k these are uncomfortable but survivable (~2 ms of a 16.7 ms budget). At
1M the scan alone blows the frame budget.

### The fix: a multi-resolution index

Maintain **pre-aggregated tiers** — say 1 s, 10 s, 1 min buckets — updated
incrementally as each sample is pushed, in O(1) per push rather than O(n) per
frame. A query then reads from the coarsest tier that still gives more buckets
than the plot has pixels.

This turns per-frame cost from *O(points in range)* into *O(pixels)*, which is
already what the vertex count is bounded by. The `AggregationCache` and
`BucketSet` in `lib/aggregation.ts` are the first tier of exactly this
structure; the work is generalising them to a fixed ladder and updating them on
push instead of on query.

The ring buffer's `lowerBound` binary search (measured at 0.09 µs) already makes
range selection free, so the tiers need no additional index.

### Then, in order of payoff

1. **Move ingestion and aggregation to a Web Worker.** The buffer becomes a
   `SharedArrayBuffer`; the worker writes, the main thread reads and renders.
   Generation and bucketing stop competing with rendering for the main thread.
   Currently unimplemented — see README.

2. **OffscreenCanvas.** Transfer the canvas to the worker so rasterisation
   leaves the main thread entirely. This addresses the 8 ms polyline cost
   identified above, which is the actual ceiling today.

3. **WebGL for the line path.** The measurement above shows the limit is
   rasterising a stroked polyline. A WebGL implementation uploads the decimated
   vertices once per change and draws them in a single call, removing the
   per-vertex CPU rasterisation that currently caps the line chart at 60 fps on
   a 120 Hz display. This is the only change that would plausibly reach 120 fps.

4. **Per-category ring buffers.** The table's index-map rebuild is O(n) because
   categories are interleaved in one buffer. Storing one buffer per series makes
   filtering an O(1) selection with no map to rebuild, and also lets the
   projection loop skip hidden series without touching their memory.

5. **Backpressure on ingest.** At very high rates the honest failure mode is to
   coalesce: aggregate on the way in and store the summary rather than every
   sample. The catch-up clamp in `useDataStream` (20 ticks) is a first version
   of this — it already trades an explicit gap in the series for never blocking
   the main thread.

## Reproducing these measurements

```bash
npm run build && npm start
```

Then in Chrome at <http://localhost:3000/dashboard>:

1. Click **Stress mode: ON** — this forces a redraw every frame, so you are
   measuring sustained worst-case load rather than the idle path.
2. DevTools → **⋮ → More tools → Rendering** → tick **Frame Rendering Stats**
   for a live FPS overlay.
3. DevTools → **Performance** → Record for ~10 s → Stop. Read the **Frames**
   track (solid green = no drops), then expand **Main** and find the
   `requestAnimationFrame` handler — its self time should be well under 1 ms.
4. For memory: tick **Memory** before recording. The JS heap line should be flat
   or gently sawtoothed, never a rising staircase.
5. Throttle with **CPU: 4× slowdown** to confirm headroom.

The in-page performance monitor (bottom right) shows live FPS, draw time,
dropped frames, heap size and the memory trend without opening DevTools.

**If your line-chart FPS reads ~40 rather than ~60**, before assuming a
regression check that the Chrome window is genuinely in the foreground and that
nothing else is using the GPU. As recorded above, the line chart sits on a vsync
boundary and other applications tip it across; the diagnostic is that Bar and
Scatter still report 118–120 fps in the same session, which shows the GPU is not
saturated and the loop is healthy. Hover the chart and compare — if the crosshair
arm matches the idle arm, nothing in the render path has changed.
