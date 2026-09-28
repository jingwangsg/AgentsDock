import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const ipc = new Map<string, Listener>()
  const appListeners = new Map<string, Listener>()
  const windows: Array<{
    options: { webPreferences: { additionalArguments: string[] } }
    bounds: { x: number; y: number; width: number; height: number } | null
    destroyed: boolean
    shownInactive: boolean
    bannerId: number
    content: Record<string, unknown>
    instance: unknown
  }> = []
  const icon = { dataUrl: '', path: '' as string | null }
  return { ipc, appListeners, windows, icon, workArea: { x: 0, y: 25, width: 1440, height: 875 } }
})

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (...args: unknown[]) => void) => { fake.ipc.set(channel, listener) },
    removeListener: (channel: string) => { fake.ipc.delete(channel) }
  },
  app: {
    on: (event: string, listener: (...args: unknown[]) => void) => { fake.appListeners.set(event, listener) },
    removeListener: (event: string) => { fake.appListeners.delete(event) }
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: fake.workArea }),
    getDisplayMatching: () => ({ workArea: fake.workArea })
  },
  nativeImage: {
    createThumbnailFromPath: async (path: string) => {
      fake.icon.path = path
      return { isEmpty: () => !fake.icon.dataUrl, toDataURL: () => fake.icon.dataUrl }
    }
  },
  BrowserWindow: class {
    private readonly record: (typeof fake.windows)[number]
    constructor(options: (typeof fake.windows)[number]['options']) {
      const arg = options.webPreferences.additionalArguments[0].slice('--banner='.length)
      const content = JSON.parse(decodeURIComponent(arg)) as Record<string, unknown>
      this.record = { options, bounds: null, destroyed: false, shownInactive: false, bannerId: content.id as number, content, instance: this }
      fake.windows.push(this.record)
    }
    setMenu() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    once(event: string, listener: () => void) { if (event === 'ready-to-show') listener() }
    showInactive() { this.record.shownInactive = true }
    loadURL() { return Promise.resolve() }
    isDestroyed() { return this.record.destroyed }
    destroy() { this.record.destroyed = true }
    setBounds(bounds: (typeof fake.windows)[number]['bounds']) { this.record.bounds = bounds }
    getBounds() { return this.record.bounds }
  }
}))

import {
  bannerAutoDismissMs,
  bannerDedupeKey,
  bannerStackBounds,
  NotificationPopups,
  notificationBannerContent,
  reconcileBanners
} from './notification-popup'

describe('banner stack layout', () => {
  const size = { width: 360, height: 96 }
  const display = { x: 0, y: 25, width: 1440, height: 875 }

  it('pins every banner to the top-right corner and stacks 1..4 downward with a gap, inside the display', () => {
    for (let count = 1; count <= 4; count++) {
      const rects = Array.from({ length: count }, (_, index) => bannerStackBounds(display, size, index))
      expect(rects.map(rect => rect.x)).toEqual(Array(count).fill(1440 - 16 - 360))
      expect(rects.map(rect => rect.y)).toEqual(Array.from({ length: count }, (_, index) => 25 + 16 + index * 106))
      for (const rect of rects) {
        expect(rect).toMatchObject(size)
        expect(rect.x + rect.width).toBeLessThanOrEqual(display.x + display.width)
        expect(rect.y + rect.height).toBeLessThanOrEqual(display.y + display.height)
      }
    }
  })

  it('follows the display origin, e.g. a secondary monitor to the right or above', () => {
    expect(bannerStackBounds({ x: 1440, y: -900, width: 1920, height: 1080 }, size, 1, { gap: 8, margin: 12 }))
      .toEqual({ x: 1440 + 1920 - 12 - 360, y: -900 + 12 + 104, width: 360, height: 96 })
  })
})

describe('payload to banner content', () => {
  const base = { profileId: 'a', serverIdentity: 'server-a', sessionId: 'chat' }

  it('shows a turn end as the session title with the finished status', () => {
    const content = notificationBannerContent({ ...base, title: 'Open chat', body: 'Response finished' })
    expect(content).toEqual({ title: 'Open chat', status: 'Response finished', emergency: false })
    expect(bannerAutoDismissMs(content)).toBe(8_000)
  })

  it('keeps the EMERGENCY title and alert message and marks it for the longer timeout', () => {
    const content = notificationBannerContent({
      ...base, title: 'EMERGENCY · TargetApp incident', body: 'Remote production writes may be lost.',
      emergencyAlertId: `emergency_${'e'.repeat(32)}`
    })
    expect(content).toEqual({ title: 'EMERGENCY · TargetApp incident', status: 'Remote production writes may be lost.', emergency: true })
    expect(bannerAutoDismissMs(content)).toBeGreaterThan(8_000)
  })
})

describe('banner dedupe by session', () => {
  it('keys by profile, server identity, and session', () => {
    const route = { profileId: 'a', serverIdentity: 'server-a', sessionId: 'chat' }
    expect(bannerDedupeKey(route)).toBe(bannerDedupeKey({ ...route }))
    expect(bannerDedupeKey(route)).not.toBe(bannerDedupeKey({ ...route, profileId: 'b' }))
    expect(bannerDedupeKey(route)).not.toBe(bannerDedupeKey({ ...route, sessionId: 'other' }))
    expect(bannerDedupeKey({ ...route, serverIdentity: null })).not.toBe(bannerDedupeKey(route))
  })

  it('replaces the same session, appends new sessions, and drops the oldest past the cap', () => {
    expect(reconcileBanners([], 'a', 4)).toEqual({ replaceKey: null, evictKey: null, keys: ['a'] })
    expect(reconcileBanners(['a', 'b'], 'a', 4)).toEqual({ replaceKey: 'a', evictKey: null, keys: ['a', 'b'] })
    expect(reconcileBanners(['a', 'b', 'c'], 'd', 4)).toEqual({ replaceKey: null, evictKey: null, keys: ['a', 'b', 'c', 'd'] })
    expect(reconcileBanners(['a', 'b', 'c', 'd'], 'e', 4)).toEqual({ replaceKey: null, evictKey: 'a', keys: ['b', 'c', 'd', 'e'] })
    // A full stack that already holds the session replaces it instead of evicting another chat.
    expect(reconcileBanners(['a', 'b', 'c', 'd'], 'c', 4)).toEqual({ replaceKey: 'c', evictKey: null, keys: ['a', 'b', 'c', 'd'] })
  })
})

