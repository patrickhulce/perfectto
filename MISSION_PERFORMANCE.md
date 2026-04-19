Research summary: how Perfetto stays smooth

flowchart LR
traceFile[Trace file] --> wasmEngine["WASM trace_processor (worker)"]
wasmEngine -->|SQL per viewport| trackCtl[Per-track controller]
trackCtl -->|"typed arrays (starts, ends, depths, colors)"| canvas[Shared Canvas2D/WebGL renderer]
viewport[Viewport + zoom] --> trackCtl
viewport --> rafLoop[RAF scheduler]
rafLoop --> canvas
trackCtl --> buffered[BufferedBounds 3x skirt, quantized resolution]
buffered --> trackCtl

Key primitives (with file refs into the Perfetto tree):

ui/src/base/canvas2d_renderer.ts — batched fillRect over SliceBuffers {starts: Float32Array, ends, depths: Uint16Array, colors: Uint32Array, patterns: Uint8Array, count}, CPU-culled against a physical clip rect.

ui/src/components/tracks/buffered_bounds.ts — fetches visibleSpan.pad(visibleSpan.duration) quantized to a power-of-2 resolution; only re-fetches on threshold cross.

ui/src/components/tracks/slice_track.ts — CancellationSignal + SerialTaskQueue + deferChunkedTask keep data loads chunked and preemptible, with checkerboardExcept drawing a placeholder over not-yet-loaded ranges.

Mipmap/LOD is produced at ingest: slices narrower than resolution get merged into buckets with a count, bounding per-frame work at O(viewport_px × tracks) instead of O(slices).

RAF-driven redraw: canvases repaint independently of the Mithril tree, so track repaints don't cascade through component reconciliation.

Where we bottleneck today

Track.tsx emits one absolute-positioned <div> per Measure and Mark. At fit-zoom on assets/perfecto-chrome-trace.json this produces thousands of nodes, each costing style recalc + layout on any geometry change.

MeasureView uses scaleX on the container and a counter scaleX on the text span (--zoom-inv-scale) so glyphs stay crisp mid-gesture. This is clever but only buys us compositor smoothness during the gesture; the 250 ms commit in useTimelineViewport.ts still pays a full React render + paint tax.

ContainerContents recurses through the entire Measure tree each render, doing binary search per container. Works fine zoomed-in but scales poorly zoomed-out because every sub-1px measure is still visited.

There is no resolution-aware data view: src/core/parsers/chrome/chrome-parser.ts materializes the full nested Measure tree on parse. We ignore LOD and we ignore trace size.

No per-track async lifecycle: everything ships in a single ParsedTrace snapshot, so we can't lazily skip work for hidden tracks or cancel an in-flight operation.

Recommended roadmap (phased, each phase ships independently)

Phase 1 — Canvas track renderer (highest ROI)

Replace the DOM inside each Track's "content layer" with a single <canvas> that renders all measures/marks for that track. Keep the label gutter, system headers, and expand toggles in React/DOM.

New src/components/timeline/CanvasTrackRenderer.tsx: owns a per-track <canvas>, sized to clientWidth × heightPx with devicePixelRatio backing. Draws on RAF when pxPerMs, scrollLeft, or the visible window changes. Hit-testing (for hover/tooltips) uses the same typed-array buffers.

New src/core/render/sliceBuffers.ts: pack Measure[] into {starts: Float32Array, ends: Float32Array, depths: Uint16Array, colors: Uint32Array} once per track at parse-finalize. color gets packed 0xRRGGBBAA so per-frame we don't churn CSS strings.

Delete the scaleX + counter-scale machinery in src/components/Track.tsx — a canvas redraws crisply at every frame, so the gesture just updates pxPerMs/scrollLeft refs and schedules a RAF redraw. useTimelineViewport.ts can drop its flushSync commit ritual (the trickiest code in the repo) and keep only scrollLeft + pxPerMs state.

Feature-flag behind ?renderer=canvas for one release so the DOM path stays available for a11y/dev fallback.

Expected result: zero Layout during zoom/pan (we're already close for pan; zoom currently re-renders every measure), scripting per frame drops to the batched fillRect loop, arbitrarily larger traces become viable.

Phase 2 — Mipmap / LOD buckets

Add a resolution-aware view on top of the buffers built in Phase 1.

At parse finalize, build a small mipmap per track: at each power-of-two pxPerMs threshold, collapse runs of adjacent slices narrower than 1px into one bucket {start, end, count, dominantColor}. Cost is O(n log n); memory is bounded because each level halves the slice count.

CanvasTrackRenderer picks the coarsest level with resolution ≤ 1/pxPerMs and draws that instead of the raw buffer. Zoomed-out views render hundreds of rects instead of tens of thousands.

Renders buckets with a faint density tint (a = min(1, count/k)) so users see hotspot density, matching Perfetto's aggregated look.

Phase 3 — Buffered-bounds canvas ("skirt")

Once Phase 1 is landed, make horizontal wheel-scroll truly free by porting BufferedBounds semantics.

Give each canvas a drawn range wider than its viewport (e.g. viewportWidth × 3). Track it with loaded startMs/endMs/resolution.

On scroll, apply a CSS translateX to the canvas element (compositor-only, no redraw) until scrollLeft approaches the edge of the drawn range. At that point schedule a redraw and recenter.

Eliminates the per-frame redraw during continuous horizontal wheel/drag-pan.

Phase 4 — Per-track async renderer interface

Replaces the monolithic ParsedTrace → render model with Perfetto's plugin-style track interface so we can grow.

Define a TrackRenderer interface: onViewportChange(span, resolution) (chunked, cancellable) + render(ctx, span) synchronous.

Introduce a SerialTaskQueue + CancellationSignal port (straightforward, ~50 LOC) so expensive tracks (e.g. future counter/stack-sample tracks) don't block each other.

Draw checkerboardExcept over not-yet-loaded ranges — gives the same "data still streaming in" affordance Perfetto has.

Quick wins landable anytime (independent of phases)

Typed-array layout cache for depth/maxEnd already computed in parser — pass it to Track as {Float32Array, Uint16Array} instead of walking the object tree each render.

Lift horizontalOverscanPx to viewportWidth \* 1.0 (matches Perfetto's 3× total skirt) so even the current DOM renderer does less re-culling per frame.

Color packing: precompute a packed 0xRRGGBBAA on each Measure at parse time, avoids per-render measure.color ?? '#4a5568' string lookups.

What to cite and reuse verbatim from Perfetto

canvas2d_renderer.ts transform stack + CPU culling — port directly, it's ~150 LOC and under Apache-2.0.

buffered_bounds.ts — literal reimplementation with our number ms timestamps instead of their bigint nanoseconds.

The "don't promote to its own compositor layer while we're stretching" comment in our own Track.tsx becomes obsolete under canvas; delete once Phase 1 lands.

Risks and open questions

Accessibility: canvas tracks lose the title tooltips we get for free from DOM. Need to build a JS tooltip layer that hit-tests the buffer arrays. Not hard but worth acknowledging.

Text rendering: Perfetto draws slice labels via ctx.fillText + cropText (see slice_track.ts). We'll pay some font-metrics cost; amortizable with a width cache keyed on text+font.

The repo is currently set up for React; Mithril's RAF-batched redraw model doesn't port, but we can get 90% of the benefit by keeping React for the shell and driving canvas redraws from a plain RAF loop in CanvasTrackRenderer.
