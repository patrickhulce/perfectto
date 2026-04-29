import { render, screen, fireEvent, createEvent, waitFor, within } from '@testing-library/react'
import App from '../App'

const MINIMAL_TRACE = JSON.stringify({
  traceEvents: [
    { ph: 'X', name: 'task', cat: 'test', pid: 1, tid: 1, ts: 0, dur: 10 },
  ],
})

/**
 * jsdom defaults to 1024x768. The drop-zone hit-test computes a
 * centered rectangle covering 40% × 30% of the viewport, which
 * spans (307,269)→(717,499). These coords therefore land squarely
 * inside the center rect (replace), the top half above it (top),
 * and the bottom half below it (bottom).
 */
const CENTER_DROP = { clientX: 512, clientY: 384 }
const TOP_DROP = { clientX: 100, clientY: 50 }
const BOTTOM_DROP = { clientX: 100, clientY: 700 }

/**
 * Dispatch a synthetic `drop` event with the given client coords.
 * Necessary because jsdom's `DragEvent` ignores the `clientX` /
 * `clientY` keys passed to the constructor's init dict; we have to
 * assign them on the event after construction so React's synthetic
 * event reads non-undefined values.
 */
function dropAt(
  target: Element,
  coords: { clientX: number; clientY: number },
  files: File[],
): void {
  const event = createEvent.drop(target, {
    dataTransfer: { files, types: ['Files'] },
  })
  Object.defineProperty(event, 'clientX', { value: coords.clientX })
  Object.defineProperty(event, 'clientY', { value: coords.clientY })
  fireEvent(target, event)
}

/**
 * Find the element a drop event will be dispatched against. Anything
 * inside the App root works because the page-wide `onDrop` handler
 * lives on the outermost `<div>` — pick the first child of the
 * render container, which is the App's flex column wrapper.
 */
function getAppRoot(container: HTMLElement): HTMLElement {
  const root = container.firstElementChild
  if (!(root instanceof HTMLElement)) {
    throw new Error('App root not found')
  }
  return root
}

/**
 * Read the filename out of the per-pane `TracePaneHeader`. The
 * filename is rendered as an `<h2>` inside the strip; just pulling
 * `textContent` on the strip itself also includes the size pill, so
 * grab the first heading instead.
 */
function paneFilename(pane: HTMLElement): string {
  const heading = within(pane).getByRole('heading', { level: 2 })
  return heading.textContent ?? ''
}

