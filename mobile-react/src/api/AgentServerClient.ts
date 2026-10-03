import { File } from 'expo-file-system'

import type {
  AgentFile,
  AgentCrossChatRoutesSnapshot,
  CodexKillWritersResult,
  DeleteAgentCrossChatRouteResponse,
  QueuedCrossChatDeliveryIdentity,
  CodexBackgroundTerminalTerminateInput,
  CodexBackgroundTerminalsCleanInput,
  CodexBackgroundTerminalsSnapshot,
  CodexGoalInput,
  CodexGoalSnapshot,
  CodexGoalsConfiguration,
  CodexOperationAccepted,
  CodexPendingInteraction,
  CodexReviewInput,
  CodexRollbackInput,
  CodexRollbackResult,
  CodexRuntimeSnapshot,
  CodexShellInput,
  ClaudePendingInteraction,
  ClaudeMcpControlInput,
  ClaudeMcpSnapshot,
  ClaudeRuntimeSnapshot,
  ChatReference,
  CanvasCommentAnchor,
  CanvasCommentInput,
  CanvasCommentThread,
  CanvasRecord,
  CanvasSummary,
  TeamReference,
  CreateJobInput,
  CreateSessionInput,
  Event,
  CrossChatExchange,
  CrossChatHandoff,
  CrossChatHandoffSummary,
  FilesPage,
  Health,
  Job,
  JobRunResponse,
  JobRunHistoryPage,
  JsonValue,
  ProcessSnapshot,
  ProviderReloadResult,
  ProviderCommandSelection,
  ProviderCommandsSnapshot,
  ProviderRuntimeChanged,
  QueuedRunNowResponse,
  QueuedTurn,
  RemoteServer,
  RemoteServerDeployJob,
  RuntimeCatalog,
  RuntimeDiagnostic,
  ServerUpdateStatus,
  Session,
  SessionHistoryReloadResult,
  SessionRewindResult,
  TerminalAction,
  TerminalWindowsSnapshot,
  TimelineIndex,
  SubagentSnapshot,
  TimelinePage,
  TimelineTracePage,
  TimelineSearchResult,
  TmuxPane,
  TurnStopResult,
  UpdateJobInput,
  UploadRef,
  WorkspaceEntriesPage,
  WorkspaceCreateResult,
  WorkspaceGitAction,
  WorkspaceGitConflict,
  WorkspaceGitDiff,
  WorkspaceGitStatus,
  WorkspaceGitView,
  WorkingDirectoryCompletion,
  WorkspaceFile,
  WorkspaceInfo,
  WorkspaceRemoveResult,
  WorkspaceRenameResult,
  WorkspaceSearchPage,
  CreateSurfaceInput,
  Surface,
  UpdateSurfaceInput,
} from '../types'
import { base64 } from '../lib/base64'
import { normalizeServerURL } from '../lib/format'
import { parseProviderUsage, type ProviderUsageSnapshot, type UsageBackend } from '../lib/provider-usage'
import { parseSyncedSideChat, type SyncedSideChat } from '../lib/side-chat'
import type { BackgroundActivityItem } from '../lib/background-activity'
import { teamNetworkRequestPath } from '../lib/team-network'
import { retriesStaleGitAction } from '../lib/workspace-changes'
import type { ConversationExportFormat } from '../lib/file-transfer'
import { Utf8FilenameFormData } from '../lib/upload-filename'

interface SessionResponse {
  session: Session
  events: Event[]
  queued_turns?: QueuedTurn[]
  events_omitted_before?: number
  events_omitted_after?: number
  next_before?: number | null
  semantic_item_count?: number | null
  semantic_total?: number | null
  semantic_omitted_before?: number | null
  semantic_omitted_after?: number | null
  next_semantic_before?: number | null
  latest_seq?: number
  event_count?: number
}

const TIMELINE_REQUEST_TIMEOUT_MS = 12_000
// A rewind forks the provider thread; over a remote hub tunnel that outlasts an
// ordinary request, and the server finishes it even after the client gives up.
const REWIND_REQUEST_TIMEOUT_MS = 120_000
const STREAM_CONNECT_TIMEOUT_MS = 10_000
const STREAM_RETRY_INITIAL_MS = 500
const STREAM_RETRY_MAX_MS = 30_000
const STREAM_STABLE_CONNECTION_MS = 10_000
// A size-based upload deadline assumed 1 MiB/s; measured through a slow relay, 27 KiB/s, so
// an 84 MB file needed about an hour and was cut off at five minutes. Like the desktop, an
// upload is given up only when it stalls: no byte taken for UPLOAD_STALL_TIMEOUT_MS, no
// answer UPLOAD_RESPONSE_TIMEOUT_MS after the last byte, or UPLOAD_TIMEOUT_CAP_MS in all.
const UPLOAD_STALL_TIMEOUT_MS = 2 * 60_000
const UPLOAD_RESPONSE_TIMEOUT_MS = 5 * 60_000
const UPLOAD_TIMEOUT_CAP_MS = 8 * 60 * 60_000
const FATAL_WEBSOCKET_CLOSE_CODES = new Set([4401, 4404, 4409])
const EVENTS_STREAM_PROTOCOL = 'agentsdock-events-v1'

export interface ServerErrorDetail {
  code?: string
  message?: string
  action?: string
  retryable?: boolean
  delivery_uncertain?: boolean
  queued_id?: string
  [key: string]: unknown
}

export interface CodeDiffResponse {
  text: string
  truncated: boolean
}

export const CODE_DIFF_MAX_BYTES = 512 * 1024

export class ServerError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) { super(message) }
}

export class AgentServerClientDisposedError extends Error {
  constructor() {
    super('Agent server client has been disposed')
    this.name = 'AgentServerClientDisposedError'
  }
}

export class AgentServerClientUnvalidatedError extends Error {
  constructor() {
    super('Agent server client has not passed server identity validation')
    this.name = 'AgentServerClientUnvalidatedError'
  }
}

export class WebSocketConnectionError extends Error {
  constructor(
    public code: number,
    public reason: string,
    public fatal: boolean,
    transport: 'timeline' | 'terminal',
  ) {
    super(reason || `${transport === 'timeline' ? 'Timeline' : 'Terminal'} connection closed (${code})`)
    this.name = 'WebSocketConnectionError'
  }
}

export interface WebSocketStateDetail {
  code: number
  reason: string
  fatal: boolean
  retrying: boolean
  error: WebSocketConnectionError
}

export interface TimelineStreamHandlers {
  onEvent: (event: Event) => void
  onState: (connected: boolean, detail?: WebSocketStateDetail) => void
  onProviderRuntime?: (event: ProviderRuntimeChanged) => void
  onProviderUsage?: (backend: UsageBackend) => void
  onSideChatChanged?: (revision: number) => void
}

interface ClientConfiguration {
  readonly baseURL: string
  readonly token: string
  /** Learned from /api/health; a reconfigured client starts over at false. */
  websocketSubprotocolAuth: boolean
}

interface ClientScope {
  readonly configuration: ClientConfiguration
  readonly signal: AbortSignal
}

export interface AgentServerClientOptions {
  /** Restrict this instance to health checks until markValidated() is called. */
  requireValidation?: boolean
  /** Called synchronously after the active scope rejects authenticated access. */
  onAuthorizationFailure?: (error: ServerError | WebSocketConnectionError) => void
  /** Called synchronously for an HTTP rejection from the active request scope. */
  onServerError?: (error: ServerError) => void
  /** Test seams; production aborts an upload after these windows (UPLOAD_STALL_TIMEOUT_MS, UPLOAD_RESPONSE_TIMEOUT_MS, UPLOAD_TIMEOUT_CAP_MS). */
  uploadStallTimeoutMs?: number
  uploadResponseTimeoutMs?: number
  uploadTimeoutMs?: number
}

export class AgentServerClient {
  private configuration: ClientConfiguration
  private scopeController = new AbortController()
  private readonly transportStops = new Set<() => void>()
  private readonly validationRequired: boolean
  private readonly onAuthorizationFailure?: (error: ServerError | WebSocketConnectionError) => void
  private readonly onServerError?: (error: ServerError) => void
  private readonly uploadStallTimeoutMs: number
  private readonly uploadResponseTimeoutMs: number
  private readonly uploadTimeoutMs: number
  private validated: boolean
  private validationRevisionValue = 0
  private disposed = false

