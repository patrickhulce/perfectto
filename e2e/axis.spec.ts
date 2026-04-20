import {test, expect} from './fixtures/trace'

/**
 * Polish-pass axis + zoom-clamp + layout-shift guarantees.
 *
 * These four tests together cover the feedback items that shipped with
 * the axis rework:
 *  1. Axis stays pinned at the top of the scroller while the user
 *     vertically scrolls through tracks.
 *  2. Initial mount lands fully zoomed out — no horizontal scroll.
 *  3. Ctrl+wheel-out past fit is clamped (no gap on the right edge
 *     a.k.a. the "broken background" feedback).
 *  4. Layout height does not shift when zooming in/out across the fit
 *     threshold (scrollbar-gutter reservation).
 */

test.describe('timeline axis + fit clamp', () => {
  test('axis is visible and stays pinned while tracks scroll vertically', async ({
    page,
  }) => {
    const axis = page.getByTestId('timeline-axis')
    await expect(axis).toBeVisible()

    const scroller = page.getByTestId('timeline-event-surface').locator('..')
    const before = await axis.boundingBox()
    if (!before) throw new Error('axis not measurable')

    await scroller.evaluate((el: HTMLElement) => {
      el.scrollTop = 600
    })
    await page.waitForTimeout(64)

    const after = await axis.boundingBox()
    if (!after) throw new Error('axis not measurable after scroll')
    // Sticky means the axis's on-screen y stays the same even though
    // scrollTop jumped by 600 px.
    expect(Math.abs(after.y - before.y)).toBeLessThan(2)
  })

  test('starts fully zoomed out — no horizontal scroll at initial mount', async ({
    page,
  }) => {
    const geom = await page.evaluate(() => {
      const surface = document.querySelector(
        '[data-testid="timeline-event-surface"]',
      ) as HTMLElement | null
      const scroller = surface?.parentElement as HTMLElement | null
      if (!surface || !scroller) return null
      return {
        surfaceWidth: surface.getBoundingClientRect().width,
        scrollerClient: scroller.clientWidth,
        scrollerScroll: scroller.scrollWidth,
      }
    })
    if (!geom) throw new Error('geometry unavailable')

    // scrollWidth should be within 1 CSS px of clientWidth at fit-zoom
    // (floating-point fit math occasionally leaves sub-pixel headroom).
    expect(
      geom.scrollerScroll - geom.scrollerClient,
      'no horizontal overflow at fit-zoom',
    ).toBeLessThanOrEqual(1)
  })

  test('ctrl+wheel-out past fit is clamped (no right-edge gap)', async ({
    page,
  }) => {
    const surface = page.getByTestId('timeline-event-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('surface not measurable')

    // Park cursor in the middle of the track area.
    await page.mouse.move(box.x + box.width / 2, box.y + 200)

    await page.keyboard.down('Control')
    // 30 zoom-out ticks — way more than enough to blow past fit if no
    // clamp exists.
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, 100)
      await page.waitForTimeout(8)
    }
    await page.keyboard.up('Control')
    await page.waitForTimeout(64)

    const geom = await page.evaluate(() => {
      const surface = document.querySelector(
        '[data-testid="timeline-event-surface"]',
      ) as HTMLElement | null
      const scroller = surface?.parentElement as HTMLElement | null
      if (!surface || !scroller) return null
      return {
        surfaceWidth: surface.getBoundingClientRect().width,
        scrollerClient: scroller.clientWidth,
      }
    })
    if (!geom) throw new Error('geometry unavailable')

    // The surface never shrinks below the scroller's content area. A
    // 1 px slack absorbs fit-math rounding.
    expect(
      geom.surfaceWidth,
      'surface width stays >= viewport after zooming all the way out',
    ).toBeGreaterThanOrEqual(geom.scrollerClient - 1)
  })

  test('zooming across the fit threshold does not shift content height', async ({
    page,
  }) => {
    const surface = page.getByTestId('timeline-event-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('surface not measurable')

    const heightAtFit = await surface.evaluate(
      (el: HTMLElement) => el.getBoundingClientRect().height,
    )

    await page.mouse.move(box.x + box.width / 2, box.y + 200)
    await page.keyboard.down('Control')
    // Zoom IN — pushes us into the has-h-scroll regime.
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, -100)
      await page.waitForTimeout(8)
    }
    await page.keyboard.up('Control')
    await page.waitForTimeout(64)

    const heightZoomedIn = await surface.evaluate(
      (el: HTMLElement) => el.getBoundingClientRect().height,
    )

    // With `scrollbar-gutter: stable` the viewport's vertical space is
    // reserved whether or not the h-scrollbar is currently rendered, so
    // surface height doesn't jump as the scrollbar appears.
    expect(
      Math.abs(heightZoomedIn - heightAtFit),
      'total surface height stable across fit boundary',
    ).toBeLessThanOrEqual(1)
  })
})
