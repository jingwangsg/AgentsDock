import type { AgentServerClient } from '../api/AgentServerClient'
import type { UsageBackend } from './provider-usage'

export interface ProviderUsageChangedNotification {
  connection: AgentServerClient
  profileId: string
  profileGeneration: number
  sessionId: string
  backend: UsageBackend
}

type ProviderUsageListener = (notification: ProviderUsageChangedNotification) => void

const listeners = new Set<ProviderUsageListener>()

/**
 * Ephemeral `provider_usage_changed` packets bypass the durable timeline. This
 * small in-process channel lets the selected chat's usage view refetch when a
 * turn updates the provider account snapshot, mirroring provider-runtime-events.
 */
export function publishProviderUsageChanged(notification: ProviderUsageChangedNotification): void {
  for (const listener of [...listeners]) listener(notification)
}

export function subscribeProviderUsageChanged(listener: ProviderUsageListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