  constructor(baseURL: string, token = '', options: AgentServerClientOptions = {}) {
    this.configuration = createConfiguration(baseURL, token)
    this.validationRequired = options.requireValidation === true
    this.onAuthorizationFailure = options.onAuthorizationFailure
    this.onServerError = options.onServerError
    this.uploadStallTimeoutMs = options.uploadStallTimeoutMs ?? UPLOAD_STALL_TIMEOUT_MS
    this.uploadResponseTimeoutMs = options.uploadResponseTimeoutMs ?? UPLOAD_RESPONSE_TIMEOUT_MS
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_CAP_MS
    this.validated = !this.validationRequired
  }

  /** @deprecated Create and dispose client instances instead of reconfiguring one instance. */
  configure(baseURL: string, token: string): void {
    this.assertActive()
    const next = createConfiguration(baseURL, token)
    if (next.baseURL === this.configuration.baseURL && next.token === this.configuration.token) return
    this.stopCurrentScope()
    this.configuration = next
    this.scopeController = new AbortController()
    this.validated = !this.validationRequired
    this.validationRevisionValue += 1
  }

  get isDisposed(): boolean { return this.disposed }
  get isValidated(): boolean { return !this.disposed && this.validated }
  /** Monotonic epoch used to reject health results older than an invalidation. */
  get validationRevision(): number { return this.validationRevisionValue }

  markValidated(): void {
    this.assertActive()
    if (this.validated) return
    this.validated = true
  }

  /** Return a validation-required client to health-only mode and stop authenticated work. */
  revokeValidation(): void {
    this.assertActive()
    if (!this.validationRequired || !this.validated) return
    this.invalidateValidation()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.validationRevisionValue += 1
    this.stopCurrentScope()
  }

  url(path: string): string {
    this.assertValidated()
    return buildURL(this.configuration.baseURL, path)
  }
  fileURL(sessionId: string, fileId: string): string {
    return this.url(`/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`)
  }
  workspacePreviewURL(sessionId: string, path: string): string {
    return this.url(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/preview?path=${encodeURIComponent(path)}`)
  }
  workspaceDownloadURL(sessionId: string, path: string): string {
    return this.url(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/download?path=${encodeURIComponent(path)}`)
  }
  sessionExportURL(sessionId: string, format: ConversationExportFormat): string {
    return this.url(`/api/sessions/${encodeURIComponent(sessionId)}/export?format=${format}`)
  }
  authHeaders(): Record<string, string> {
    this.assertValidated()
    return authHeaders(this.configuration.token)
  }

