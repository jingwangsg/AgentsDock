import { contextBridge, ipcRenderer } from 'electron'

/**
 * Tiny preload for the completion banner. The sandboxed page has no other
 * channel to the main process, so the manager hands the banner id and content
 * through additionalArguments and the page talks back over these two channels.
 */
function readBannerArg(): { id?: number } & Record<string, unknown> {
  const prefix = '--banner='
  const raw = process.argv.find(arg => arg.startsWith(prefix))
  if (!raw) return {}
  try {
    return JSON.parse(decodeURIComponent(raw.slice(prefix.length)))
  } catch {
    return {}
  }
}

const data = readBannerArg()
const id = typeof data.id === 'number' ? data.id : null

contextBridge.exposeInMainWorld('banner', {
  data,
  open: () => ipcRenderer.send('notification-popup:action', { id, action: 'open' }),
  dismiss: () => ipcRenderer.send('notification-popup:action', { id, action: 'dismiss' }),
  hover: (active: boolean) => ipcRenderer.send('notification-popup:hover', { id, active })
})
