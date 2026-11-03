import { create } from 'zustand'
import type { AgentServerClient } from '../../src/api/AgentServerClient'
import type { useAppStore as ProductionStore } from '../../src/store/useAppStore'

type AppState = ReturnType<typeof ProductionStore.getState>

function initialState(): AppState {
  return {
    activeProfileId: 'profile-a',
    profileGeneration: 1,
    connected: true,
    connecting: false,
    workspaceAdopting: false,
    health: null,
    sessions: [],
    snapshots: {},
    activeSessionIds: new Set<string>(),
    fontScale: 1,
  } as AppState
}

export const useAppStore = create<AppState>(() => initialState())
export let client = { isValidated: true } as AgentServerClient

export function resetComponentStore(state: Partial<AppState> = {}): void {
  useAppStore.setState({ ...initialState(), ...state }, true)
}

/** The production attachment source and cache key, over this mock's client. */
export function attachmentCacheKey(sessionId: string, fileId: string): string {
  return `test-server/${sessionId}/${fileId}`
}

export function attachmentImageSource(connection: AgentServerClient, sessionId: string, fileId: string) {
  return { uri: connection.fileURL(sessionId, fileId), headers: connection.authHeaders(), cacheKey: attachmentCacheKey(sessionId, fileId) }
}

/** The production fence evaluated against this mock's state and client. */
export function capturedConnectionIsCurrent(connection: AgentServerClient, profileId: string | null, generation: number): boolean {
  const state = useAppStore.getState()
  return client === connection
    && connection.isValidated
    && state.activeProfileId === profileId
    && state.profileGeneration === generation
    && state.connected
    && !state.connecting
    && !state.switchingProfileId
}

/** Replace the selected connection, preserving production identity semantics. */
export function setTestClient(next: Partial<AgentServerClient> = {}): AgentServerClient {
  client = { isValidated: true, ...next } as AgentServerClient
  return client
}