describe('NotificationPopups window orchestration', () => {
  beforeEach(() => {
    fake.ipc.clear()
    fake.appListeners.clear()
    fake.windows.length = 0
    fake.icon.dataUrl = ''
    fake.icon.path = null
    vi.useRealTimers()
  })

  const live = () => fake.windows.filter(window => !window.destroyed)
  const request = (sessionId: string, onOpen = vi.fn(), emergency = false) => ({
    key: bannerDedupeKey({ profileId: 'a', serverIdentity: 'server-a', sessionId }),
    content: { title: `Chat ${sessionId}`, status: 'Response finished', emergency },
    onOpen
  })

  it('shows a non-activating, sandboxed, always-on-top banner with localized buttons', () => {
    const popups = new NotificationPopups({ preloadPath: '/preload.cjs' })
    popups.show(request('one'))
    expect(live()).toHaveLength(1)
    const [banner] = live()
    expect(banner.shownInactive).toBe(true)
    expect(banner.options).toMatchObject({
      frame: false, transparent: true, focusable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: true, show: false,
      webPreferences: { preload: '/preload.cjs', sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false }
    })
    expect(banner.content).toMatchObject({ title: 'Chat one', status: 'Response finished', emergency: false, open: 'Open', dismiss: 'Dismiss' })
    expect(banner.bounds).toEqual({ x: 1440 - 16 - 360, y: 25 + 16, width: 360, height: 96 })
  })

  it('shows the app icon, loaded from the .icns through the thumbnail API', async () => {
    // nativeImage.createFromPath returns an empty image for .icns, which left the icon slot blank.
    fake.icon.dataUrl = 'data:image/png;base64,ICON'
    const popups = new NotificationPopups({ preloadPath: '/preload.cjs', iconPath: '/Resources/icon.icns' })
    await Promise.resolve(); await Promise.resolve()
    popups.show(request('one'))
    expect(fake.icon.path).toBe('/Resources/icon.icns')
    expect(live()[0].content).toMatchObject({ icon: 'data:image/png;base64,ICON' })
  })

  it('replaces a session banner, caps the stack at four, and restacks after a dismiss', () => {
    const popups = new NotificationPopups({ preloadPath: '/preload.cjs' })
    for (const id of ['1', '2', '3', '4']) popups.show(request(id))
    popups.show(request('2'))
    expect(live().map(window => window.content.title)).toEqual(['Chat 1', 'Chat 3', 'Chat 4', 'Chat 2'])
    popups.show(request('5'))
    expect(live().map(window => window.content.title)).toEqual(['Chat 3', 'Chat 4', 'Chat 2', 'Chat 5'])

    const chat3 = live()[0]
    fake.ipc.get('notification-popup:action')!({}, { id: chat3.bannerId, action: 'dismiss' })
    expect(live().map(window => window.content.title)).toEqual(['Chat 4', 'Chat 2', 'Chat 5'])
    expect(live().map(window => window.bounds!.y)).toEqual([41, 41 + 106, 41 + 212])
  })

  it('runs the caller Open callback and clears every banner', () => {
    const popups = new NotificationPopups({ preloadPath: '/preload.cjs' })
    const onOpen = vi.fn()
    popups.show(request('one', onOpen))
    popups.show(request('two'))
    fake.ipc.get('notification-popup:action')!({}, { id: live()[0].bannerId, action: 'open' })
    expect(onOpen).toHaveBeenCalledOnce()
    expect(live()).toHaveLength(0)
    // Stale or forged ids from a closed banner do nothing.
    fake.ipc.get('notification-popup:action')!({}, { id: 999, action: 'open' })
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('dismisses all when a main window gains focus, but not for its own banner windows', () => {
    const popups = new NotificationPopups({ preloadPath: '/preload.cjs' })
    popups.show(request('one'))
    const focus = fake.appListeners.get('browser-window-focus')!
    focus({}, live()[0].instance)
    expect(live()).toHaveLength(1)
    focus({}, {})
    expect(live()).toHaveLength(0)
  })

  it('auto-dismisses after the timeout and pauses while hovered', () => {
    vi.useFakeTimers()
    const popups = new NotificationPopups({ preloadPath: '/preload.cjs' })
    popups.show(request('one'))
    const id = live()[0].bannerId
    const hover = fake.ipc.get('notification-popup:hover')!
    hover({}, { id, active: true })
    vi.advanceTimersByTime(60_000)
    expect(live()).toHaveLength(1)
    hover({}, { id, active: false })
    vi.advanceTimersByTime(7_999)
    expect(live()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(live()).toHaveLength(0)
  })

  it('detaches its listeners on dispose and ignores later shows', () => {
    const popups = new NotificationPopups({ preloadPath: '/preload.cjs' })
    popups.show(request('one'))
    popups.dispose()
    expect(live()).toHaveLength(0)
    expect(fake.ipc.size).toBe(0)
    expect(fake.appListeners.size).toBe(0)
    popups.show(request('two'))
    expect(live()).toHaveLength(0)
  })
})
