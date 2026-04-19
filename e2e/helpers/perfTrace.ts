import type {CDPSession, Page, TestInfo} from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface LongTask {
  /** performance.now() timestamp (ms) when the task started. */
  start: number
  /** Duration in ms. */
  dur: number
}

export interface InteractionMetrics {
  /** Sum of `RunTask` durations (ms) — total main-thread busy time. */
  runTask: number
  /** Scripting: `EvaluateScript` + `FunctionCall` + `V8.Execute` (ms). */
  scripting: number
  /** `Layout` events sum (ms). */
  layout: number
  /** `UpdateLayoutTree` / recalc style (ms). */
  recalcStyle: number
  /** `Paint` (ms). */
  paint: number
  /** `UpdateLayerTree` + `CompositeLayers` (ms) — compositor work. */
  composite: number
  /** Raw sum by event name (ms) — escape hatch for debugging. */
  byName: Record<string, number>
}

export interface InteractionReport {
  /** Long tasks (>50ms) observed between interaction start and end. */
  longTasks: LongTask[]
  /** Aggregated CDP tracing metrics. */
  metrics: InteractionMetrics
  /** Wall-clock interaction window length in ms (from the page's clock). */
  windowMs: number
  /** Path to the raw Chrome DevTools trace attached to the test. */
  tracePath: string
}

interface TraceEvent {
  name: string
  cat?: string
  ph: string
  ts: number
  dur?: number
  args?: unknown
}

const LONG_TASK_INIT = /* js */ `
if (!window.__perfecttoLongTasks) {
  window.__perfecttoLongTasks = []
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__perfecttoLongTasks.push({start: e.startTime, dur: e.duration})
      }
    }).observe({type: 'longtask', buffered: true})
  } catch {
    /* longtask not supported in this browser */
  }
}
`

/**
 * Ensures the long-task PerformanceObserver is running in the page. Safe to
 * call multiple times — idempotent because the installer key-guards itself.
 */
export async function installLongTaskObserver(page: Page): Promise<void> {
  await page.evaluate(LONG_TASK_INIT)
}

function aggregate(events: TraceEvent[]): InteractionMetrics {
  const byName: Record<string, number> = {}
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue
    // devtools.timeline uses microsecond durations.
    const durMs = e.dur / 1000
    byName[e.name] = (byName[e.name] ?? 0) + durMs
  }
  const sum = (...names: string[]) =>
    names.reduce((acc, n) => acc + (byName[n] ?? 0), 0)
  return {
    runTask: sum('RunTask'),
    scripting: sum('EvaluateScript', 'FunctionCall', 'V8.Execute'),
    layout: sum('Layout'),
    recalcStyle: sum('UpdateLayoutTree', 'RecalculateStyles', 'ParseAuthorStyleSheet'),
    paint: sum('Paint'),
    composite: sum('UpdateLayerTree', 'CompositeLayers', 'Commit'),
    byName,
  }
}

export interface MeasureOptions {
  /**
   * Label used in the saved artifact filename. Defaults to the test title.
   */
  label?: string
  /**
   * Extra ms to wait after the interaction callback resolves to let queued
   * main-thread work flush before ending the trace. Defaults to 250ms.
   */
  settleMs?: number
}

/**
 * Wraps an interaction with CDP `Tracing` + `PerformanceObserver('longtask')`
 * instrumentation, saves the raw Chrome trace as a test attachment, and
 * returns aggregated metrics + long-task list scoped to the interaction.
 */
export async function measureInteraction(
  page: Page,
  testInfo: TestInfo,
  run: () => Promise<void>,
  options: MeasureOptions = {},
): Promise<InteractionReport> {
  const {label = testInfo.title, settleMs = 250} = options

  await installLongTaskObserver(page)
  // Reset the buffer so we only count tasks inside this interaction's window.
  await page.evaluate(() => {
    window.__perfecttoLongTasks = []
  })

  const client: CDPSession = await page.context().newCDPSession(page)
  const events: TraceEvent[] = []
  const onData = (payload: unknown) => {
    const value = (payload as {value?: unknown}).value
    if (Array.isArray(value)) events.push(...(value as TraceEvent[]))
  }
  client.on('Tracing.dataCollected', onData as never)

  await client.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      recordMode: 'recordAsMuchAsPossible',
      includedCategories: [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'disabled-by-default-devtools.timeline.frame',
        'blink.user_timing',
        'loading',
        'latencyInfo',
      ],
      excludedCategories: ['*'],
    },
  })

  const t0 = await page.evaluate(() => performance.now())
  try {
    await run()
  } finally {
    if (settleMs > 0) await page.waitForTimeout(settleMs)
  }
  const t1 = await page.evaluate(() => performance.now())

  const tracingComplete = new Promise<void>((resolve) => {
    client.once('Tracing.tracingComplete', () => resolve())
  })
  await client.send('Tracing.end')
  await tracingComplete
  client.off('Tracing.dataCollected', onData as never)
  await client.detach().catch(() => {
    /* session may already be detached after Tracing.end in some cases */
  })

  const longTasks = (await page.evaluate(
    ([a, b]) =>
      (window.__perfecttoLongTasks ?? []).filter(
        (t) => t.start >= a && t.start <= b,
      ),
    [t0, t1] as const,
  )) as LongTask[]

  const safeLabel = label.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 80)
  const outDir = testInfo.outputDir
  await fs.mkdir(outDir, {recursive: true})
  const tracePath = path.join(outDir, `${safeLabel}.trace.json`)
  // Chrome DevTools Frontend loads trace files as `{traceEvents: [...]}`.
  // Perfectto's Chrome parser accepts either shape.
  await fs.writeFile(tracePath, JSON.stringify({traceEvents: events}))
  await testInfo.attach(`${safeLabel}.trace.json`, {
    path: tracePath,
    contentType: 'application/json',
  })

  const metrics = aggregate(events)
  return {
    longTasks,
    metrics,
    windowMs: t1 - t0,
    tracePath,
  }
}

/**
 * Pretty-prints metrics + long tasks into the Playwright report so failures
 * include the numbers that tripped the assertion without needing the attached
 * trace file.
 */
export function formatReport(report: InteractionReport): string {
  const {metrics, longTasks, windowMs} = report
  const ms = (n: number) => `${n.toFixed(2)}ms`
  return [
    `window:       ${ms(windowMs)}`,
    `runTask:      ${ms(metrics.runTask)}`,
    `scripting:    ${ms(metrics.scripting)}`,
    `layout:       ${ms(metrics.layout)}`,
    `recalcStyle:  ${ms(metrics.recalcStyle)}`,
    `paint:        ${ms(metrics.paint)}`,
    `composite:    ${ms(metrics.composite)}`,
    `longTasks:    ${longTasks.length} ${
      longTasks.length > 0
        ? `[${longTasks.map((t) => `${t.dur.toFixed(0)}ms`).join(', ')}]`
        : ''
    }`,
  ].join('\n')
}
