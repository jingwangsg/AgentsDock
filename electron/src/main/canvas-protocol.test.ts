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