describe('App', () => {
  it('renders the splash screen initially', () => {
    render(<App />)
    expect(screen.getByText('Perfectto')).toBeInTheDocument()
    expect(screen.getByText('Drop your trace file here')).toBeInTheDocument()
  })

  it('transitions to the trace viewer when a file is selected and returns on Back', async () => {
    render(<App />)

    const input = screen.getByTestId('file-input')
    const file = new File([MINIMAL_TRACE], 'trace.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() =>
      expect(screen.getByTestId('app-header-title')).toHaveTextContent('trace.json'),
    )
    expect(screen.getByTestId('trace-pane-header')).toHaveTextContent('trace.json')
    expect(screen.getByRole('heading', { name: 'Aggregator' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /back/i }))

    expect(screen.getByText('Drop your trace file here')).toBeInTheDocument()
  })

  it('shows a parsing progress view between file selection and the trace viewer', async () => {
    let resolveChunk!: () => void
    const gate = new Promise<void>((r) => {
      resolveChunk = r
    })

    const slowStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(new TextEncoder().encode(MINIMAL_TRACE))
        await gate
        controller.close()
      },
    })

    const file = new File([MINIMAL_TRACE], 'big.json', { type: 'application/json' })
    Object.defineProperty(file, 'stream', { value: () => slowStream })
    Object.defineProperty(file, 'size', { value: 1024 })

    render(<App />)
    const input = screen.getByTestId('file-input')
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() =>
      expect(screen.getByText('Parsing trace…')).toBeInTheDocument(),
    )
    expect(screen.getByText('big.json')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()

    resolveChunk()

    await waitFor(() =>
      expect(screen.getByTestId('trace-pane-header')).toHaveTextContent('big.json'),
    )
  })

  it('dropping a file anywhere on the page loads it', async () => {
    const { container } = render(<App />)
    const root = getAppRoot(container)

    const file = new File([MINIMAL_TRACE], 'dropped.json', {
      type: 'application/json',
    })
    fireEvent.drop(root, { dataTransfer: { files: [file], types: ['Files'] } })

    await waitFor(() =>
      expect(screen.getByTestId('trace-pane-header')).toHaveTextContent('dropped.json'),
    )
  })

  it('dropping a file while a trace is loaded routes through the parse progress view', async () => {
    const { container } = render(<App />)

    const input = screen.getByTestId('file-input')
    const first = new File([MINIMAL_TRACE], 'first.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [first] } })
    await waitFor(() =>
      expect(screen.getByTestId('trace-pane-header')).toHaveTextContent('first.json'),
    )

    let resolveSecond!: () => void
    const gate = new Promise<void>((r) => {
      resolveSecond = r
    })
    const slowStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(new TextEncoder().encode(MINIMAL_TRACE))
        await gate
        controller.close()
      },
    })
    const second = new File([MINIMAL_TRACE], 'second.json', {
      type: 'application/json',
    })
    Object.defineProperty(second, 'stream', { value: () => slowStream })
    Object.defineProperty(second, 'size', { value: 1024 })

    // Drop into the center rectangle ("replace all") so the new trace
    // takes over the only pane — same end state as the legacy
    // single-trace replacement flow.
    dropAt(getAppRoot(container), CENTER_DROP, [second])

    await waitFor(() =>
      expect(screen.getByText('Parsing trace…')).toBeInTheDocument(),
    )
    expect(screen.getByText('second.json')).toBeInTheDocument()
    // The original pane's header should be gone — replace-all wipes it.
    expect(screen.queryByTestId('trace-pane-header')).not.toBeInTheDocument()

    resolveSecond()

    await waitFor(() =>
      expect(screen.getByTestId('trace-pane-header')).toHaveTextContent('second.json'),
    )
  })

  it('dropping into the top zone with one trace loaded prepends a second pane', async () => {
    const { container } = render(<App />)
    const input = screen.getByTestId('file-input')
    const first = new File([MINIMAL_TRACE], 'first.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [first] } })
    await waitFor(() =>
      expect(screen.getByTestId('trace-pane-header')).toHaveTextContent('first.json'),
    )

    const second = new File([MINIMAL_TRACE], 'second.json', { type: 'application/json' })
    dropAt(getAppRoot(container), TOP_DROP, [second])

    await waitFor(() =>
      expect(screen.getAllByTestId('trace-pane')).toHaveLength(2),
    )
    const panes = screen.getAllByTestId('trace-pane')
    // Prepend = new pane at index 0.
    expect(paneFilename(panes[0])).toBe('second.json')
    expect(paneFilename(panes[1])).toBe('first.json')
    // The compound title now lists both files.
    expect(screen.getByTestId('app-header-title')).toHaveTextContent(
      'second.json vs. first.json',
    )
  })

  it('dropping into the bottom zone appends a new pane below', async () => {
    const { container } = render(<App />)
    const input = screen.getByTestId('file-input')
    const first = new File([MINIMAL_TRACE], 'first.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [first] } })
    await waitFor(() =>
      expect(screen.getByTestId('trace-pane-header')).toHaveTextContent('first.json'),
    )

    const second = new File([MINIMAL_TRACE], 'second.json', { type: 'application/json' })
    dropAt(getAppRoot(container), BOTTOM_DROP, [second])

    await waitFor(() =>
      expect(screen.getAllByTestId('trace-pane')).toHaveLength(2),
    )
    const panes = screen.getAllByTestId('trace-pane')
    expect(paneFilename(panes[0])).toBe('first.json')
    expect(paneFilename(panes[1])).toBe('second.json')
    expect(screen.getByTestId('app-header-title')).toHaveTextContent(
      'first.json vs. second.json',
    )
  })

  it('at N=2, a top-zone drop replaces pane 0 in place', async () => {
    const { container } = render(<App />)
    const input = screen.getByTestId('file-input')

    // Seed two panes.
    const first = new File([MINIMAL_TRACE], 'first.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [first] } })
    await waitFor(() =>
      expect(screen.getByTestId('trace-pane-header')).toHaveTextContent('first.json'),
    )
    const second = new File([MINIMAL_TRACE], 'second.json', { type: 'application/json' })
    dropAt(getAppRoot(container), BOTTOM_DROP, [second])
    await waitFor(() =>
      expect(screen.getAllByTestId('trace-pane')).toHaveLength(2),
    )

    // Drop a third file into the top zone — should replace pane[0]
    // (first.json) and keep pane[1] (second.json) untouched.
    const third = new File([MINIMAL_TRACE], 'third.json', { type: 'application/json' })
    dropAt(getAppRoot(container), TOP_DROP, [third])

    await waitFor(() => {
      const panes = screen.getAllByTestId('trace-pane')
      expect(panes).toHaveLength(2)
      expect(paneFilename(panes[0])).toBe('third.json')
      expect(paneFilename(panes[1])).toBe('second.json')
    })
    // first.json is gone; we never stacked past the N=2 cap.
    const headers = screen.getAllByTestId('trace-pane-header').map(h => h.textContent ?? '')
    expect(headers.some(t => t.includes('first.json'))).toBe(false)
  })

  it('at N=2, a bottom-zone drop replaces pane 1 in place', async () => {
    const { container } = render(<App />)
    const input = screen.getByTestId('file-input')

    const first = new File([MINIMAL_TRACE], 'first.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [first] } })
    await waitFor(() =>
      expect(screen.getByTestId('trace-pane-header')).toHaveTextContent('first.json'),
    )
    const second = new File([MINIMAL_TRACE], 'second.json', { type: 'application/json' })
    dropAt(getAppRoot(container), BOTTOM_DROP, [second])
    await waitFor(() =>
      expect(screen.getAllByTestId('trace-pane')).toHaveLength(2),
    )

    // Drop a third file into the bottom zone — should replace pane[1]
    // (second.json) and keep pane[0] (first.json).
    const third = new File([MINIMAL_TRACE], 'third.json', { type: 'application/json' })
    dropAt(getAppRoot(container), BOTTOM_DROP, [third])

    await waitFor(() => {
      const panes = screen.getAllByTestId('trace-pane')
      expect(panes).toHaveLength(2)
      expect(paneFilename(panes[0])).toBe('first.json')
      expect(paneFilename(panes[1])).toBe('third.json')
    })
    const headers = screen.getAllByTestId('trace-pane-header').map(h => h.textContent ?? '')
    expect(headers.some(t => t.includes('second.json'))).toBe(false)
  })

  it('dropping into the center zone with multiple panes collapses to a single pane', async () => {
    const { container } = render(<App />)
    const input = screen.getByTestId('file-input')

    const first = new File([MINIMAL_TRACE], 'first.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [first] } })
    await waitFor(() =>
      expect(screen.getByTestId('trace-pane-header')).toHaveTextContent('first.json'),
    )

    const second = new File([MINIMAL_TRACE], 'second.json', { type: 'application/json' })
    dropAt(getAppRoot(container), BOTTOM_DROP, [second])
    await waitFor(() =>
      expect(screen.getAllByTestId('trace-pane')).toHaveLength(2),
    )

    const third = new File([MINIMAL_TRACE], 'third.json', { type: 'application/json' })
    dropAt(getAppRoot(container), CENTER_DROP, [third])

    await waitFor(() => {
      const panes = screen.getAllByTestId('trace-pane')
      expect(panes).toHaveLength(1)
      expect(paneFilename(panes[0])).toBe('third.json')
    })
    expect(screen.getByTestId('app-header-title')).toHaveTextContent('third.json')
  })

  it('parsing in one pane leaves an existing loaded pane interactive', async () => {
    const { container } = render(<App />)
    const input = screen.getByTestId('file-input')

    const first = new File([MINIMAL_TRACE], 'first.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [first] } })
    await waitFor(() =>
      expect(screen.getByTestId('trace-pane-header')).toHaveTextContent('first.json'),
    )

    let resolveSecond!: () => void
    const gate = new Promise<void>((r) => {
      resolveSecond = r
    })
    const slowStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(new TextEncoder().encode(MINIMAL_TRACE))
        await gate
        controller.close()
      },
    })
    const second = new File([MINIMAL_TRACE], 'pending.json', { type: 'application/json' })
    Object.defineProperty(second, 'stream', { value: () => slowStream })
    Object.defineProperty(second, 'size', { value: 1024 })

    dropAt(getAppRoot(container), BOTTOM_DROP, [second])

    await waitFor(() =>
      expect(screen.getByText('Parsing trace…')).toBeInTheDocument(),
    )
    // The loaded pane (first.json) should still be present alongside
    // the parsing one.
    const headers = screen.getAllByTestId('trace-pane-header')
    expect(headers.some(h => (h.textContent ?? '').includes('first.json'))).toBe(true)
    expect(screen.getByRole('heading', { name: /Aggregator/ })).toBeInTheDocument()

    resolveSecond()
    await waitFor(() => {
      const panes = screen.getAllByTestId('trace-pane')
      expect(panes).toHaveLength(2)
      expect(paneFilename(panes[1])).toBe('pending.json')
    })
  })

  it('returns to the splash when parsing is cancelled mid-stream', async () => {
    const prefix = '{"traceEvents":['
    const stuckStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(prefix))
      },
    })

    const file = new File([prefix], 'huge.json', { type: 'application/json' })
    Object.defineProperty(file, 'stream', { value: () => stuckStream })

    render(<App />)
    const input = screen.getByTestId('file-input')
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() =>
      expect(screen.getByText('Parsing trace…')).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    await waitFor(() =>
      expect(screen.getByText('Drop your trace file here')).toBeInTheDocument(),
    )
  })
})