  async health(): Promise<Health> {
    const configuration = this.configuration
    const health = await this.request<Health>('/api/health', {}, 30_000, true)
    // Same rule as the desktop client: the capability is advertised per server,
    // so only the configuration that made this request learns it.
    if (this.configuration === configuration) {
      configuration.websocketSubprotocolAuth = health.capabilities?.websocket_auth_v1?.available === true
    }
    return health
  }
  codexServerGoals(): Promise<CodexGoalsConfiguration> {
    return this.request('/api/admin/codex/goals', {}, 30_000, false, 'native-control')
  }
  setCodexServerGoals(enabled: boolean): Promise<CodexGoalsConfiguration> {
    return this.request('/api/admin/codex/goals', {
      method: 'PUT', body: JSON.stringify({ enabled }),
    }, 30_000, false, 'native-control')
  }
  /** Ends every other Codex process holding this chat's thread (see server kill_codex_writers). */
  killCodexWriters(sessionId: string): Promise<CodexKillWritersResult> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/codex/kill-writers`, { method: 'POST' }, 30_000, false, 'native-control')
  }
  setClaudeToken(token: string): Promise<{ oauth_token_configured: boolean }> {
    return this.request('/api/admin/claude/token', {
      method: 'PUT', body: JSON.stringify({ token }),
    }, 30_000, false, 'native-control')
  }
  /** The server stops the CLI after 10 minutes; a download can take several. */
  updateRuntimeCli(backend: 'claude' | 'codex'): Promise<{ output: string; diagnostic: RuntimeDiagnostic }> {
    return this.request(`/api/admin/runtimes/${backend}/update`, { method: 'POST' }, 11 * 60_000, false, 'native-control')
  }
  serverUpdateStatus(): Promise<ServerUpdateStatus> { return this.get('/api/admin/update') }
  // Hub for SSH-only remote servers (see server/remote_servers.py): the
  // active server can deploy and proxy other AgentsServer installs it
  // reaches by SSH. Never returns a remote's own token; the client keeps
  // using the hub's own token for the `/api/remote/{id}` profile it saves.
  remoteServers(): Promise<{ servers: RemoteServer[] }> {
    return this.request('/api/admin/remote-servers', {}, 30_000, false, 'native-control')
  }
  startRemoteDeploy(input: { ssh_host: string; install_dir?: string; name?: string }): Promise<{ job_id: string }> {
    return this.request('/api/admin/remote-servers/deploy', {
      method: 'POST', body: JSON.stringify(input),
    }, 30_000, false, 'native-control')
  }
  startRemoteAttach(input: { ssh_host: string; install_dir?: string; name?: string }): Promise<{ job_id: string }> {
    return this.request('/api/admin/remote-servers/attach', {
      method: 'POST', body: JSON.stringify(input),
    }, 30_000, false, 'native-control')
  }
  remoteDeployStatus(jobId: string): Promise<RemoteServerDeployJob> {
    return this.request(`/api/admin/remote-servers/deploy/${encodeURIComponent(jobId)}`, {}, 30_000, false, 'native-control')
  }
  cancelRemoteDeploy(jobId: string): Promise<{ cancelled: boolean }> {
    return this.request(`/api/admin/remote-servers/deploy/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }, 30_000, false, 'native-control')
  }
  removeRemoteServer(remoteId: string): Promise<void> {
    return this.request(`/api/admin/remote-servers/${encodeURIComponent(remoteId)}`, { method: 'DELETE' }, 30_000, false, 'native-control')
  }
  reorderRemoteServers(ids: string[]): Promise<void> {
    return this.request('/api/admin/remote-servers/order', { method: 'PUT', body: JSON.stringify({ ids }) }, 30_000, false, 'native-control')
  }
  startRemoteRedeploy(remoteId: string): Promise<{ job_id: string }> {
    return this.request(`/api/admin/remote-servers/${encodeURIComponent(remoteId)}/redeploy`, { method: 'POST' }, 30_000, false, 'native-control')
  }
  cancelServerUpdate(scheduleId: string): Promise<ServerUpdateStatus> {
    return this.post('/api/admin/update/cancel', { schedule_id: scheduleId })
  }
  runtimeCatalog(refresh = false): Promise<RuntimeCatalog> {
    return this.get(`/api/runtime/catalog${refresh ? '?refresh=true' : ''}`)
  }
  async runtimeUsage(backend: UsageBackend, sessionId: string, options: { refresh?: boolean } = {}): Promise<ProviderUsageSnapshot> {
    const query = new URLSearchParams({ backend, session_id: sessionId })
    if (options.refresh) query.set('refresh', 'true')
    return parseProviderUsage(await this.request(`/api/runtime/usage?${query}`, {}, 30_000, false, 'native-control'), backend)
  }
  private async sideChatRequest(sessionId: string, path: string, init: RequestInit = {}): Promise<SyncedSideChat> {
    const value = await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/side-chat${path}`, init, 30_000, false, 'native-control')
    return parseSyncedSideChat(value, sessionId)
  }
  readSideChat(sessionId: string): Promise<SyncedSideChat> {
    return this.sideChatRequest(sessionId, '')
  }
  submitSideChat(sessionId: string, input: { request_id: string; question: string; side_chat_id: string; after_request_id?: string }): Promise<SyncedSideChat> {
    return this.sideChatRequest(sessionId, '', { method: 'POST', body: JSON.stringify(input) })
  }
  stopSideChat(sessionId: string, requestId: string): Promise<SyncedSideChat> {
    return this.sideChatRequest(sessionId, `/requests/${encodeURIComponent(requestId)}`, { method: 'DELETE' })
  }
  clearSideChat(sessionId: string, sideChatId: string): Promise<SyncedSideChat> {
    return this.sideChatRequest(sessionId, `/${encodeURIComponent(sideChatId)}`, { method: 'DELETE' })
  }
  teamNetworkGet<T>(basePath: string, path: string): Promise<T> {
    return this.request(teamNetworkRequestPath(basePath, path), { redirect: 'error' }, 30_000, false, 'team-network')
  }
  teamNetworkPost<T>(basePath: string, path: string, body: unknown): Promise<T> {
    return this.request(
      teamNetworkRequestPath(basePath, path),
      { method: 'POST', body: JSON.stringify(body) },
      30_000,
      false,
      'team-network',
    )
  }
  async sessions(): Promise<Session[]> {
    const { sessions } = await this.get<{ sessions: Session[] }>('/api/sessions?summary=true')
    // load-bearing: the server keeps these two keys sparse in summary rows on
    // purpose (agent_server.public_session, pinned by test_emergency_alerts) and
    // sends the explicit null/0 tombstone only on the emergency stream. This
    // store merges list rows over the retained session by spreading, so a
    // summary consumer must restore the tombstone itself or an alert another
    // client already acknowledged would survive here.
    return sessions.map(session => 'emergency_alert' in session
      ? session
      : { ...session, emergency_alert: null, unacknowledged_emergency_count: 0 })
  }
  async jobs(): Promise<Job[]> { return (await this.get<{ jobs: Job[] }>('/api/jobs')).jobs }

  workspaceInfo(sessionId: string): Promise<WorkspaceInfo> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/workspace`)
  }
  workspaceEntries(sessionId: string, path = '', offset = 0, limit = 500): Promise<WorkspaceEntriesPage> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/entries?path=${encodeURIComponent(path)}&offset=${offset}&limit=${limit}`)
  }
  workspaceSearch(sessionId: string, query = '', limit = 100): Promise<WorkspaceSearchPage> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/search?q=${encodeURIComponent(query)}&limit=${limit}`)
  }
  completeWorkingDirectory(path: string, limit = 24): Promise<WorkingDirectoryCompletion> {
    const query = new URLSearchParams({ path, limit: String(limit) })
    return this.get(`/api/working-directories/complete?${query}`)
  }
  workspaceFile(sessionId: string, path: string): Promise<WorkspaceFile> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/file?path=${encodeURIComponent(path)}`)
  }
  workspaceWriteFile(sessionId: string, path: string, content: string, expectedRevision: string): Promise<WorkspaceFile> {
    return this.put(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/file`, {
      path,
      content,
      expected_revision: expectedRevision,
    })
  }
  workspaceCreateEntry(sessionId: string, path: string, kind: 'file' | 'directory'): Promise<WorkspaceCreateResult> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/entry`, { path, kind })
  }
  workspaceRenameEntry(sessionId: string, path: string, newName: string, expectedRevision: string): Promise<WorkspaceRenameResult> {
    return this.patch(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/entry`, {
      path,
      new_name: newName,
      expected_revision: expectedRevision,
    })
  }
  workspaceRemoveEntry(sessionId: string, path: string, expectedRevision: string, recursive = false): Promise<WorkspaceRemoveResult> {
    const query = new URLSearchParams({
      path,
      expected_revision: expectedRevision,
      recursive: String(recursive),
    })
    return this.delete(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/entry?${query}`)
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    return (await this.post<{ session: Session }>('/api/sessions', {
      title: input.title,
      folder: input.folder,
      cwd: input.cwd,
      backend: input.backend,
      model: input.model || null,
      effort: input.effort || null,
      system_prompt: input.system_prompt || null,
      provider_jobs_access: input.provider_jobs_access ?? null,
      provider_session_id: input.providerId || null,
      import_history: Boolean(input.providerId),
    })).session
  }

  async updateSession(sessionId: string, patch: Partial<Session>): Promise<Session> {
    return (await this.patch<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}`, patch)).session
  }
  async reloadProvider(sessionId: string): Promise<ProviderReloadResult> {
    try {
      return await this.post<ProviderReloadResult>(
        `/api/sessions/${encodeURIComponent(sessionId)}/provider/reload`,
        {},
      )
    } catch (error) {
      const routeIsUnavailable = error instanceof ServerError && (
        [405, 501].includes(error.status)
        || (error.status === 404 && error.message.trim().toLowerCase() === 'not found')
      )
      if (routeIsUnavailable) {
        throw new Error('This AgentsServer version does not support reloading a chat agent. Update the server and try again.')
      }
      throw error
    }
  }
  async deleteSession(sessionId: string): Promise<boolean> {
    const result = await this.delete<{ deleted?: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}`)
    return result.deleted !== false
  }
  async listSurfaces(): Promise<Surface[]> { return (await this.get<{ surfaces: Surface[] }>('/api/surfaces')).surfaces }
  async createSurface(input: CreateSurfaceInput): Promise<Surface> { return (await this.post<{ surface: Surface }>('/api/surfaces', input)).surface }
  async updateSurface(surfaceId: string, patch: UpdateSurfaceInput): Promise<Surface> {
    return (await this.patch<{ surface: Surface }>(`/api/surfaces/${encodeURIComponent(surfaceId)}`, patch)).surface
  }
  async deleteSurface(surfaceId: string): Promise<void> { await this.delete(`/api/surfaces/${encodeURIComponent(surfaceId)}`) }
  forkSession(sessionId: string): Promise<{ session: Session; sessions?: Session[] }> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {})
  }
  /**
   * `expectedLatestSeq` is the highest event seq this client has received for
   * the chat. Anything appended after it also lies after the target turn, so a
   * stale guard is retried once with the server's value; a refreshing Codex
   * sign-in (`rewind_provider_busy`) is retried once after its advertised delay.
   */
  /** Removes what history sync appended after the chat's first turn and syncs again. */
  reloadHistory(sessionId: string): Promise<SessionHistoryReloadResult> {
    return this.post<SessionHistoryReloadResult>(`/api/sessions/${encodeURIComponent(sessionId)}/history/reload`, {})
  }

  async rewindSession(sessionId: string, toRunId: string, expectedLatestSeq: number, toSeq?: number): Promise<SessionRewindResult> {
    const rewind = (latestSeq: number) => this.request<SessionRewindResult>(`/api/sessions/${encodeURIComponent(sessionId)}/rewind`, {
      method: 'POST', body: JSON.stringify({ to_run_id: toRunId, to_seq: toSeq, expected_latest_seq: latestSeq, confirmed: true }),
    }, REWIND_REQUEST_TIMEOUT_MS)
    let latestSeq = expectedLatestSeq
    let staleRetried = false
    let busyRetried = false
    for (;;) {
      try {
        return await rewind(latestSeq)
      } catch (error) {
        const detail = error instanceof ServerError && error.status === 409
          ? error.detail as { code?: unknown; latest_seq?: unknown; latest_event_seq?: unknown; retry_after_seconds?: unknown } | undefined
          : undefined
        const serverLatestSeq = detail?.latest_seq ?? detail?.latest_event_seq
        if (detail?.code === 'stale_latest_seq' && !staleRetried && Number.isSafeInteger(serverLatestSeq)) {
          staleRetried = true
          latestSeq = serverLatestSeq as number
          continue
        }
        if (detail?.code === 'rewind_provider_busy' && !busyRetried) {
          busyRetried = true
          const seconds = typeof detail.retry_after_seconds === 'number' && detail.retry_after_seconds > 0 ? detail.retry_after_seconds : 5
          await new Promise(resolve => setTimeout(resolve, Math.min(seconds, 30) * 1_000))
          continue
        }
        throw error
      }
    }
  }
  workspaceGitStatus(sessionId: string): Promise<WorkspaceGitStatus> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/git`, {}, 40_000, false, 'native-control')
  }
  workspaceGitDiff(sessionId: string, path: string, view: WorkspaceGitView): Promise<WorkspaceGitDiff> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/git/diff?path=${encodeURIComponent(path)}&view=${view}`, {}, 40_000, false, 'native-control')
  }
  workspaceGitConflict(sessionId: string, path: string): Promise<WorkspaceGitConflict> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/git/conflict?path=${encodeURIComponent(path)}`, {}, 40_000, false, 'native-control')
  }
  /**
   * Returns the status after the action. A stage or unstage rejected with
   * 409 `git_stale_revision` re-reads the status and is retried once against
   * the current revision (same shape as rewindSession's stale guard); any
   * other rejection, including a second stale one, surfaces to the caller.
   */
  async workspaceGitAction(sessionId: string, input: WorkspaceGitAction): Promise<WorkspaceGitStatus> {
    const post = (action: WorkspaceGitAction) => this.request<WorkspaceGitStatus>(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/git/action`, {
      method: 'POST', body: JSON.stringify(action),
    }, 120_000, false, 'native-control')
    try {
      return await post(input)
    } catch (error) {
      if (!retriesStaleGitAction(input.action, error)) throw error
      const current = await this.workspaceGitStatus(sessionId)
      return post({ ...input, expected_revision: current.revision })
    }
  }
  restoreCheckpoint(sessionId: string, runId: string, expectedRevision: string): Promise<WorkspaceGitStatus> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/git/checkpoint/restore`, {
      method: 'POST', body: JSON.stringify({ run_id: runId, expected_revision: expectedRevision, confirmed: true }),
    }, 120_000, false, 'native-control')
  }
  async reorderSession(sessionId: string, targetId: string, placement: 'before' | 'after', targetFolder?: string): Promise<Session[]> {
    return (await this.post<{ sessions: Session[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/order`, { target_id: targetId, placement, ...(targetFolder ? { target_folder: targetFolder } : {}) })).sessions
  }
  async markRead(sessionId: string, seq?: number | null): Promise<Session> {
    return (await this.post<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/read`, { last_read_agent_event_seq: seq ?? null })).session
  }
  async markUnread(sessionId: string): Promise<Session> {
    return (await this.post<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/unread`, {})).session
  }

  async acknowledgeEmergency(sessionId: string, alertId: string): Promise<Session> {
    return (await this.post<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/emergency/acknowledge`, {
      expected_alert_id: alertId,
    })).session
  }

  async sessionPage(sessionId: string, options: { after?: number; before?: number; limit?: number; tail?: boolean; visible?: boolean; compact?: boolean; pageMode?: 'semantic' } = {}): Promise<TimelinePage> {
    const query = new URLSearchParams()
    if (options.after != null) query.set('after', String(options.after))
    if (options.before != null) query.set('before', String(options.before))
    query.set('limit', String(options.limit ?? 240))
    query.set('tail', String(options.tail ?? true))
    query.set('visible', String(options.visible ?? true))
    if (options.compact === true) query.set('compact', 'true')
    if (options.pageMode === 'semantic') query.set('page_mode', 'semantic')
    const response = await this.get<SessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}?${query}`, TIMELINE_REQUEST_TIMEOUT_MS)
    const semanticRequested = options.pageMode === 'semantic'
    const semanticHonored = semanticRequested && response.semantic_item_count != null
    const nextSemanticBefore = response.next_semantic_before ?? null
    return {
      session: response.session,
      events: response.events,
      queued_turns: response.queued_turns ?? [],
      has_more: semanticHonored
        ? (response.semantic_omitted_before ?? response.events_omitted_before ?? 0) > 0
        : (response.events_omitted_before ?? 0) > 0,
      before: response.events[0]?.seq ?? null,
      next_before: semanticHonored
        ? nextSemanticBefore
        : response.next_before ?? response.events[0]?.seq ?? null,
      total: response.event_count ?? null,
      latest_seq: response.latest_seq ?? response.events.at(-1)?.seq ?? null,
      events_omitted_before: response.events_omitted_before ?? 0,
      events_omitted_after: response.events_omitted_after ?? 0,
      semantic_item_count: response.semantic_item_count ?? null,
      semantic_total: response.semantic_total ?? null,
      semantic_omitted_before: response.semantic_omitted_before ?? null,
      semantic_omitted_after: response.semantic_omitted_after ?? null,
      next_semantic_before: nextSemanticBefore,
      semantic_paging: semanticRequested ? semanticHonored : null,
    }
  }

  timelineIndex(sessionId: string): Promise<TimelineIndex> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/timeline-index`)
  }
  runTrace(
    sessionId: string,
    runId: string,
    anchorSeq: number,
    afterSeq = 0,
    limit = 160,
  ): Promise<TimelineTracePage> {
    const query = new URLSearchParams()
    const normalizedAnchor = Math.max(0, Math.floor(anchorSeq))
    // A zero anchor is not an actual timeline occurrence. Omitting it lets the
    // server select the newest occurrence of a reused run ID instead of
    // accidentally binding the request to the start of history.
    if (normalizedAnchor > 0) query.set('anchor_seq', String(normalizedAnchor))
    query.set('after_seq', String(Math.max(0, Math.floor(afterSeq))))
    query.set('limit', String(limit))
    return this.get(
      `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/trace?${query}`,
      TIMELINE_REQUEST_TIMEOUT_MS,
    )
  }
  async jobRuns(
    sessionId: string,
    jobId: string,
    beforeSeq?: number | null,
    limit = 20,
  ): Promise<JobRunHistoryPage> {
    const query = new URLSearchParams({ limit: String(limit) })
    if (beforeSeq != null) query.set('before_seq', String(beforeSeq))
    const response = await this.get<Omit<JobRunHistoryPage, 'supported'>>(
      `/api/sessions/${encodeURIComponent(sessionId)}/jobs/${encodeURIComponent(jobId)}/runs?${query}`,
      TIMELINE_REQUEST_TIMEOUT_MS,
    )
    return { ...response, supported: true }
  }
  codeDiff(sessionId: string, runId: string): Promise<CodeDiffResponse> {
    return this.requestBoundedText(
      `/api/sessions/${encodeURIComponent(sessionId)}/diffs/${encodeURIComponent(runId)}`,
      CODE_DIFF_MAX_BYTES,
    )
  }
  listCanvases(sessionId: string): Promise<{ canvases: CanvasSummary[] }> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/canvases`)
  }
  getCanvas(sessionId: string, name: string): Promise<CanvasRecord> {
    // The server compiles the report on first read (agentsdock_canvas.COMPILE_TIMEOUT_SECONDS = 180).
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(name)}`, 180_000)
  }
  putCanvasState(sessionId: string, name: string, state: Record<string, unknown>): Promise<{ state: Record<string, unknown> }> {
    return this.put(`/api/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(name)}/state`, { state })
  }
  /** Saves an edited source; the server answers 409 when the canvas changed after `baseRevision`. */
  putCanvasSource(sessionId: string, name: string, source: string, baseRevision: number): Promise<CanvasRecord> {
    return this.put(`/api/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(name)}/source`, { source, base_revision: baseRevision })
  }
  listCanvasComments(sessionId: string, name: string): Promise<{ threads: CanvasCommentThread[] }> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(name)}/comments`)
  }
  /** Stores the thread and starts its turn; the server refuses both together. */
  createCanvasComment(sessionId: string, name: string, anchor: CanvasCommentAnchor, input: CanvasCommentInput): Promise<{ thread: CanvasCommentThread }> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(name)}/comments`, { anchor, ...input })
  }
  replyCanvasComment(sessionId: string, name: string, threadId: string, input: CanvasCommentInput): Promise<{ thread: CanvasCommentThread }> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(name)}/comments/${encodeURIComponent(threadId)}/messages`, input)
  }
  setCanvasCommentStatus(sessionId: string, name: string, threadId: string, status: CanvasCommentThread['status']): Promise<{ thread: CanvasCommentThread }> {
    return this.patch(`/api/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(name)}/comments/${encodeURIComponent(threadId)}`, { status })
  }
  deleteCanvasComment(sessionId: string, name: string, threadId: string): Promise<{ deleted: string }> {
    return this.delete(`/api/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(name)}/comments/${encodeURIComponent(threadId)}`)
  }
  /** shell.html / vendor.js for the Canvas page: text bodies, so this bypasses request()'s JSON decoding. */
  async canvasRuntimeAsset(asset: 'shell.html' | 'vendor.js'): Promise<string> {
    const scope = this.captureScope()
    const response = await this.fetchWithTimeout(
      buildURL(scope.configuration.baseURL, `/api/canvas-runtime/${asset}`),
      { headers: authHeaders(scope.configuration.token) },
      60_000,
      scope.signal,
    )
    if (!response.ok) {
      const error = await this.serverError(response)
      this.assertScopeActive(scope)
      this.reportServerError(error)
      this.revokeForAuthorizationFailure(error)
      throw error
    }
    const text = await response.text()
    this.assertScopeActive(scope)
    return text
  }
  async searchTimeline(sessionId: string, query: string, limit = 50): Promise<TimelineSearchResult[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    return (await this.get<{ results?: TimelineSearchResult[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/search?${params}`)).results ?? []
  }
  async searchSessions(query: string, limit = 80): Promise<TimelineSearchResult[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    return (await this.get<{ results?: TimelineSearchResult[] }>(`/api/search?${params}`)).results ?? []
  }

  sendTurn(
    sessionId: string,
    prompt: string,
    fileIds: string[],
    model?: string | null,
    effort?: string | null,
    clientCapabilities: readonly string[] = [],
    chatReferences: readonly ChatReference[] = [],
    teamReferences: readonly TeamReference[] = [],
    skillSelection?: ProviderCommandSelection,
    clientRequestId?: string,
  ): Promise<{ session: Session; event?: Event; queued?: boolean; queued_id?: string; position?: number }> {
    const body: Record<string, unknown> = {
      prompt,
      file_ids: fileIds,
      model: model ?? '',
      effort: effort ?? '',
    }
    // Interactive requests can pause waiting for an approval or user answer.
    // Mobile callers must opt in only after they can surface those prompts.
    if (clientCapabilities.length) body.client_capabilities = [...clientCapabilities]
    if (chatReferences.length) body.chat_references = chatReferences.map(reference => ({ ...reference }))
    if (teamReferences.length) body.team_references = teamReferences.map(reference => ({ ...reference }))
    // Only the opaque id and revision travel; the server rejects anything else.
    if (skillSelection) body.skill_selection = { id: skillSelection.id, revision: skillSelection.revision }
    if (clientRequestId) body.client_request_id = clientRequestId
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/turns`, body)
  }
  providerCommands(sessionId: string, refresh = false): Promise<ProviderCommandsSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/provider-commands?refresh=${refresh ? 'true' : 'false'}`)
  }
  async stopTurn(sessionId: string): Promise<TurnStopResult> {
    const response = await this.post<Partial<TurnStopResult>>(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, {})
    return {
      ...response,
      // Older servers returned only { ok: true }. Preserve that compatibility
      // while retaining all additive acknowledgement fields on newer servers.
      stopped: response.stopped ?? response.ok ?? true,
    }
  }

  codexRuntime(sessionId: string): Promise<CodexRuntimeSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/codex/runtime`)
  }

  async resolveCodexInteraction(
    sessionId: string,
    interactionId: string,
    response: Record<string, JsonValue>,
  ): Promise<CodexPendingInteraction> {
    return (await this.post<{ interaction: CodexPendingInteraction }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/codex/interactions/${encodeURIComponent(interactionId)}/resolve`,
      { response },
    )).interaction
  }

  claudeRuntime(sessionId: string): Promise<ClaudeRuntimeSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/claude/runtime`)
  }

  claudeMcp(sessionId: string): Promise<ClaudeMcpSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/claude/mcp`)
  }

  controlClaudeMcp(sessionId: string, input: ClaudeMcpControlInput): Promise<ClaudeMcpSnapshot> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/claude/mcp`, input)
  }

  setClaudeGoal(sessionId: string, condition: string): Promise<ClaudeRuntimeSnapshot> {
    return this.put(`/api/sessions/${encodeURIComponent(sessionId)}/claude/goal`, { condition })
  }

  clearClaudeGoal(sessionId: string): Promise<ClaudeRuntimeSnapshot> {
    return this.delete(`/api/sessions/${encodeURIComponent(sessionId)}/claude/goal`)
  }

  refreshClaudeContextUsage(sessionId: string): Promise<ClaudeRuntimeSnapshot> {
    return this.post(
      `/api/sessions/${encodeURIComponent(sessionId)}/claude/context-usage/refresh`,
      {},
    )
  }

  async resolveClaudeInteraction(
    sessionId: string,
    interactionId: string,
    response: Record<string, JsonValue>,
  ): Promise<ClaudePendingInteraction> {
    return (await this.post<{ interaction: ClaudePendingInteraction }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/claude/interactions/${encodeURIComponent(interactionId)}/resolve`,
      { response },
    )).interaction
  }

  codexGoal(sessionId: string): Promise<CodexGoalSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/codex/goal`)
  }

  setCodexGoal(sessionId: string, input: CodexGoalInput): Promise<CodexGoalSnapshot> {
    return this.put(`/api/sessions/${encodeURIComponent(sessionId)}/codex/goal`, input)
  }

  clearCodexGoal(sessionId: string): Promise<CodexGoalSnapshot> {
    return this.delete(`/api/sessions/${encodeURIComponent(sessionId)}/codex/goal`)
  }

  compactCodexThread(sessionId: string): Promise<CodexOperationAccepted> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/codex/compact`, {})
  }

  /** Runs Claude's native /compact as one validated command turn with lifecycle rows. */
  compactClaudeContext(sessionId: string): Promise<CodexOperationAccepted> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/claude/compact`, {})
  }

  rollbackCodexThread(sessionId: string, input: CodexRollbackInput): Promise<CodexRollbackResult> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/codex/rollback`, input)
  }

  reviewCodexThread(sessionId: string, input: CodexReviewInput): Promise<CodexOperationAccepted> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/codex/review`, {
      target: input.target,
      delivery: input.delivery ?? 'inline',
    })
  }

  shellCodexThread(sessionId: string, input: CodexShellInput): Promise<CodexOperationAccepted> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/codex/shell`, input)
  }

  async backgroundActivity(sessionId: string): Promise<BackgroundActivityItem[]> {
    return (await this.get<{ items: BackgroundActivityItem[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/background-activity`)).items
  }

  async stopBackgroundActivity(sessionId: string, id: string): Promise<boolean> {
    return (await this.post<{ stopped: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/background-activity/stop`, { id })).stopped
  }

  codexBackgroundTerminals(sessionId: string): Promise<CodexBackgroundTerminalsSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/codex/background-terminals`)
  }

  async terminateCodexBackgroundTerminal(
    sessionId: string,
    input: CodexBackgroundTerminalTerminateInput,
  ): Promise<boolean> {
    return (await this.post<{ terminated: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/codex/background-terminals/terminate`,
      input,
    )).terminated
  }

  async cleanCodexBackgroundTerminals(
    sessionId: string,
    input: CodexBackgroundTerminalsCleanInput,
  ): Promise<boolean> {
    return (await this.post<{ cleaned: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/codex/background-terminals/clean`,
      input,
    )).cleaned
  }
  async queue(sessionId: string): Promise<QueuedTurn[]> {
    return (await this.sessionPage(sessionId, { limit: 1, tail: true, visible: false })).queued_turns
  }
  subagents(sessionId: string, limit = 64): Promise<SubagentSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/subagents?limit=${limit}`)
  }
  async updateQueued(
    sessionId: string,
    queuedId: string,
    prompt: string,
    chatReferences?: readonly ChatReference[],
    clientCapabilities?: readonly string[],
    teamReferences?: readonly TeamReference[],
  ): Promise<void> {
    await this.patch(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}`, {
      prompt,
      ...(chatReferences ? { chat_references: chatReferences.map(reference => ({ ...reference })) } : {}),
      ...(clientCapabilities ? { client_capabilities: [...clientCapabilities] } : {}),
      ...(teamReferences ? { team_references: teamReferences.map(reference => ({ ...reference })) } : {}),
    })
  }
  async crossChatHandoff(envelopeId: string): Promise<CrossChatHandoff> {
    return (await this.get<{ handoff: CrossChatHandoff }>(
      `/api/cross-chat/handoffs/${encodeURIComponent(envelopeId)}`,
    )).handoff
  }
  agentHandoffRoutes(sessionId: string): Promise<AgentCrossChatRoutesSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/agent-handoff-routes`)
  }
  deleteAgentHandoffRoute(sessionId: string, routeId: string, expectedRevision: string): Promise<DeleteAgentCrossChatRouteResponse> {
    if (!expectedRevision.trim()) throw new Error('Refresh this grant before revoking it.')
    const params = new URLSearchParams({ expected_revision: expectedRevision })
    return this.delete(`/api/sessions/${encodeURIComponent(sessionId)}/agent-handoff-routes/${encodeURIComponent(routeId)}?${params}`)
  }
  async cancelCrossChatHandoff(envelopeId: string): Promise<CrossChatHandoffSummary> {
    return (await this.post<{ handoff: CrossChatHandoffSummary }>(
      `/api/cross-chat/handoffs/${encodeURIComponent(envelopeId)}/cancel`,
      {},
    )).handoff
  }
  async crossChatExchange(exchangeId: string): Promise<CrossChatExchange> {
    return (await this.get<{ exchange: CrossChatExchange }>(
      `/api/cross-chat/exchanges/${encodeURIComponent(exchangeId)}`,
    )).exchange
  }
  async cancelCrossChatExchange(exchangeId: string): Promise<CrossChatExchange> {
    return (await this.post<{ exchange: CrossChatExchange }>(
      `/api/cross-chat/exchanges/${encodeURIComponent(exchangeId)}/cancel`,
      {},
    )).exchange
  }
  async skipQueuedCrossChatDelivery(
    sessionId: string,
    queuedId: string,
    identity: QueuedCrossChatDeliveryIdentity,
  ): Promise<void> {
    await this.post(
      `/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}/skip-cross-chat-delivery`,
      identity,
    )
  }
  async removeQueued(sessionId: string, queuedId: string): Promise<void> {
    await this.delete(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}`)
  }
  async moveQueued(sessionId: string, queuedId: string, direction: 'up' | 'down'): Promise<void> {
    await this.post(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}/move`, { direction })
  }
  runQueuedNow(sessionId: string, queuedId: string): Promise<QueuedRunNowResponse> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queuedId)}/run-now`, {
      accept_deferred_queue_response: true,
    })
  }

  async createJob(input: CreateJobInput): Promise<Job> { return (await this.post<{ job: Job }>('/api/jobs', input)).job }
  async updateJob(jobId: string, patch: UpdateJobInput): Promise<Job> { return (await this.patch<{ job: Job }>(`/api/jobs/${encodeURIComponent(jobId)}`, patch)).job }
  async deleteJob(jobId: string): Promise<void> { await this.delete(`/api/jobs/${encodeURIComponent(jobId)}`) }
  runJob(jobId: string): Promise<JobRunResponse> {
    return this.post(`/api/jobs/${encodeURIComponent(jobId)}/run`, {})
  }

  files(sessionId: string, offset = 0, limit = 60, contentPrefix?: string): Promise<FilesPage> {
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) })
    if (contentPrefix) query.set('content_prefix', contentPrefix)
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/files?${query}`)
  }
  async upload(sessionId: string, file: UploadRef): Promise<AgentFile> {
    const scope = this.captureScope()
    if (!new File(file.uri).exists) {
      // The native layer reports an unreadable `uri` part only as a generic network
      // error after sending starts, so this stat is the one pre-flight signal for an
      // iOS photo whose bytes never materialized (iCloud, limited library, File provider).
      throw new Error(`Couldn’t read “${file.name || 'this file'}”. If it’s a photo stored in iCloud, open it once in Photos to download it, then try again.`)
    }
    // React Native streams a `uri` part from storage and names it after `name`; its
    // XMLHttpRequest reports upload progress, which fetch does not.
    const form = new Utf8FilenameFormData()
    form.append('file', { uri: file.uri, name: file.name, type: file.type || 'application/octet-stream' } as unknown as Blob)
    const request = new XMLHttpRequest()
    request.open('POST', buildURL(scope.configuration.baseURL, `/api/sessions/${encodeURIComponent(sessionId)}/files`))
    for (const [key, value] of Object.entries(authHeaders(scope.configuration.token))) request.setRequestHeader(key, value)
    // iOS otherwise ends a request idle for 60 s; Android applies this to the whole call,
    // hence `ontimeout` below. Either way it is the ceiling, the only fixed deadline.
    request.timeout = this.uploadTimeoutMs
    const timeoutError = (message: string) => Object.assign(new Error(message), { name: 'TimeoutError' })
    let watchdog: ReturnType<typeof setTimeout> | null = null
    let ceiling: ReturnType<typeof setTimeout> | null = null
    const onScopeAbort = () => request.abort()
    let result: { status: number; body: string }
    try {
      result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const fail = (error: Error) => {
          reject(error)
          request.abort()
        }
        // Progress is the connection taking more of the file. After the last byte is handed
        // over, a relay's buffer can still be in flight before the server sees the end of the
        // body, so the response window is the longer one.
        const expectProgressWithin = (timeoutMs: number, failure: string) => {
          if (watchdog !== null) clearTimeout(watchdog)
          watchdog = setTimeout(() => fail(timeoutError(failure)), timeoutMs)
        }
        ceiling = setTimeout(() => fail(timeoutError('The upload took too long.')), this.uploadTimeoutMs)
        expectProgressWithin(this.uploadStallTimeoutMs, 'The upload stalled.')
        request.upload.onprogress = event => (event.lengthComputable && event.loaded >= event.total
          ? expectProgressWithin(this.uploadResponseTimeoutMs, 'The server did not answer the upload.')
          : expectProgressWithin(this.uploadStallTimeoutMs, 'The upload stalled.'))
        request.onload = () => resolve({ status: request.status, body: request.responseText })
        request.onerror = () => reject(new Error(request.responseText || 'Network request failed'))
        request.ontimeout = () => reject(timeoutError('The upload took too long.'))
        // Settles a scope abort; the catch below rethrows it as the scope's own error.
        request.onabort = () => reject(new Error('aborted'))
        if (scope.signal.aborted) onScopeAbort()
        else scope.signal.addEventListener('abort', onScopeAbort, { once: true })
        request.send(form)
      })
    } catch (error) {
      if (scope.signal.aborted) this.throwScopeAbort(scope.signal)
      throw error
    } finally {
      if (watchdog !== null) clearTimeout(watchdog)
      if (ceiling !== null) clearTimeout(ceiling)
      scope.signal.removeEventListener('abort', onScopeAbort)
    }
    this.assertScopeActive(scope)
    if (result.status < 200 || result.status >= 300) {
      const error = await this.serverError(new Response(result.body, { status: result.status }))
      this.reportServerError(error)
      this.revokeForAuthorizationFailure(error)
      throw error
    }
    return (JSON.parse(result.body) as { file: AgentFile }).file
  }

  processes(sessionId: string): Promise<ProcessSnapshot> { return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/processes`) }
  async processLog(sessionId: string, path: string, lines = 300): Promise<string> {
    const query = new URLSearchParams({ path, lines: String(lines) })
    const value = await this.get<{ text?: string; output?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/processes/log?${query}`)
    return value.text ?? value.output ?? ''
  }
  async tmux(sessionId: string, includeAll = false): Promise<TmuxPane[]> {
    return (await this.get<{ panes?: TmuxPane[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/tmux?include_all=${includeAll}`)).panes ?? []
  }
  async captureTmux(sessionId: string, paneId: string, lines = 500): Promise<string> {
    const query = new URLSearchParams({ pane_id: paneId, lines: String(lines) })
    const value = await this.get<{ text?: string; output?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/tmux/capture?${query}`)
    return value.text ?? value.output ?? ''
  }
  terminalWindows(sessionId: string): Promise<TerminalWindowsSnapshot> { return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/windows`) }
  terminalAction(sessionId: string, action: TerminalAction, target?: string): Promise<TerminalWindowsSnapshot> {
    return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/action`, { action, target: target ?? null })
  }
  async deleteTerminal(sessionId: string): Promise<void> { await this.delete(`/api/sessions/${encodeURIComponent(sessionId)}/terminal`) }

  async previewDigest(sourceSessionId: string, targetSessionId: string, detail: string, userPrompt: string): Promise<string> {
    return (await this.post<{ digest: string }>(`/api/sessions/${encodeURIComponent(sourceSessionId)}/digest`, {
      target_session_id: targetSessionId || null,
      detail,
      user_prompt: userPrompt || null,
    })).digest
  }
  async sendDigest(sourceSessionId: string, targetSessionId: string, detail: string, userPrompt: string): Promise<void> {
    await this.post(`/api/sessions/${encodeURIComponent(sourceSessionId)}/digest/send`, {
      target_session_id: targetSessionId,
      detail,
      user_prompt: userPrompt || null,
    })
  }

  stream(sessionId: string, after: number, handlers: TimelineStreamHandlers): () => void {
    const { onEvent, onState, onProviderRuntime, onProviderUsage, onSideChatChanged } = handlers
    const scope = this.captureScope()
    const endpoint = new URL(buildURL(scope.configuration.baseURL, `/api/sessions/${encodeURIComponent(sessionId)}/events`))
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    const token = scope.configuration.token
    let socket: WebSocket | null = null
    let stopped = false
    let lastSeq = after
    let retryDelay = STREAM_RETRY_INITIAL_MS
    let retry: ReturnType<typeof setTimeout> | null = null
    let connectTimeout: ReturnType<typeof setTimeout> | null = null
    let stableConnectionTimer: ReturnType<typeof setTimeout> | null = null
    let reportedState: boolean | null = null
    const reportState = (connected: boolean, detail?: WebSocketStateDetail) => {
      if (reportedState === connected && !detail) return
      reportedState = connected
      onState(connected, detail)
    }
    const clearConnectTimeout = () => {
      if (connectTimeout) clearTimeout(connectTimeout)
      connectTimeout = null
    }
    const clearStableConnectionTimer = () => {
      if (stableConnectionTimer) clearTimeout(stableConnectionTimer)
      stableConnectionTimer = null
    }
    const unregister = () => { this.transportStops.delete(stop) }
    const scheduleRetry = () => {
      if (stopped || retry) return
      const delay = retryDelay
      retryDelay = Math.min(STREAM_RETRY_MAX_MS, retryDelay * 2)
      retry = setTimeout(() => {
        retry = null
        connect()
      }, delay)
    }
    const connect = () => {
      if (stopped) return
      clearConnectTimeout()
      const url = new URL(endpoint)
      url.searchParams.set('after', String(lastSeq))
      url.searchParams.set('visible', 'true')
      // Once /api/health advertised websocket_auth_v1 the token travels as a
      // subprotocol, in the desktop client's exact `agentsdock-token.<base64url>`
      // form, instead of a query parameter that proxies and access logs see.
      // Older servers keep the query form.
      const protocols = scope.configuration.websocketSubprotocolAuth
        ? [EVENTS_STREAM_PROTOCOL, ...(token ? [`agentsdock-token.${base64(token).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`] : [])]
        : undefined
      if (!protocols && token) url.searchParams.set('token', token)
      try {
        socket = new WebSocket(url.toString(), protocols)
      } catch (error) {
        reportState(false, websocketErrorDetail('timeline', error))
        scheduleRetry()
        return
      }
      const connectingSocket = socket
      connectTimeout = setTimeout(() => {
        if (stopped || socket !== connectingSocket || connectingSocket.readyState !== WebSocket.CONNECTING) return
        reportState(false)
        connectingSocket.close()
      }, STREAM_CONNECT_TIMEOUT_MS)
      socket.onopen = () => {
        if (stopped || socket !== connectingSocket) return
        clearConnectTimeout()
        clearStableConnectionTimer()
        // Do not reset backoff merely because a failing endpoint completed
        // the WebSocket handshake. Servers and proxies can accept and then
        // immediately drop a socket, which otherwise creates a permanent
        // two-connects-per-second battery loop.
        stableConnectionTimer = setTimeout(() => {
          stableConnectionTimer = null
          if (!stopped && socket === connectingSocket && connectingSocket.readyState === WebSocket.OPEN) {
            retryDelay = STREAM_RETRY_INITIAL_MS
          }
        }, STREAM_STABLE_CONNECTION_MS)
        reportState(true)
      }
      socket.onmessage = message => {
        if (stopped || socket !== connectingSocket) return
        try {
          const packet = JSON.parse(String(message.data)) as unknown
          if (isProviderUsageChanged(packet)) {
            if (packet.session_id === sessionId) onProviderUsage?.(packet.backend)
            return
          }
          if (isProviderRuntimeChanged(packet)) {
            if (packet.session_id === sessionId) onProviderRuntime?.(packet)
            return
          }
          if (isSideChatUpdated(packet)) {
            if (packet.session_id === sessionId) onSideChatChanged?.(packet.revision)
            return
          }
          const event = packet as Event
          if (Number.isFinite(event.seq) && event.seq > lastSeq) { lastSeq = event.seq; onEvent(event) }
        } catch { /* malformed packets are ignored */ }
      }
      socket.onclose = event => {
        clearConnectTimeout()
        clearStableConnectionTimer()
        if (socket === connectingSocket) socket = null
        if (stopped) return
        const fatal = FATAL_WEBSOCKET_CLOSE_CODES.has(event.code)
        const detail = fatal ? websocketCloseDetail('timeline', event.code, event.reason, true, false) : undefined
        // A 4401 is an explicit authentication rejection. Return validation-
        // required clients to health-only mode before notifying UI callers so
        // no HTTP work can slip through while the reconnect UI is catching up.
        if (event.code === 4401 && detail) {
          this.invalidateValidation(true)
          this.reportAuthorizationFailure(detail.error)
        }
        reportState(false, detail)
        if (fatal) {
          stopped = true
          unregister()
          return
        }
        scheduleRetry()
      }
      socket.onerror = () => { if (!stopped) reportState(false) }
    }
    const stop = () => {
      if (stopped) {
        unregister()
        return
      }
      stopped = true
      clearConnectTimeout()
      clearStableConnectionTimer()
      if (retry) clearTimeout(retry)
      retry = null
      const activeSocket = socket
      socket = null
      unregister()
      activeSocket?.close()
    }
    this.transportStops.add(stop)
    connect()
    return stop
  }

  private get<T>(path: string, timeoutMs?: number): Promise<T> { return this.request(path, {}, timeoutMs) }
  private post<T>(path: string, body: unknown): Promise<T> { return this.request(path, { method: 'POST', body: JSON.stringify(body) }) }
  private put<T>(path: string, body: unknown): Promise<T> { return this.request(path, { method: 'PUT', body: JSON.stringify(body) }) }
  private patch<T>(path: string, body: unknown): Promise<T> { return this.request(path, { method: 'PATCH', body: JSON.stringify(body) }) }
  private delete<T>(path: string): Promise<T> { return this.request(path, { method: 'DELETE' }) }

  private async requestBoundedText(path: string, maxBytes: number): Promise<CodeDiffResponse> {
    const scope = this.captureScope()
    const headers = new Headers(authHeaders(scope.configuration.token))
    headers.set('Accept', 'text/plain')
    headers.set('Range', `bytes=0-${Math.max(0, maxBytes - 1)}`)
    const response = await this.fetchWithTimeout(
      buildURL(scope.configuration.baseURL, path),
      { headers },
      30_000,
      scope.signal,
    )
    if (!response.ok) {
      const error = await this.serverError(response)
      this.assertScopeActive(scope)
      this.reportServerError(error)
      this.revokeForAuthorizationFailure(error)
      throw error
    }
    const contentLengthHeader = response.headers.get('content-length')
    const contentLength = contentLengthHeader && /^\d+$/u.test(contentLengthHeader) ? Number(contentLengthHeader) : null
    const contentRange = response.headers.get('content-range')?.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/iu) ?? null
    const rangeStart = contentRange ? Number(contentRange[1]) : null
    const rangeEnd = contentRange ? Number(contentRange[2]) : null
    const rangeLength = rangeStart != null && rangeEnd != null && rangeEnd >= rangeStart ? rangeEnd - rangeStart + 1 : null
    const rangeTotal = contentRange?.[3] && contentRange[3] !== '*' ? Number(contentRange[3]) : null
    const validRangeTotal = contentRange?.[3] === '*' || (rangeTotal != null && rangeEnd != null && rangeTotal >= rangeEnd + 1)
    const boundedResponse = response.status === 206
      ? contentLength != null
        && contentLength <= maxBytes
        && rangeStart === 0
        && rangeLength === contentLength
        && rangeLength <= maxBytes
        && validRangeTotal
      : contentLength != null && contentLength <= maxBytes
    if (!boundedResponse) {
      try { await response.body?.cancel() } catch { /* React Native may already have buffered the body. */ }
      this.assertScopeActive(scope)
      return { text: '', truncated: true }
    }
    const text = await response.text()
    this.assertScopeActive(scope)
    const rangeTruncated = Boolean(
      contentRange
      && contentRange[3] !== '*'
      && Number(contentRange[2]) + 1 < Number(contentRange[3]),
    )
    return {
      text: text.slice(0, maxBytes),
      truncated: response.status === 206 && contentRange?.[3] === '*'
        ? true
        : rangeTruncated || text.length > maxBytes,
    }
  }
  private async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = 30_000,
    allowUnvalidated = false,
    authentication: 'standard' | 'team-network' | 'native-control' = 'standard',
  ): Promise<T> {
    const scope = this.captureScope(allowUnvalidated)
    const headers = new Headers(init.headers)
    const credentials = authentication !== 'standard'
      ? teamNetworkAuthHeaders(scope.configuration.token)
      : authHeaders(scope.configuration.token)
    for (const [key, value] of Object.entries(credentials)) headers.set(key, value)
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
    const response = await this.fetchWithTimeout(buildURL(scope.configuration.baseURL, path), { ...init, headers }, timeoutMs, scope.signal)
    if (!response.ok) {
      const error = await this.serverError(response)
      this.assertScopeActive(scope)
      this.reportServerError(error)
      this.revokeForAuthorizationFailure(error)
      throw error
    }
    if (response.status === 204) {
      this.assertScopeActive(scope)
      return undefined as T
    }
    const value = await response.json() as T
    this.assertScopeActive(scope)
    return value
  }
  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, scopeSignal: AbortSignal): Promise<Response> {
    const controller = new AbortController()
    const externalSignals = [scopeSignal, init.signal].filter((signal): signal is AbortSignal => Boolean(signal))
    const abortListeners: Array<{ signal: AbortSignal; listener: () => void }> = []
    for (const signal of externalSignals) {
      const listener = () => abortController(controller, signal)
      if (signal.aborted) listener()
      else {
        signal.addEventListener('abort', listener, { once: true })
        abortListeners.push({ signal, listener })
      }
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      if (scopeSignal.aborted) this.throwScopeAbort(scopeSignal)
      return response
    } catch (error) {
      if (scopeSignal.aborted) this.throwScopeAbort(scopeSignal)
      throw error
    } finally {
      clearTimeout(timer)
      for (const { signal, listener } of abortListeners) signal.removeEventListener('abort', listener)
    }
  }
  private async serverError(response: Response): Promise<ServerError> {
    let detail = `${response.status} ${response.statusText}`
    let structuredDetail: unknown
    try {
      const body = await response.json() as { detail?: unknown }
      structuredDetail = body.detail ?? body
      detail = formatServerDetail(structuredDetail, detail)
    } catch { /* retain status */ }
    return new ServerError(response.status, detail, structuredDetail)
  }

  private assertActive(): void {
    if (this.disposed) throw new AgentServerClientDisposedError()
  }

  private assertValidated(): void {
    this.assertActive()
    if (!this.validated) throw new AgentServerClientUnvalidatedError()
  }

  private captureScope(allowUnvalidated = false): ClientScope {
    if (allowUnvalidated) this.assertActive()
    else this.assertValidated()
    return { configuration: this.configuration, signal: this.scopeController.signal }
  }

  private assertScopeActive(scope: ClientScope): void {
    if (scope.signal.aborted) this.throwScopeAbort(scope.signal)
  }

  private revokeForAuthorizationFailure(error: ServerError): void {
    // AgentsServer uses 401 for bearer-token failures. A 403 is an authenticated
    // domain permission response (for example, a workspace file becoming
    // read-only) and must not tear down the validated client or discard UI state.
    if (error.status !== 401) return
    this.invalidateValidation(true)
    this.reportAuthorizationFailure(error)
  }

  private invalidateValidation(alwaysAdvance = false): void {
    if (!this.validationRequired || (!this.validated && !alwaysAdvance)) return
    this.validated = false
    this.validationRevisionValue += 1
    this.stopCurrentScope(new AgentServerClientUnvalidatedError())
    this.scopeController = new AbortController()
  }

  private reportAuthorizationFailure(error: ServerError | WebSocketConnectionError): void {
    try { this.onAuthorizationFailure?.(error) } catch { /* validation remains revoked */ }
  }

  private reportServerError(error: ServerError): void {
    try { this.onServerError?.(error) } catch { /* preserve the original server rejection */ }
  }

  private throwScopeAbort(signal: AbortSignal): never {
    if (this.disposed) throw new AgentServerClientDisposedError()
    if (signal.reason instanceof Error) throw signal.reason
    const error = new Error('Agent server client connection changed')
    error.name = 'AbortError'
    throw error
  }

  private stopCurrentScope(reason?: unknown): void {
    try { this.scopeController.abort(reason) } catch { this.scopeController.abort() }
    for (const stop of [...this.transportStops]) {
      try { stop() } catch { /* continue closing the remaining transports */ }
    }
    this.transportStops.clear()
  }
}

