import { app, BrowserWindow, ipcMain, nativeImage, screen } from 'electron'
import { t } from '../shared/i18n'
import type { ProfileNotificationPayload, ProfileNotificationRoute } from '../shared/types'

/**
 * Zed-style completion banner. macOS Notification Center drops the ad-hoc
 * build's requests, so instead of relying on a signing identity the app draws
 * its own frameless, non-activating overlay at the top-right of the display
 * holding the main window. The BrowserWindow orchestration stays thin; the
 * stack layout, payload mapping, and dedupe decision are the pure functions
 * below so they can be unit-tested without a real display.
 */

export interface BannerContent {
  title: string
  status: string
  emergency: boolean
}

export interface Rect { x: number; y: number; width: number; height: number }
export interface BannerSize { width: number; height: number }

export interface NotificationPopupRequest {
  key: string
  content: BannerContent
  /** Focuses the chat behind the banner; supplied by the caller so the popup never reimplements routing. */
  onOpen(): void
}

export interface NotificationPopupController {
  show(request: NotificationPopupRequest): void
  dismissAll(): void
  dispose(): void
}

const BANNER_WIDTH = 360
const BANNER_HEIGHT = 96
const BANNER_GAP = 10
const BANNER_MARGIN = 16
const MAX_BANNERS = 4
const DEFAULT_TIMEOUT_MS = 8_000
const EMERGENCY_TIMEOUT_MS = 20_000
const BANNER_SIZE: BannerSize = { width: BANNER_WIDTH, height: BANNER_HEIGHT }

/** Turn-end/waiting carry their status in `body`; emergencies also set `emergencyAlertId`. */
export function notificationBannerContent(payload: ProfileNotificationPayload): BannerContent {
  return { title: payload.title, status: payload.body, emergency: Boolean(payload.emergencyAlertId) }
}

/** Session-scoped key: the same chat replaces its banner instead of stacking a new one. */
export function bannerDedupeKey(route: ProfileNotificationRoute): string {
  return `${route.profileId}\0${route.serverIdentity ?? ''}\0${route.sessionId}`
}

/** Top-right stack: banner `index` sits `index` rows down from the display's top-right corner. */
export function bannerStackBounds(
  display: Rect,
  size: BannerSize,
  index: number,
  options?: { gap?: number; margin?: number }
): Rect {
  const gap = options?.gap ?? BANNER_GAP
  const margin = options?.margin ?? BANNER_MARGIN
  return {
    x: Math.round(display.x + display.width - margin - size.width),
    y: Math.round(display.y + margin + index * (size.height + gap)),
    width: size.width,
    height: size.height
  }
}

export interface BannerReconcile {
  /** Existing key whose banner is superseded by this session's newer notification. */
  replaceKey: string | null
  /** Oldest key dropped because the cap is reached (only when the incoming key is new). */
  evictKey: string | null
  keys: string[]
}

/** Dedupe by session and cap the count; older banners drop once the cap is exceeded. */
export function reconcileBanners(current: string[], incoming: string, cap: number): BannerReconcile {
  if (current.includes(incoming)) return { replaceKey: incoming, evictKey: null, keys: [...current] }
  const evictKey = current.length >= cap ? current[0] : null
  const kept = evictKey ? current.slice(1) : current
  return { replaceKey: null, evictKey, keys: [...kept, incoming] }
}

export function bannerAutoDismissMs(content: BannerContent): number {
  return content.emergency ? EMERGENCY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
}

export interface NotificationPopupOptions {
  /** Chooses the display to place banners on; falls back to the primary display. */
  displayWindow?: () => BrowserWindow | null
  /** App icon shown on each banner; missing/unreadable is rendered without an icon. */
  iconPath?: string | null
  /** Compiled sandboxed preload for the banner page. */
  preloadPath: string
}

interface BannerSlot {
  id: number
  window: BrowserWindow
  onOpen: () => void
  timeoutMs: number
  timer: NodeJS.Timeout | null
}

// The page is generic: it renders whatever the preload exposes as window.banner.
const BANNER_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-user-select:none;cursor:default}
  #card{box-sizing:border-box;height:100%;display:flex;gap:10px;padding:12px 14px;border-radius:12px;background:rgba(30,30,32,0.96);border:1px solid rgba(255,255,255,0.08);box-shadow:0 8px 24px rgba(0,0,0,0.35);color:#f5f5f5}
  #card.emergency{border-color:rgba(255,90,90,0.55)}
  #icon{width:36px;height:36px;border-radius:8px;flex:0 0 auto;background-size:cover}
  #body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
  #title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #status{font-size:12px;color:#b8b8bd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .emergency #status{color:#ff8b8b}
  #actions{display:flex;gap:8px;margin-top:auto}
  button{font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.06);color:#f5f5f5;cursor:pointer}
  #open{background:#3b6fe0;border-color:#3b6fe0}
</style></head><body>
<div id="card"><div id="icon"></div><div id="body">
  <div id="title"></div><div id="status"></div>
  <div id="actions"><button id="open"></button><button id="dismiss"></button></div>
</div></div>
<script>
  var b=(window.banner&&window.banner.data)||{};
  var card=document.getElementById('card');
  if(b.emergency)card.classList.add('emergency');
  if(b.icon)document.getElementById('icon').style.backgroundImage='url("'+b.icon+'")';
  document.getElementById('title').textContent=b.title||'';
  document.getElementById('status').textContent=b.status||'';
  var open=document.getElementById('open');open.textContent=b.open||'Open';
  var dismiss=document.getElementById('dismiss');dismiss.textContent=b.dismiss||'Dismiss';
  open.addEventListener('click',function(){window.banner.open()});
  dismiss.addEventListener('click',function(){window.banner.dismiss()});
  card.addEventListener('mouseenter',function(){window.banner.hover(true)});
  card.addEventListener('mouseleave',function(){window.banner.hover(false)});
