import { requireOptionalNativeModule } from 'expo-modules-core'

interface BrowserLoopbackNativeModule {
  routeAsync(tabId: string, tunnelPrefix: string, token: string): Promise<boolean>
  releaseAsync(tabId: string): Promise<void>
}

const nativeModule = requireOptionalNativeModule<BrowserLoopbackNativeModule>('AgentsDockBrowserLoopback')

/**
 * Sends web view requests for localhost and loopback addresses through this browser tab's
 * port tunnel (`<tunnelPrefix><port>/tunnel/ws`). Resolves false when the platform's web
 * view cannot be redirected, in which case localhost stays the phone itself.
 */
export async function routeBrowserLoopback(tabId: string, tunnelPrefix: string, token: string): Promise<boolean> {
  return nativeModule ? nativeModule.routeAsync(tabId, tunnelPrefix, token) : false
}

/** Ends the routing a tab started; a later tab's routing is left alone. */
export async function releaseBrowserLoopback(tabId: string): Promise<void> {
  await nativeModule?.releaseAsync(tabId)
}
