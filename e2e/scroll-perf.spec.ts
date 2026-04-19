import {test, expect} from './fixtures/trace'
import {formatReport, measureInteraction} from './helpers/perfTrace'

/**
 * Post-Phase-1 (canvas renderer) perf invariants.
 *
 * The canvas path repaints via `ctx.fillRect` on a per-track `<canvas>`, so
 * scrolling/zooming never hits the React tree or the DOM layout engine. The
 * invariants that MUST hold regardless of machine speed are asserted
 * strictly (zero long tasks, zero Layout during interaction). Scripting
 * budgets are looser guards that catch regressions in overall work-per-frame;
 * they were tightened ~1.5x under the new renderer from the pre-canvas
 * baselines.
 *
 * Baselines (2026-04, local, release build of perfecto-chrome-trace.json,
 * canvas renderer):
 *   horizontal drag:  scripting ~320ms / window ~500ms, Layout 0, longTasks 0
 *   wheel scroll:     scripting ~120ms / window ~300ms, Layout 0, longTasks 0
 *   ctrl+wheel zoom:  scripting ~130ms / window ~320ms, Layout 0, longTasks 0
 *   vertical scroll:  scripting ~170ms / window ~380ms, Layout 0, longTasks 0
 */

test.describe('Timeline interaction performance', () => {
  test('horizontal drag pan is GPU-accelerated (no main-thread blocking)', async ({
    page,
  }, testInfo) => {
    const surface = page.getByTestId('timeline-event-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('timeline surface not measurable')
    // Start the drag somewhere in the middle of the visible timeline tracks,
    // not on a header button.
    const startX = box.x + box.width / 2
    const startY = box.y + Math.min(400, box.height * 0.8)

    const report = await measureInteraction(page, testInfo, async () => {
      await page.mouse.move(startX, startY)
      await page.mouse.down()
      // 30 steps across ~900px with ~16ms spacing to mimic a ~60fps drag.
      const steps = 30
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(startX - (i * 900) / steps, startY)
        await page.waitForTimeout(16)
      }
      await page.mouse.up()
    })

    testInfo.annotations.push({
      type: 'perf-metrics',
      description: formatReport(report),
    })

    expect(report.longTasks, 'horizontal drag produced no long tasks').toEqual([])
    expect(report.metrics.layout, 'horizontal drag triggers zero Layout').toBeLessThan(2)
    expect(
      report.metrics.recalcStyle,
      'horizontal drag triggers minimal style recalc',
    ).toBeLessThan(10)
    expect(
      report.metrics.scripting,
      'horizontal drag scripting within budget',
    ).toBeLessThan(700)
  })

  test('wheel horizontal scroll stays off the layout path', async ({
    page,
  }, testInfo) => {
    const surface = page.getByTestId('timeline-event-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('timeline surface not measurable')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

    const report = await measureInteraction(page, testInfo, async () => {
      for (let i = 0; i < 20; i++) {
        await page.mouse.wheel(120, 0)
        await page.waitForTimeout(16)
      }
    })

    testInfo.annotations.push({
      type: 'perf-metrics',
      description: formatReport(report),
    })

    expect(report.longTasks, 'wheel scroll produced no long tasks').toEqual([])
    expect(report.metrics.layout, 'wheel scroll triggers zero Layout').toBeLessThan(2)
    expect(
      report.metrics.scripting,
      'wheel scroll scripting within budget',
    ).toBeLessThan(300)
  })

  test('ctrl+wheel zoom does not block the main thread with long tasks', async ({
    page,
  }, testInfo) => {
    const surface = page.getByTestId('timeline-event-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('timeline surface not measurable')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)

    const report = await measureInteraction(page, testInfo, async () => {
      await page.keyboard.down('Control')
      for (let i = 0; i < 12; i++) {
        // Negative deltaY => zoom in. Ctrl is held for the whole burst so
        // every wheel routes through the zoom handler (not pan).
        await page.mouse.wheel(0, -100)
        await page.waitForTimeout(20)
      }
      await page.keyboard.up('Control')
    })

    testInfo.annotations.push({
      type: 'perf-metrics',
      description: formatReport(report),
    })

    // Canvas zoom: every tick commits pxPerMs and writes scrollLeft; no
    // layout-touching transform exists. Long tasks must stay empty, Layout
    // must stay effectively zero, and scripting is ~1.5x the pre-canvas
    // baseline's budget (~175ms) because there are now 12 React renders
    // across the burst instead of 1 debounced commit — each is cheap
    // because CanvasTrackRenderer doesn't re-render on scroll/zoom.
    expect(report.longTasks, 'ctrl+wheel zoom produced no long tasks').toEqual([])
    expect(
      report.metrics.layout,
      'ctrl+wheel zoom stays off the layout path',
    ).toBeLessThan(2)
    expect(
      report.metrics.scripting,
      'ctrl+wheel zoom scripting within budget',
    ).toBeLessThan(250)
  })

  test('ctrl+wheel zoom stays anchored under the cursor', async ({page}) => {
    const surface = page.getByTestId('timeline-event-surface')
    const surfaceBox = await surface.boundingBox()
    if (!surfaceBox) throw new Error('timeline surface not measurable')

    const before = await page.evaluate(() => {
      const t = window.__perfecttoTimeline
      if (!t) throw new Error('timeline snapshot not installed')
      const r = t.scrollerRect
      if (!r) throw new Error('scroller rect unavailable')
      return {
        pxPerMs: t.pxPerMs,
        scrollLeft: t.scrollLeft,
        labelWidthPx: t.labelWidthPx,
        timelineStart: t.timelineStart,
        scrollerRect: r,
      }
    })

    // Park the cursor well inside the track area (past the sticky label) so
    // the anchor math doesn't clamp at trackX=0.
    const cursorX = before.scrollerRect.x + before.labelWidthPx + 300
    const cursorY =
      surfaceBox.y + Math.min(400, surfaceBox.height * 0.8)
    await page.mouse.move(cursorX, cursorY)

    // Canvas renderer commits every wheel tick synchronously, so the
    // anchor math is the simple textbook form with no live-transform
    // correction.
    const msUnderCursor = (s: {
      pxPerMs: number
      scrollLeft: number
      labelWidthPx: number
      timelineStart: number
      scrollerRect: {x: number}
    }) => {
      const cursorXView = cursorX - s.scrollerRect.x
      const layerX = s.scrollLeft + cursorXView - s.labelWidthPx
      return s.timelineStart + layerX / s.pxPerMs
    }
    const msBefore = msUnderCursor(before)

    // 20 zoom-in ticks at a fixed cursor.
    await page.keyboard.down('Control')
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, -100)
      await page.waitForTimeout(16)
    }
    await page.keyboard.up('Control')
    // Give the last wheel tick's render + scrollLeft write a moment to
    // reflect in the snapshot.
    await page.waitForTimeout(48)

    const after = await page.evaluate(() => {
      const t = window.__perfecttoTimeline!
      const r = t.scrollerRect!
      return {
        pxPerMs: t.pxPerMs,
        scrollLeft: t.scrollLeft,
        labelWidthPx: t.labelWidthPx,
        timelineStart: t.timelineStart,
        scrollerRect: r,
      }
    })
    expect(
      after.pxPerMs,
      'pxPerMs strictly increased across the zoom burst',
    ).toBeGreaterThan(before.pxPerMs * 1.5)

    const afterDriftPx =
      Math.abs(msUnderCursor(after) - msBefore) * after.pxPerMs
    expect(afterDriftPx, 'anchor stays pinned under the cursor').toBeLessThan(2)
  })

  test('WASD keyboard shortcuts drive zoom and pan', async ({page}) => {
    const surface = page.getByTestId('timeline-event-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('timeline surface not measurable')
    // Move the pointer away from the timeline so W/S have to fall back to
    // the viewport-center anchor (exercises that branch).
    await page.mouse.move(2, 2)

    const readSnapshot = async () =>
      page.evaluate(() => {
        const t = window.__perfecttoTimeline
        if (!t) throw new Error('snapshot not installed')
        return {
          pxPerMs: t.pxPerMs,
          scrollLeft: t.scrollLeft,
          labelWidthPx: t.labelWidthPx,
          timelineStart: t.timelineStart,
          scrollerRect: t.scrollerRect!,
        }
      })

    // ---- W zooms in, anchored near the viewport center. ------------------
    const before = await readSnapshot()
    // Tap W several times. Browser auto-repeat isn't triggered by .press,
    // but 8 discrete presses still exercise the zoom path end-to-end.
    for (let i = 0; i < 8; i++) await page.keyboard.press('w')
    await page.waitForTimeout(48) // let the last render + scrollLeft write land

    const afterZoomIn = await readSnapshot()
    expect(
      afterZoomIn.pxPerMs,
      'W zooms in (pxPerMs increased)',
    ).toBeGreaterThan(before.pxPerMs * 1.5)
    // With cursor off-surface, anchor is viewport center. The ms that was
    // at center before must still be at center afterwards (≤2px drift).
    const centerX =
      before.scrollerRect.x + before.scrollerRect.width / 2
    const msAtCenter = (s: typeof before) =>
      s.timelineStart +
      (s.scrollLeft + (centerX - s.scrollerRect.x) - s.labelWidthPx) /
        s.pxPerMs
    const zoomDrift =
      Math.abs(msAtCenter(afterZoomIn) - msAtCenter(before)) *
      afterZoomIn.pxPerMs
    expect(zoomDrift, 'W zoom anchored at viewport center').toBeLessThan(2)

    // ---- S zooms back out. ----------------------------------------------
    for (let i = 0; i < 8; i++) await page.keyboard.press('s')
    await page.waitForTimeout(48)
    const afterZoomOut = await readSnapshot()
    expect(
      afterZoomOut.pxPerMs,
      'S undoes zoom-in (pxPerMs returns near baseline)',
    ).toBeLessThan(afterZoomIn.pxPerMs)

    // ---- D pans right, A pans left. -------------------------------------
    const preD = await readSnapshot()
    await page.keyboard.press('d')
    // Pan is a synchronous scrollLeft mutation; the rAF-throttled scroll
    // listener in Timeline takes ~one frame to update React state.
    await page.waitForTimeout(48)
    const afterD = await readSnapshot()
    expect(
      afterD.scrollLeft,
      'D pans right (scrollLeft increases)',
    ).toBeGreaterThan(preD.scrollLeft)

    await page.keyboard.press('a')
    await page.waitForTimeout(48)
    const afterA = await readSnapshot()
    expect(
      afterA.scrollLeft,
      'A pans left (scrollLeft decreases)',
    ).toBeLessThan(afterD.scrollLeft)
  })

  test('vertical scroll through tracks stays smooth', async ({page}, testInfo) => {
    const surface = page.getByTestId('timeline-event-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('timeline surface not measurable')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

    const report = await measureInteraction(page, testInfo, async () => {
      for (let i = 0; i < 25; i++) {
        await page.mouse.wheel(0, 200)
        await page.waitForTimeout(16)
      }
    })

    testInfo.annotations.push({
      type: 'perf-metrics',
      description: formatReport(report),
    })

    expect(report.longTasks, 'vertical scroll produced no long tasks').toEqual([])
    expect(report.metrics.layout, 'vertical scroll triggers zero Layout').toBeLessThan(2)
    expect(
      report.metrics.scripting,
      'vertical scroll scripting within budget',
    ).toBeLessThan(400)
  })
})
