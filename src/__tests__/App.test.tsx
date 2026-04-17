import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import App from '../App.jsx'

describe('App', () => {
  it('renders the splash screen initially', () => {
    render(<App />)
    expect(screen.getByText('Perfectto')).toBeInTheDocument()
    expect(screen.getByText('Drop your trace file here')).toBeInTheDocument()
  })

  it('transitions to the viewer when a file is selected and returns on Back', async () => {
    render(<App />)

    const input = screen.getByTestId('file-input')
    const file = new File(['{"event":"sample"}'], 'trace.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'trace.json' })).toBeInTheDocument(),
    )
    expect(screen.getByText(/"event":"sample"/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /back/i }))

    expect(screen.getByText('Drop your trace file here')).toBeInTheDocument()
  })

  it('shows truncation notice when the file is larger than the preview limit', async () => {
    render(<App />)

    const input = screen.getByTestId('file-input')
    const bigContent = 'x'.repeat(10001)
    const file = new File([bigContent], 'big.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() =>
      expect(screen.getByText(/Showing first 10,000 of 10,001 characters\./)).toBeInTheDocument(),
    )
  })
})
