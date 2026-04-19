import {test as base, expect, type Page} from '@playwright/test'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const SAMPLE_TRACE_PATH = path.resolve(
  __dirname,
  '../../assets/perfecto-chrome-trace.json',
)

/**
 * Opens the app at `/`, uploads the bundled sample trace via the hidden file
 * input, and waits for the timeline surface to be mounted. Tests receive a
 * `page` that is already sitting on the timeline, ready to be interacted with.
 */
export async function loadSampleTrace(page: Page): Promise<void> {
  await page.goto('/')
  const fileInput = page.getByTestId('file-input')
  await fileInput.setInputFiles(SAMPLE_TRACE_PATH)
  const surface = page.getByTestId('timeline-event-surface')
  await expect(surface).toBeVisible({timeout: 60_000})
  // Wait until the event surface has a real (>0) width/height so the viewport
  // has finished its initial measurement pass.
  await expect
    .poll(
      async () => {
        const box = await surface.boundingBox()
        return box ? Math.min(box.width, box.height) : 0
      },
      {timeout: 10_000},
    )
    .toBeGreaterThan(100)
  // Small idle settle so initial render + layout effects complete before any
  // perf measurement starts.
  await page.waitForTimeout(250)
}

export const test = base.extend<{traceLoaded: void}>({
  traceLoaded: [
    async ({page}, use) => {
      await loadSampleTrace(page)
      await use()
    },
    {auto: true},
  ],
})

export {expect}
