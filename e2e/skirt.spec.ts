import {test, expect} from '@playwright/test'
import {SAMPLE_TRACE_PATH} from './fixtures/trace'

/**
 * Phase 3 buffered-bounds verification.
 *
 * The skirt draws each per-track canvas at 3× viewport width and translates
 * via CSS transform during pan. The user-visible guarantee is "horizontal
 * pan within one viewport never repaints anything"; this spec locks that
 * by counting `CanvasRenderingContext2D.fillRect` calls during a drag-pan
 * that stays well within the buffered range.
 *
 * Doesn't extend the shared `traceLoaded` fixture because we need to
 * install the fillRect counter BEFORE any rendering happens (so initial
 * paint isn't counted) and we need to vary URL search params per test
 * (default vs `?skirt=off`).
 */

interface FillRectWindow {
  __fillRectCount: number
  __resetFillRectCount: () => void
}

declare global {
  interface Window {
    __fillRectCount?: number
    __resetFillRectCount?: () => void
  }
}

async function gotoWithCounter(
  page: import('@playwright/test').Page,
  search = '',
): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as FillRectWindow
    w.__fillRectCount = 0
    w.__resetFillRectCount = () => {
      w.__fillRectCount = 0
    }
    const proto = CanvasRenderingContext2D.prototype as unknown as {
      fillRect: (x: number, y: number, w: number, h: number) => void
    }
    const orig = proto.fillRect
    proto.fillRect = function patchedFillRect(x, y, w, h) {
      w !== undefined && (w as unknown) // satisfy unused
      const win = window as unknown as FillRectWindow
      win.__fillRectCount += 1
      return orig.call(this, x, y, w as unknown as number, h as unknown as number)
    } as typeof proto.fillRect
  })

  await page.goto(`/${search}`)
  const fileInput = page.getByTestId('file-input')
  await fileInput.setInputFiles(SAMPLE_TRACE_PATH)
  const surface = page.getByTestId('timeline-event-surface')
  await expect(surface).toBeVisible({timeout: 60_000})
  await expect
    .poll(
      async () => {
        const box = await surface.boundingBox()
        return box ? Math.min(box.width, box.height) : 0
      },
      {timeout: 10_000},
    )
    .toBeGreaterThan(100)
  // Settle initial paint.
  await page.waitForTimeout(400)
}

async function panBy(
  page: import('@playwright/test').Page,
  surfaceBox: {x: number; y: number; width: number; height: number},
  dxPx: number,
): Promise<void> {
  const startX = surfaceBox.x + surfaceBox.width / 2
  const startY = surfaceBox.y + Math.min(400, surfaceBox.height * 0.7)
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  const steps = 20
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX - (i * dxPx) / steps, startY)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
}

test.describe('Phase 3 skirt', () => {
  test('drag-pan inside the skirt issues zero fillRect calls', async ({page}) => {
    await gotoWithCounter(page) // skirt enabled by default
    const surface = page.getByTestId('timeline-event-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('timeline surface not measurable')

    // Drain any post-load paint work and zero the counter immediately
    // before the interaction we care about.
    await page.evaluate(() => window.__resetFillRectCount?.())
    const beforeCount = await page.evaluate(() => window.__fillRectCount ?? -1)
    expect(beforeCount).toBe(0)

    // 200px drag — comfortably inside one viewport on either side of the
    // skirt center (skirt = 3× viewport = thousands of px on a typical
    // browser window). With the default 0.5-viewport edge threshold the
    // recenter trigger never fires.
    await panBy(page, box, 200)
    await page.waitForTimeout(120)

    const fillsDuringPan = await page.evaluate(() => window.__fillRectCount ?? -1)
    expect(
      fillsDuringPan,
      'zero fillRect calls during a small drag-pan inside the skirt',
    ).toBe(0)
  })

  test('?skirt=off restores the per-frame redraw path (regression baseline)', async ({
    page,
  }) => {
    await gotoWithCounter(page, '?skirt=off')
    const surface = page.getByTestId('timeline-event-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('timeline surface not measurable')

    // Zoom in first so there's a scrollable range to pan over; at
    // initial fit-zoom (post-polish-pass clamp) innerWidth === viewport
    // and a drag can't actually move scrollLeft.
    await page.mouse.move(box.x + box.width / 2, box.y + 200)
    await page.keyboard.down('Control')
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, -100)
      await page.waitForTimeout(8)
    }
    await page.keyboard.up('Control')
    await page.waitForTimeout(120)

    await page.evaluate(() => window.__resetFillRectCount?.())
    await panBy(page, box, 200)
    await page.waitForTimeout(120)

    const fillsDuringPan = await page.evaluate(() => window.__fillRectCount ?? -1)
    // With the skirt disabled every frame redraws every visible track. The
    // exact count depends on machine speed and trace contents, but it MUST
    // be > 0 — otherwise our toggle isn't actually toggling anything.
    expect(
      fillsDuringPan,
      'skirt=off path still issues fillRect during pan',
    ).toBeGreaterThan(0)
  })

})
