export interface LinkedViewportState {
  /** Pane that most recently published the linked viewport. */
  sourcePaneId: string
  /** Timeline ms at the left edge of visible track content. */
  startMs: number
  /** Shared zoom scale, in CSS pixels per millisecond. */
  pxPerMs: number
  /** Monotonic write counter so subscribers can ignore stale echoes. */
  epoch: number
}

export type LinkedViewportListener = (state: LinkedViewportState) => void

export class LinkedViewportStore {
  private state: LinkedViewportState | null = null
  private listeners = new Set<LinkedViewportListener>()
  private nextEpoch = 0

  get(): LinkedViewportState | null {
    return this.state
  }

  publish(next: Omit<LinkedViewportState, 'epoch'>): void {
    this.nextEpoch += 1
    this.state = {...next, epoch: this.nextEpoch}
    for (const fn of this.listeners) fn(this.state)
  }

  subscribe(fn: LinkedViewportListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
}

export function createLinkedViewportStore(): LinkedViewportStore {
  return new LinkedViewportStore()
}
