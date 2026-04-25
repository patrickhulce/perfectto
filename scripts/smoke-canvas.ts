import {chromium, type Page} from '@playwright/test'
import {createWriteStream} from 'node:fs'
import {mkdir} from 'node:fs/promises'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {fileURLToPath} from 'node:url'

import {streamSyntheticTrace} from '../src/__tests__/fixtures/generateChromeTrace'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const REAL_TRACE = path.resolve(__dirname, '../assets/perfecto-chrome-trace.json')
const SYNTHETIC_DIR = path.resolve(__dirname, '../test-results/synthetic-traces')

type SyntheticSize = 'small' | '1gb' | '2gb' | '4gb'

interface Config {
  /** Path on disk of the trace file to load. */
  tracePath: string
  /** Human label printed with timings. */
  label: string
  /** Whether to print peak memory from performance.memory. */
  reportMemory: boolean
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const syntheticArg = args.find(a => a.startsWith('--synthetic='))
  const syntheticSize = (syntheticArg?.split('=')[1] ?? null) as SyntheticSize | null

  const config = syntheticSize
    ? await prepareSynthetic(syntheticSize)
    : {tracePath: REAL_TRACE, label: 'real-trace', reportMemory: false}

  const browser = await chromium.launch({headless: true})
  const context = await browser.newContext({viewport: {width: 1600, height: 900}})
  const page = await context.newPage()

  await page.goto('http://localhost:5173/')

  const parseStart = Date.now()
  await page.getByTestId('file-input').setInputFiles(config.tracePath)
  await page.getByTestId('timeline-event-surface').waitFor({timeout: 600_000})
  const parseMs = Date.now() - parseStart
  console.log(`[${config.label}] parse + first-frame wall time: ${parseMs} ms`)

  if (config.reportMemory) {
    const mem = await page.evaluate(() => {
      const m = (performance as {memory?: {usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number}}).memory
      return m
        ? {
            usedJSHeapSize: m.usedJSHeapSize,
            totalJSHeapSize: m.totalJSHeapSize,
            jsHeapSizeLimit: m.jsHeapSizeLimit,
          }
        : null
    })
    if (mem) {
      const mb = (b: number): string => `${(b / 1024 / 1024).toFixed(1)} MB`
      console.log(
        `[${config.label}] js heap: used=${mb(mem.usedJSHeapSize)} total=${mb(mem.totalJSHeapSize)} limit=${mb(mem.jsHeapSizeLimit)}`,
      )
    } else {
      console.log(`[${config.label}] performance.memory unavailable in this browser`)
    }
  }

  await page.waitForTimeout(750)
  const before = path.resolve(__dirname, '../test-results/smoke-canvas-top.png')
  await page.screenshot({path: before, fullPage: false})
  console.log('screenshot (top) ->', before)

  await zoomAndScroll(page)
  const shot = path.resolve(__dirname, '../test-results/smoke-canvas.png')
  await page.screenshot({path: shot, fullPage: false})
  console.log('screenshot (zoomed+scrolled) ->', shot)

  await browser.close()
}

async function zoomAndScroll(page: Page): Promise<void> {
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
}

/**
 * Stream a synthetic trace into a temp file on disk so the page's
 * `<input type=file>` can accept it. We deliberately go through disk
 * rather than `page.addInitScript` because the parser path we want to
 * exercise is exactly the one a real user hits when dropping a file —
 * an in-memory buffer would bypass `loadFile` and the stream-reader
 * plumbing.
 */
async function prepareSynthetic(size: SyntheticSize): Promise<Config> {
  const knobs = syntheticKnobs(size)
  await mkdir(SYNTHETIC_DIR, {recursive: true})
  const tracePath = path.join(SYNTHETIC_DIR, `synthetic-${size}.json`)
  console.log(`[synthetic:${size}] writing ${tracePath} …`)

  const t0 = Date.now()
  const {stream, manifest} = streamSyntheticTrace(knobs)
  const nodeStream = Readable.fromWeb(stream as unknown as import('node:stream/web').ReadableStream<Uint8Array>)
  const out = createWriteStream(tracePath)
  await pipeline(nodeStream, out)
  const writeMs = Date.now() - t0
  console.log(
    `[synthetic:${size}] wrote ${manifest.byteLength.toLocaleString()} B (${manifest.totalEvents.toLocaleString()} events, ${manifest.jsSampleCount.toLocaleString()} samples) in ${writeMs} ms`,
  )

  return {
    tracePath,
    label: `synthetic:${size}`,
    reportMemory: true,
  }
}

function syntheticKnobs(size: SyntheticSize): Parameters<typeof streamSyntheticTrace>[0] {
  switch (size) {
    case 'small':
      return {
        eventCount: 50_000,
        threadCount: 2,
        jsSampleCount: 10_000,
        cpuNodeCount: 16,
        shape: 'flat',
        nameTemplate: 'evt{i}',
      }
    case '1gb':
      return {
        eventCount: 3_000_000,
        threadCount: 4,
        jsSampleCount: 500_000,
        cpuNodeCount: 64,
        shape: 'flat',
        sameNameRunLength: 200_000,
        nameTemplate: 'evt{i}',
      }
    case '2gb':
      return {
        eventCount: 6_000_000,
        threadCount: 4,
        jsSampleCount: 1_000_000,
        cpuNodeCount: 128,
        shape: 'flat',
        sameNameRunLength: 500_000,
        nameTemplate: 'evt{i}',
      }
    case '4gb':
      return {
        eventCount: 12_000_000,
        threadCount: 8,
        jsSampleCount: 2_000_000,
        cpuNodeCount: 256,
        shape: 'flat',
        sameNameRunLength: 1_000_000,
        nameTemplate: 'evt{i}',
      }
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
