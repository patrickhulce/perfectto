import {render} from '@testing-library/react'
import Track from '../components/Track'
import type {Measure, Track as TrackModel} from '../core'
import type {Viewport} from '../components/timeline/useTimelineViewport'

function makeMeasure(partial: Partial<Measure> & {id: string; start: number; end: number}): Measure {
  return {
    name: partial.id,
    category: 'test',
    events: [],
    marks: [],
    measures: [],
    ...partial,
  }
}

function makeTrack(measures: Measure[]): TrackModel {
  const maxEnd = measures.reduce((m, x) => Math.max(m, x.end), 0)
  return {
    id: 'track-1',
    name: 'Track 1',
    category: 'thread',
    marks: [],
    measures,
    maxEnd,
  }
}

function viewport(partial: Partial<Viewport>): Viewport {
  const startMs = partial.startMs ?? 0
  const endMs = partial.endMs ?? 1000
  const containerWidthPx = partial.containerWidthPx ?? 1000
  const pxPerMs = containerWidthPx / Math.max(endMs - startMs, 0.01)
  return {
    startMs,
    endMs,
    containerWidthPx,
    pxPerMs,
    timeToPx: t => (t - startMs) * pxPerMs,
    ...partial,
  }
}

describe('Track', () => {
  it('renders only measures whose time span intersects the viewport', () => {
    const track = makeTrack([
      makeMeasure({id: 'left-of', start: 0, end: 10}),
      makeMeasure({id: 'visible', start: 100, end: 200}),
      makeMeasure({id: 'right-of', start: 900, end: 950}),
    ])
    const {container} = render(
      <Track
        track={track}
        viewport={viewport({startMs: 50, endMs: 500, containerWidthPx: 1000})}
        heightPx={30}
        labelWidthPx={100}
      />,
    )
    const measureEls = container.querySelectorAll('[title^="visible"], [title^="left-of"], [title^="right-of"]')
    const titles = Array.from(measureEls).map(el => el.getAttribute('title') ?? '')
    expect(titles.some(t => t.startsWith('visible'))).toBe(true)
    expect(titles.some(t => t.startsWith('right-of'))).toBe(false)
    expect(titles.some(t => t.startsWith('left-of'))).toBe(false)
  })

  it('skips measures (and their subtrees) whose rendered width is 1px or less', () => {
    // At 1px/ms, a 0.5ms-wide measure would render at 0.5px — drop it AND its child.
    const tiny = makeMeasure({
      id: 'tiny-parent',
      start: 100,
      end: 100.5,
      measures: [
        makeMeasure({id: 'tiny-child', start: 100.1, end: 100.4}),
      ],
    })
    const visible = makeMeasure({id: 'visible', start: 200, end: 300})

    const {container} = render(
      <Track
        track={makeTrack([tiny, visible])}
        viewport={viewport({startMs: 0, endMs: 1000, containerWidthPx: 1000})}
        heightPx={30}
        labelWidthPx={100}
      />,
    )
    const titles = Array.from(container.querySelectorAll('[title]')).map(
      el => el.getAttribute('title') ?? '',
    )
    expect(titles.some(t => t.startsWith('tiny-parent'))).toBe(false)
    expect(titles.some(t => t.startsWith('tiny-child'))).toBe(false)
    expect(titles.some(t => t.startsWith('visible'))).toBe(true)
  })

  it('renders sub-measures when zoomed in enough for them to exceed 1px', () => {
    const small = makeMeasure({id: 'small', start: 100, end: 100.5})
    const {container} = render(
      <Track
        track={makeTrack([small])}
        // At pxPerMs=100, a 0.5ms measure is 50px wide.
        viewport={viewport({startMs: 99, endMs: 109, containerWidthPx: 1000})}
        heightPx={30}
        labelWidthPx={100}
      />,
    )
    const titles = Array.from(container.querySelectorAll('[title]')).map(
      el => el.getAttribute('title') ?? '',
    )
    expect(titles.some(t => t.startsWith('small'))).toBe(true)
  })
})
