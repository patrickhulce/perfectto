import {chromium} from '@playwright/test'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const TRACE = path.resolve(__dirname, '../assets/perfecto-chrome-trace.json')

async function main(): Promise<void> {
  const browser = await chromium.launch({headless: true})
  const context = await browser.newContext({viewport: {width: 1600, height: 900}})
  const page = await context.newPage()
  await page.goto('http://localhost:5173/')
  await page.getByTestId('file-input').setInputFiles(TRACE)
  await page.getByTestId('timeline-event-surface').waitFor({timeout: 60_000})
  await page.waitForTimeout(750)

  const before = path.resolve(__dirname, '../test-results/smoke-canvas-top.png')
  await page.screenshot({path: before, fullPage: false})
  console.log('screenshot (top) ->', before)

  // Zoom in ~20x using the 'w' hotkey (each press is a ~1.1x zoom), then
  // scroll halfway into the timeline. Before the maxEndsPrefix fix, the
  // long-spanning CrRendererMain root parents would disappear here.
  const surface = await page.$('[data-testid="timeline-event-surface"]')
  const box = await surface?.boundingBox()
  if (box) await page.mouse.move(box.x + 400, box.y + 200)
  await page.keyboard.down('Shift')
  for (let k = 0; k < 30; k++) await page.keyboard.press('w')
  await page.keyboard.up('Shift')
  await page.waitForTimeout(300)

  const state = await page.evaluate(() => {
    const el = document.querySelector(
      '[data-testid="timeline-event-surface"]',
    ) as HTMLElement | null
    const scroller = el?.parentElement as HTMLElement | null
    if (!scroller) return null
    scroller.scrollLeft = Math.max(0, Math.floor(scroller.scrollWidth * 0.35))
    return {
      scrollLeft: scroller.scrollLeft,
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
    }
  })
  console.log('scroll state ->', state)
  await page.waitForTimeout(400)
  const shot = path.resolve(__dirname, '../test-results/smoke-canvas.png')
  await page.screenshot({path: shot, fullPage: false})
  console.log('screenshot (zoomed+scrolled) ->', shot)

  // Also probe DOM structure for the first track row to confirm layout.
  const diag = await page.evaluate(() => {
    const canvases = Array.from(
      document.querySelectorAll('canvas[data-testid="track-canvas"]'),
    ) as HTMLCanvasElement[]
    return canvases.slice(0, 3).map(c => {
      const r = c.getBoundingClientRect()
      const parent = c.parentElement
      const parentRect = parent?.getBoundingClientRect()
      const cs = getComputedStyle(c)
      return {
        canvasRect: {x: r.x, y: r.y, w: r.width, h: r.height},
        styleWidth: c.style.width,
        styleHeight: c.style.height,
        attrWidth: c.width,
        attrHeight: c.height,
        position: cs.position,
        left: cs.left,
        display: cs.display,
        parentDisplay: parent ? getComputedStyle(parent).display : null,
        parentRect: parentRect
          ? {x: parentRect.x, y: parentRect.y, w: parentRect.width, h: parentRect.height}
          : null,
      }
    })
  })
  console.log(JSON.stringify(diag, null, 2))

  await browser.close()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
