import { describe, expect, it, vi } from 'vitest'
import { canvasPageURL } from '../shared/canvas'
import { buildCanvasPage, parseCanvasURL } from './canvas-protocol'

const theme = { background: '#111', foreground: '#eee', muted: '#999', border: '#333', accent: '#4af', kind: 'dark' as const }

describe('canvas protocol URLs', () => {
  it('round-trips a page URL with its theme and ignores the reload key', () => {
    const url = canvasPageURL({ profileId: 'p 1', profileGeneration: 3, sessionId: 'sess_a', name: 'report.v2', theme, reloadKey: '7-1' })
    expect(url).toContain('r=7-1')
    expect(parseCanvasURL(url)).toEqual({ profileId: 'p 1', profileGeneration: 3, sessionId: 'sess_a', name: 'report.v2', theme })
  })

  it('rejects foreign schemes, malformed paths, and bad names', () => {
    expect(parseCanvasURL('https://canvas/p/1/s/n/index.html')).toBeNull()
    expect(parseCanvasURL('agentsdock-canvas://canvas/p/1/s/index.html')).toBeNull()
    expect(parseCanvasURL('agentsdock-canvas://canvas/p/x/s/n/index.html')).toBeNull()
    expect(parseCanvasURL('agentsdock-canvas://canvas/p/1/s/..%2Fn/index.html')).toBeNull()
  })

  it('falls back to the default theme when the query is unusable', () => {
    const parsed = parseCanvasURL('agentsdock-canvas://canvas/p/1/s/n/index.html?theme=%7Bnope')
    expect(parsed?.theme.kind).toBe('dark')
    expect(parsed?.theme.background).toMatch(/^#/)
  })
})

describe('buildCanvasPage', () => {
  it('inlines the bridge, vendor, bundle and mount call as data: scripts', () => {
    const html = buildCanvasPage({
      shell: '<html><body><div id="root"></div><!--CANVAS_SCRIPTS--></body></html>',
      vendor: 'VENDOR()',
      javascript: 'var CanvasModule = 1;',
      state: { clicks: 2 },
      theme
    })
    const scripts = html.match(/<script src="data:application\/javascript;base64,([^"]+)"><\/script>/g) ?? []
    expect(scripts).toHaveLength(4)
    const decoded = scripts.map(tag => Buffer.from(tag.match(/base64,([^"]+)/)![1], 'base64').toString('utf8'))
    expect(decoded[0]).toContain('window.webkit = { messageHandlers: { zedCanvas:')
    // The shim answers the host's in-page find protocol itself; the runtime has no such method.
    expect(decoded[0]).toContain("data.call === 'find'")
    expect(decoded[0]).toContain("data.call === 'clear-find'")
    expect(decoded[0]).toContain("type: 'find-result'")
    expect(decoded[0]).toContain('CSS.highlights.set')
    expect(decoded[1]).toBe('VENDOR()')
    expect(decoded[2]).toBe('var CanvasModule = 1;')
    expect(decoded[3]).toBe(`__zedCanvasHost.mount({"clicks":2}, ${JSON.stringify(theme)});`)
    expect(html).not.toContain('<!--CANVAS_SCRIPTS-->')
  })

  it('refuses a shell without the placeholder', () => {
    expect(() => buildCanvasPage({ shell: '<html></html>', vendor: '', javascript: '', state: {}, theme })).toThrow(/placeholder/)
  })
})

describe('comment pins in the canvas page', () => {
  it('pins open threads to their elements, reports which exist, and opens a thread from its pin', () => {
    document.body.innerHTML = '<div id="root"><section data-canvas-id="summary"><table><tr><td>loss\n 2.41</td><td>other</td></tr></table></section><h1>Title here</h1></div>'
    const html = buildCanvasPage({ shell: '<!--CANVAS_SCRIPTS-->', vendor: '', javascript: '', state: {}, theme })
    const shim = Buffer.from(html.match(/base64,([^"]+)/)![1], 'base64').toString('utf8')
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    vi.stubGlobal('ResizeObserver', class { observe() {} })
    vi.stubGlobal('CSS', { escape: (value: string) => value })
    const posted = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    const flush = () => { while (frames.length) frames.shift()!(0) }
    try {
      new Function(shim)()
      const pins = (window as unknown as { __agentsdockComments: { set: (pins: unknown[], active: string | null) => void } }).__agentsdockComments
      pins.set([
        { id: 'a', number: 1, canvasId: 'summary', tag: 'td', text: 'loss 2.41', label: 'summary' },
        { id: 'b', number: 2, canvasId: null, tag: 'h1', text: 'Title here' },
        { id: 'c', number: 3, canvasId: 'gone', tag: 'p', text: 'x' }
      ], 'a')
      flush()

      const buttons = [...document.querySelectorAll<HTMLButtonElement>('#agentsdock-comment-pins button')]
      expect(buttons.map(button => button.textContent)).toEqual(['1', '2'])
      expect(buttons[0].className).toBe('active')
      expect(document.querySelector('td')!.getAttribute('data-agentsdock-comment')).toBe('active')
      // The pin layer sits outside #root, where React never renders.
      expect(document.getElementById('root')!.contains(buttons[0])).toBe(false)
      expect(posted).toHaveBeenCalledWith({ source: 'agentsdock-canvas', message: { kind: 'comment-anchors', located: ['a', 'b'] } }, '*')

      buttons[1].click()
      expect(posted).toHaveBeenLastCalledWith({ source: 'agentsdock-canvas', message: { kind: 'comment-open', id: 'b' } }, '*')

      window.dispatchEvent(new MessageEvent('message', { data: { source: 'agentsdock-canvas-host', call: 'set-comments', args: [[], null] } }))
      flush()
      expect(document.querySelectorAll('#agentsdock-comment-pins button')).toHaveLength(0)
      expect(document.querySelector('[data-agentsdock-comment]')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
      posted.mockRestore()
      document.body.innerHTML = ''
    }
  })
})

describe('floating table of contents in the canvas page', () => {
  it('lists the headings on request, marks the section in view, scrolls on click and stays out of find', async () => {
    document.body.innerHTML = '<div id="root"><h1>Report</h1><p>Loss fell.</p><h2>Loss</h2><h3>Details</h3><h2>Appendix</h2></div>'
    const html = buildCanvasPage({ shell: '<!--CANVAS_SCRIPTS-->', vendor: '', javascript: '', state: {}, theme })
    const shim = Buffer.from(html.match(/base64,([^"]+)/)![1], 'base64').toString('utf8')
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    vi.stubGlobal('CSS', { highlights: new Map() })
    vi.stubGlobal('Highlight', class {})
    const scrolled = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrolled })
    const posted = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
    const flush = async () => { await Promise.resolve(); while (frames.length) frames.shift()!(0) }
    const host = (call: string, args: unknown[]) => window.dispatchEvent(new MessageEvent('message', { data: { source: 'agentsdock-canvas-host', call, args } }))
    try {
      new Function(shim)()
      await flush()
      const container = document.querySelector('agentsdock-toc')!
      const nav = container.shadowRoot!.querySelector('nav')!
      const entries = () => [...nav.querySelectorAll<HTMLButtonElement>('button')]
      expect(posted).toHaveBeenCalledWith({ source: 'agentsdock-canvas', message: { kind: 'toc', available: true } }, '*')
      // The host decides; nothing shows before it asks.
      expect(nav.hidden).toBe(true)
      expect(document.getElementById('root')!.contains(container)).toBe(false)

      host('set-toc', [true])
      await flush()
      expect(nav.hidden).toBe(false)
      expect(entries().map(entry => [entry.textContent, entry.style.paddingLeft])).toEqual([['Report', '12px'], ['Loss', '24px'], ['Details', '36px'], ['Appendix', '24px']])

      // "Details" measures 0x0 at the top, like a heading inside a display:none subtree: never the section in view.
      const rects = [{ top: -400, height: 30 }, { top: -100, height: 24 }, { top: 0, height: 0 }, { top: 900, height: 24 }]
      document.querySelectorAll('#root h1, #root h2, #root h3').forEach((heading, index) => {
        vi.spyOn(heading, 'getBoundingClientRect').mockReturnValue(rects[index] as DOMRect)
      })
      window.dispatchEvent(new Event('scroll'))
      await flush()
      expect(entries().filter(entry => entry.classList.contains('active')).map(entry => entry.textContent)).toEqual(['Loss'])

      entries()[3].click()
      expect(scrolled).toHaveBeenLastCalledWith({ block: 'start', behavior: 'smooth' })
      expect(scrolled.mock.contexts.at(-1)).toBe(document.querySelectorAll('#root h2')[1])

      // In-page find walks the light DOM only: the table of contents' copy of "Loss" is not a match.
      host('find', ['Loss', {}])
      expect(posted).toHaveBeenLastCalledWith({ source: 'agentsdock-canvas', message: { type: 'find-result', total: 2, active: 1 } }, '*')

      document.querySelector('#root h3')!.remove()
      await flush()
      expect(entries().map(entry => entry.textContent)).toEqual(['Report', 'Loss', 'Appendix'])

      host('set-toc', [false])
      await flush()
      expect(nav.hidden).toBe(true)
      // Fewer than two headings: nothing to show, even when the host asks, and the host is told.
      host('set-toc', [true])
      document.querySelectorAll('#root h2').forEach(heading => heading.remove())
      await flush()
      expect(nav.hidden).toBe(true)
      expect(posted).toHaveBeenLastCalledWith({ source: 'agentsdock-canvas', message: { kind: 'toc', available: false } }, '*')
    } finally {
      vi.unstubAllGlobals()
      posted.mockRestore()
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
      document.body.innerHTML = ''
    }
  })
})