</script></body></html>`)}`

export class NotificationPopups implements NotificationPopupController {
  private readonly slots = new Map<string, BannerSlot>()
  private readonly bannerIdToKey = new Map<number, string>()
  // Filled once the async icon load settles; banners shown before then render without an icon.
  private iconDataUrl = ''
  private counter = 0
  private disposed = false

  constructor(private readonly options: NotificationPopupOptions) {
    void resolveIconDataUrl(options.iconPath ?? null).then(url => { this.iconDataUrl = url })
    ipcMain.on('notification-popup:action', this.onAction)
    ipcMain.on('notification-popup:hover', this.onHover)
    app.on('browser-window-focus', this.onWindowFocus)
  }

  show(request: NotificationPopupRequest): void {
    if (this.disposed) return
    const { replaceKey, evictKey } = reconcileBanners([...this.slots.keys()], request.key, MAX_BANNERS)
    if (evictKey) this.close(evictKey)
    if (replaceKey) this.close(replaceKey)
    const id = ++this.counter
    const window = this.createWindow(id, request.content)
    const slot: BannerSlot = { id, window, onOpen: request.onOpen, timeoutMs: bannerAutoDismissMs(request.content), timer: null }
    this.slots.set(request.key, slot)
    this.bannerIdToKey.set(id, request.key)
    this.arm(slot)
    this.layout()
  }

  dismissAll(): void {
    for (const key of [...this.slots.keys()]) this.close(key)
  }

  dispose(): void {
    this.disposed = true
    this.dismissAll()
    ipcMain.removeListener('notification-popup:action', this.onAction)
    ipcMain.removeListener('notification-popup:hover', this.onHover)
    app.removeListener('browser-window-focus', this.onWindowFocus)
  }

  private createWindow(id: number, content: BannerContent): BrowserWindow {
    const arg = {
      id,
      title: content.title,
      status: content.status,
      emergency: content.emergency,
      icon: this.iconDataUrl,
      open: t('notifications.open'),
      dismiss: t('notifications.dismiss')
    }
    const window = new BrowserWindow({
      width: BANNER_WIDTH,
      height: BANNER_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      acceptFirstMouse: true,
      roundedCorners: true,
      title: '',
      type: 'panel',
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        additionalArguments: [`--banner=${encodeURIComponent(JSON.stringify(arg))}`]
      }
    })
    window.setMenu?.(null)
    // Float above other apps' full-screen spaces without pulling the app forward.
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.showInactive() })
    void window.loadURL(BANNER_HTML)
    return window
  }

  private arm(slot: BannerSlot): void {
    if (slot.timer) clearTimeout(slot.timer)
    slot.timer = setTimeout(() => {
      const key = this.bannerIdToKey.get(slot.id)
      if (key) this.close(key)
    }, slot.timeoutMs)
  }

  private close(key: string): void {
    const slot = this.slots.get(key)
    if (!slot) return
    this.slots.delete(key)
    this.bannerIdToKey.delete(slot.id)
    if (slot.timer) clearTimeout(slot.timer)
    if (!slot.window.isDestroyed()) slot.window.destroy()
    this.layout()
  }

  private layout(): void {
    const display = this.targetDisplay()
    let index = 0
    for (const slot of this.slots.values()) {
      if (slot.window.isDestroyed()) continue
      slot.window.setBounds(bannerStackBounds(display, BANNER_SIZE, index++))
    }
  }

  private targetDisplay(): Rect {
    const window = this.options.displayWindow?.() ?? null
    const source = window && !window.isDestroyed()
      ? screen.getDisplayMatching(window.getBounds())
      : screen.getPrimaryDisplay()
    return source.workArea
  }

  private slotByBannerId(id: unknown): { key: string; slot: BannerSlot } | null {
    if (typeof id !== 'number') return null
    const key = this.bannerIdToKey.get(id)
    const slot = key ? this.slots.get(key) : undefined
    return key && slot ? { key, slot } : null
  }

  private readonly onAction = (_event: unknown, message: { id?: unknown; action?: unknown }): void => {
    const found = this.slotByBannerId(message?.id)
    if (!found) return
    if (message.action === 'open') {
      found.slot.onOpen()
      this.dismissAll()
    } else if (message.action === 'dismiss') {
      this.close(found.key)
    }
  }

  private readonly onHover = (_event: unknown, message: { id?: unknown; active?: unknown }): void => {
    const found = this.slotByBannerId(message?.id)
    if (!found) return
    // Pause the countdown while pointed at; resume with a full window on leave.
    if (message.active) {
      if (found.slot.timer) { clearTimeout(found.slot.timer); found.slot.timer = null }
    } else {
      this.arm(found.slot)
    }
  }

  private readonly onWindowFocus = (_event: unknown, window: BrowserWindow): void => {
    // A real main window regaining focus clears every banner, like Zed. The
    // banners themselves are non-focusable, so they never trigger this.
    for (const slot of this.slots.values()) if (slot.window === window) return
    this.dismissAll()
  }
}

async function resolveIconDataUrl(iconPath: string | null): Promise<string> {
  if (!iconPath) return ''
  try {
    // createFromPath returns an empty image for .icns; the thumbnail API reads it through the system.
    const image = await nativeImage.createThumbnailFromPath(iconPath, { width: 72, height: 72 })
    return image.isEmpty() ? '' : image.toDataURL()
  } catch {
    return ''
  }
}
