import {render, screen} from '@testing-library/react'
import AppHeader, {compoundTitle} from '../components/AppHeader'

describe('compoundTitle', () => {
  it('returns "Perfectto" when no panes are loaded', () => {
    expect(compoundTitle([])).toBe('Perfectto')
  })

  it('returns just the filename for a single pane', () => {
    expect(compoundTitle([{name: 'foo.json'}])).toBe('foo.json')
  })

  it('joins two filenames with " vs. "', () => {
    expect(compoundTitle([{name: 'a.json'}, {name: 'b.json'}])).toBe(
      'a.json vs. b.json',
    )
  })

  it('joins three+ filenames in the same pattern (forwards-compatible)', () => {
    expect(
      compoundTitle([
        {name: 'a.json'},
        {name: 'b.json'},
        {name: 'c.json'},
      ]),
    ).toBe('a.json vs. b.json vs. c.json')
  })
})

describe('AppHeader', () => {
  it('renders the single filename for N=1 with a matching title tooltip', () => {
    render(
      <AppHeader
        panes={[{name: 'first.json'}]}
        onBack={() => {}}
      />,
    )
    const title = screen.getByTestId('app-header-title')
    expect(title).toHaveTextContent('first.json')
    expect(title.getAttribute('title')).toBe('first.json')
  })

  it('renders the compound title for N=2 with a matching tooltip', () => {
    render(
      <AppHeader
        panes={[{name: 'a.json'}, {name: 'b.json'}]}
        onBack={() => {}}
      />,
    )
    const title = screen.getByTestId('app-header-title')
    expect(title).toHaveTextContent('a.json vs. b.json')
    expect(title.getAttribute('title')).toBe('a.json vs. b.json')
  })

  it('falls back to "Perfectto" with no panes (defensive — splash usually owns this case)', () => {
    render(<AppHeader panes={[]} onBack={() => {}} />)
    expect(screen.getByTestId('app-header-title')).toHaveTextContent('Perfectto')
  })

  it('truncates with ellipsis on overflow (CSS classes wired through)', () => {
    render(
      <AppHeader
        panes={[{name: 'a-very-very-long-filename.json'}]}
        onBack={() => {}}
      />,
    )
    const title = screen.getByTestId('app-header-title')
    expect(title.className).toMatch(/truncate|overflow-hidden/)
  })

  it('does not render the persona picker until all required props are present', () => {
    render(<AppHeader panes={[{name: 'a.json'}]} onBack={() => {}} />)
    expect(screen.queryByLabelText(/persona/i)).toBeNull()
  })
})