function createConfiguration(baseURL: string, token: string): ClientConfiguration {
  return { baseURL: normalizeServerURL(baseURL), token, websocketSubprotocolAuth: false }
}

function buildURL(baseURL: string, path: string): string {
  return `${baseURL}${path.startsWith('/') ? path : `/${path}`}`
}

function authHeaders(token: string): Record<string, string> {
  return token ? { 'X-ZenithDock-Token': token } : {}
}

function teamNetworkAuthHeaders(token: string): Record<string, string> {
  return token ? { 'X-AgentsDock-Token': token } : {}
}

function abortController(controller: AbortController, source: AbortSignal): void {
  if (controller.signal.aborted) return
  try { controller.abort(source.reason) } catch { controller.abort() }
}

function isProviderUsageChanged(value: unknown): value is { type: 'provider_usage_changed'; session_id: string; backend: UsageBackend } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const packet = value as Record<string, unknown>
  return packet.type === 'provider_usage_changed'
    && packet.ephemeral === true
    && (packet.backend === 'codex' || packet.backend === 'claude')
    && typeof packet.session_id === 'string'
    && packet.session_id.length > 0
}

function isProviderRuntimeChanged(value: unknown): value is ProviderRuntimeChanged {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const packet = value as Record<string, unknown>
  return packet.type === 'provider_runtime_changed'
    && packet.ephemeral === true
    && packet.runtime === 'context_usage'
    && packet.backend === 'claude'
    && typeof packet.session_id === 'string'
    && packet.session_id.length > 0
}

