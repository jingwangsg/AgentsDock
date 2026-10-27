// A browser tab's native pieces: the web view is a host element, and routing resolves as the test sets it.
export default 'WebView'
export let routeResult = true
export function setRouteResult(routed: boolean) { routeResult = routed }
export async function routeBrowserThroughServer(..._args: unknown[]): Promise<boolean> { return routeResult }
export async function releaseBrowserRouting(_profile: string): Promise<void> {}
