import { render, screen, fireEvent } from '@testing-library/react'
import Splash from '../components/Splash'

describe('Splash', () => {
  it('renders drop prompt and browse button', () => {
    render(<Splash onFileSelected={() => {}} />)
    expect(screen.getByText('Drop your trace file here')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /browse files/i })).toBeInTheDocument()
  })

  it('clicking browse triggers the hidden file input', () => {
    render(<Splash onFileSelected={() => {}} />)
    const input = screen.getByTestId('file-input') as HTMLInputElement
    const clickSpy = jest.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: /browse files/i }))
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('selecting a file through the input calls onFileSelected', () => {
    const onFileSelected = jest.fn()
    render(<Splash onFileSelected={onFileSelected} />)

    const input = screen.getByTestId('file-input')
    const file = new File(['data'], 'sample.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [file] } })

    expect(onFileSelected).toHaveBeenCalledWith(file)
  })
})