function isSideChatUpdated(value: unknown): value is { type: 'side_chat_updated'; session_id: string; revision: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const packet = value as Record<string, unknown>
  return packet.type === 'side_chat_updated' && typeof packet.session_id === 'string'
    && Number.isSafeInteger(packet.revision) && (packet.revision as number) >= 0
}

function websocketCloseDetail(
  transport: 'timeline' | 'terminal',
  code: number,
  reason: string,
  fatal: boolean,
  retrying: boolean,
): WebSocketStateDetail {
  const resolvedReason = (typeof reason === 'string' ? reason.trim() : '') || fatalWebSocketReason(code)
  return {
    code,
    reason: resolvedReason,
    fatal,
    retrying,
    error: new WebSocketConnectionError(code, resolvedReason, fatal, transport),
  }
}

function websocketErrorDetail(transport: 'timeline' | 'terminal', error: unknown): WebSocketStateDetail {
  const reason = error instanceof Error ? error.message : String(error)
  return {
    code: 0,
    reason,
    fatal: false,
    retrying: true,
    error: new WebSocketConnectionError(0, reason, false, transport),
  }
}

function fatalWebSocketReason(code: number): string {
  if (code === 4401) return 'WebSocket authentication failed'
  if (code === 4404) return 'WebSocket resource was not found'
  if (code === 4409) return 'WebSocket connection conflict'
  return `WebSocket connection closed (${code})`
}

function formatServerDetail(detail: unknown, fallback: string): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const messages = detail.flatMap(value => {
      if (!value || typeof value !== 'object') return []
      const message = (value as { msg?: unknown }).msg
      return typeof message === 'string' && message.trim() ? [message.trim()] : []
    })
    if (messages.length) return [...new Set(messages)].join(' ')
  }
  if (detail && typeof detail === 'object') {
    const value = detail as { message?: unknown; action?: unknown }
    const message = typeof value.message === 'string' ? value.message.trim() : ''
    const action = typeof value.action === 'string' ? value.action.trim() : ''
    if (message || action) return [message, action].filter(Boolean).join(' ')
    try { return JSON.stringify(detail) } catch { return fallback }
  }
  return fallback
}
