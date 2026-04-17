import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import App from '../App'

describe('App', () => {
  it('renders the splash screen initially', () => {
    render(<App />)
    expect(screen.getByText('Perfectto')).toBeInTheDocument()
    expect(screen.getByText('Drop your trace file here')).toBeInTheDocument()
  })

  it('transitions to the trace viewer when a file is selected and returns on Back', async () => {
    render(<App />)

    const input = screen.getByTestId('file-input')
    const file = new File(['{"event":"sample"}'], 'trace.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'trace.json' })).toBeInTheDocument(),
    )

    expect(screen.getByText('Browser')).toBeInTheDocument()
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
        controller.enqueue(new TextEncoder().encode('chunk-1'))
        await gate
        controller.close()
      },
    })

    const file = new File(['payload'], 'big.json', { type: 'application/json' })
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
      expect(screen.getByRole('heading', { name: 'big.json' })).toBeInTheDocument(),
    )
  })

  it('returns to the splash when parsing is cancelled mid-stream', async () => {
    const stuckStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'))
      },
    })

    const file = new File(['payload'], 'huge.json', { type: 'application/json' })
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
