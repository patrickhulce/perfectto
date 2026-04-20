import {test, expect} from './fixtures/trace'

/**
 * Middle-click pan. Matches the left-drag pan contract (horizontal
 * scroll tracks cursor delta) and additionally works when the drag
 * STARTS over a gutter button — left-drag is filtered away in that case
 * so the toggle still fires on plain clicks, but middle-click is
 * conventionally "pan this surface" regardless of the target.
 */

async function startingScrollLeft(
  page: import('@playwright/test').Page,
): Promise<number> {
  return page.evaluate(
    () => window.__perfecttoTimeline?.scrollLeft ?? 0,
  )
}

async function dragPan(
  page: import('@playwright/test').Page,
  startX: number,
  startY: number,
  dxPx: number,
  button: 'left' | 'middle',
): Promise<void> {
  await page.mouse.move(startX, startY)
  await page.mouse.down({button})
  const steps = 15
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX - (i * dxPx) / steps, startY)
    await page.waitForTimeout(8)
  }
  await page.mouse.up({button})
}

test.describe('middle-click pan', () => {
  test.beforeEach(async ({page}) => {
    // Zoom in first so there's something to pan.
    const surface = page.getByTestId('timeline-event-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('surface not measurable')
    await page.mouse.move(box.x + box.width / 2, box.y + 200)
    await page.keyboard.down('Control')
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, -100)
      await page.waitForTimeout(8)
    }
    await page.keyboard.up('Control')
    await page.waitForTimeout(64)
  })

  test('drag with middle button scrolls the timeline horizontally', async ({
    page,
  }) => {
    const surface = page.getByTestId('timeline-event-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('surface not measurable')

    const before = await startingScrollLeft(page)
    const centerX = box.x + box.width / 2
    const centerY = box.y + Math.min(200, box.height * 0.5)
    await dragPan(page, centerX, centerY, 120, 'middle')
    await page.waitForTimeout(64)
    const after = await startingScrollLeft(page)

    // Pan direction matches left-drag: dragging left moves content left
    // (scrollLeft increases).
    expect(
      after - before,
      'middle-click drag advances scrollLeft',
    ).toBeGreaterThanOrEqual(60)
  })

  test('middle-click pan works even when the drag starts on a gutter button', async ({
    page,
  }) => {
    // Find a gutter button — per-track buttons carry the aria-label
    // we added in Phase 3.5.
    const gutterButton = page
      .locator('button[aria-label*="measure"]')
      .first()
    await expect(gutterButton).toBeVisible()
    const buttonBox = await gutterButton.boundingBox()
    if (!buttonBox) throw new Error('gutter button not measurable')

    const before = await startingScrollLeft(page)
    const startX = buttonBox.x + buttonBox.width / 2
    const startY = buttonBox.y + buttonBox.height / 2
    await dragPan(page, startX, startY, 120, 'middle')
    await page.waitForTimeout(64)
    const after = await startingScrollLeft(page)

    expect(
      after - before,
      'middle-click drag over gutter button still pans',
    ).toBeGreaterThanOrEqual(60)
  })

  test('left-click drag over a gutter button does NOT pan (regression guard)', async ({
    page,
  }) => {
    const gutterButton = page
      .locator('button[aria-label*="measure"]')
      .first()
    const buttonBox = await gutterButton.boundingBox()
    if (!buttonBox) throw new Error('gutter button not measurable')

    const before = await startingScrollLeft(page)
    const startX = buttonBox.x + buttonBox.width / 2
    const startY = buttonBox.y + buttonBox.height / 2
    await dragPan(page, startX, startY, 120, 'left')
    await page.waitForTimeout(64)
    const after = await startingScrollLeft(page)

    // Left-drag over the gutter button is intentionally filtered out by
    // onPointerDown so toggles still work. Any significant delta here
    // would mean the middle-click change accidentally broke that.
    expect(
      Math.abs(after - before),
      'left-drag over gutter button does not pan',
    ).toBeLessThan(5)
  })
})
