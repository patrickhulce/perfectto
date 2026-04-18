/**
 * Yield to the host event loop so queued tasks (abort messages, outgoing
 * postMessages, re-renders, etc.) get a chance to run between CPU-heavy work.
 *
 * Prefers `scheduler.yield()` where available (Chromium), then falls back to a
 * `MessageChannel` microtask-adjacent trick (much faster than `setTimeout(0)`
 * which is clamped to 4 ms after a few nested calls), then finally
 * `setTimeout(0)`.
 */

type Scheduler = {yield?: () => Promise<void>}

const scheduler: Scheduler | undefined =
  typeof globalThis !== 'undefined'
    ? (globalThis as {scheduler?: Scheduler}).scheduler
    : undefined

let channelYield: (() => Promise<void>) | null = null
if (typeof MessageChannel !== 'undefined') {
  const channel = new MessageChannel()
  const waiters: Array<() => void> = []
  channel.port1.onmessage = () => {
    const next = waiters.shift()
    if (next) next()
  }
  channelYield = () =>
    new Promise<void>(resolve => {
      waiters.push(resolve)
      channel.port2.postMessage(null)
    })
}

export function yieldToEventLoop(): Promise<void> {
  if (scheduler && typeof scheduler.yield === 'function') {
    return scheduler.yield()
  }
  if (channelYield) return channelYield()
  return new Promise(resolve => setTimeout(resolve, 0))
}
