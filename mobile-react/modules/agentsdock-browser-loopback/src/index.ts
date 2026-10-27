import { requireOptionalNativeModule } from 'expo-modules-core'

interface BrowserRoutingNativeModule {
  routeAsync(profile: string, tunnelPrefix: string, token: string, directHosts: string[], allHosts: boolean): Promise<boolean>
  releaseAsync(profile: string): Promise<void>
}

// The native module keeps its original name.
const nativeModule = requireOptionalNativeModule<BrowserRoutingNativeModule>('AgentsDockBrowserLoopback')

/**
 * Sends web view requests through this browser tab's port tunnel (`<tunnelPrefix><port>/tunnel/ws`), so
 * pages load through the selected server's network. With `allHosts` every host is sent, named to the
 * server with `?host=`; without it (a server that cannot dial a named host) only the server's localhost
 * is, and other pages load from the phone. `directHosts` are reached from the phone itself. `profile` is
 * the tab's web view profile: it identifies the routing, and on iOS names the data store whose proxy is
 * set. Android's module still calls this argument tabId and uses it only as the key a release must match.
 * Resolves false when the platform's web view cannot be redirected (iOS before 17), in which case every
 * page loads from the phone.
 */
export async function routeBrowserThroughServer(profile: string, tunnelPrefix: string, token: string, directHosts: string[], allHosts: boolean): Promise<boolean> {
  return nativeModule ? nativeModule.routeAsync(profile, tunnelPrefix, token, directHosts, allHosts) : false
}

/** Ends the routing a tab started; a later tab's routing is left alone. */
export async function releaseBrowserRouting(profile: string): Promise<void> {
  await nativeModule?.releaseAsync(profile)
}
