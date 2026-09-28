import { normalizeServerURL } from './format'

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:7850'
export const AGENTS_SERVER_REPOSITORY_URL = 'https://github.com/ZhengyiLuo/AgentsServer'

export function inferServerConfigured(serverURL: unknown, explicit: unknown): boolean {
  if (typeof explicit === 'boolean') return explicit
  if (typeof serverURL !== 'string' || !serverURL.trim()) return false
  const normalized = normalizeServerURL(serverURL).toLowerCase()
  return normalized !== DEFAULT_SERVER_URL && normalized !== 'http://localhost:7850'
}

/** Hub token baked into a personal build via EXPO_PUBLIC_AGENTSDOCK_HUB_TOKEN; empty in upstream builds. */
export const BUILT_IN_HUB_TOKEN = process.env.EXPO_PUBLIC_AGENTSDOCK_HUB_TOKEN ?? ''

/**
 * True when anything answers HTTP at `<serverURL>/api/health`, 401 included: a
 * phone usually reaches the Mac hub through a local forward (Tailscale, ssh -L),
 * so the 127.0.0.1:7850 placeholder is a real candidate on launch.
 */
export async function localHubAlive(serverURL: string, fetchImpl: typeof fetch = fetch, timeoutMs = 2_500): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    await fetchImpl(`${normalizeServerURL(serverURL)}/api/health`, { signal: controller.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
