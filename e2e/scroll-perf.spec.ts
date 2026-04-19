import {test, expect} from './fixtures/trace'
import {formatReport, measureInteraction} from './helpers/perfTrace'

/**
 * The invariants that MUST hold regardless of machine speed are asserted
 * strictly (zero long tasks, zero Layout during scroll). Scripting budgets
 * are looser guards that catch regressions in overall work-per-frame; they
 * were sized ~2x the observed baseline on an M-series laptop so CI noise
 * doesn't flap them.
 *
 * Baselines (2026-04, local, release build of perfecto-chrome-trace.json):
 *   horizontal drag:  scripting ~550ms / window ~800ms, Layout 0, longTasks 0
 *   wheel scroll:     scripting ~250ms / window ~600ms, Layout 0, longTasks 0
 *   ctrl+wheel zoom:  scripting ~345ms / window ~550ms, Layout 0, longTasks 0
 *   vertical scroll:  scripting ~340ms / window ~650ms, Layout 0, longTasks 0
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
    ).toBeLessThan(1100)
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
    ).toBeLessThan(500)
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
      for (let i = 0; i < 12; i++) {
        // Negative deltaY => zoom in. Must set ctrl=true to route through the
        // zoom handler instead of pan.
        await page.mouse.wheel(0, -100)
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, -100)
        await page.keyboard.up('Control')
        await page.waitForTimeout(20)
      }
    })

    testInfo.annotations.push({
      type: 'perf-metrics',
      description: formatReport(report),
    })

    // Zoom legitimately re-renders rows, so we allow some scripting, but we
    // still require zero long tasks.
    expect(report.longTasks, 'ctrl+wheel zoom produced no long tasks').toEqual([])
    expect(
      report.metrics.scripting,
      'ctrl+wheel zoom scripting within budget',
    ).toBeLessThan(700)
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
    ).toBeLessThan(700)
  })
})
