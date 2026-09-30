import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Image } from 'expo-image'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { useShallow } from 'zustand/react/shallow'
import { MenuView, type MenuAction } from '@expo/ui/community/menu'
import { AlertCircle, ArrowDown, ArrowUp, Check, ChevronDown, CornerDownRight, File as FileIcon, Mail, MessageCircleMore, MessageSquareShare, Paperclip, Pencil, Search, Send, Square, Trash2, X } from 'lucide-react-native'
import { client, useAppStore } from '../store/useAppStore'
import {
  COMPOSER_INPUT_MAX_HEIGHT,
  COMPOSER_INPUT_MIN_HEIGHT,
  composerInputHeight,
  composerViewportLimits,
  measuredComposerInputHeight,
} from '../lib/composer-input-size'
import { trackEvent } from '../lib/analytics'
import { backendLabel, formatBytes, isImage } from '../lib/format'
import { FULLSCREEN_HEADER_GUTTER, FULLSCREEN_HEADER_MIN_HEIGHT, fullscreenModalPadding } from '../lib/fullscreen-modal-layout'
import { isAsyncQueuedChatMessage, isCrossChatDeliveryQueuedTurn, isUserQueuedTurn, isVisibleQueuedTurn, queuedDeliverySkipIdentity, queuedMoveCrossesDeliveryBarrier, queuedTurnHasEarlierDeliveryBarrier } from '../lib/queue'
import { isImageUpload, photoAssetsToUploads } from '../lib/uploads'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { isClaudeMcpCommand } from '../lib/claude-mcp'
import { TEAM_MAIL_COMMAND_TEMPLATE, teamMailCapabilityError, teamMailCommandError } from '../lib/team-mail-command'
import {
  CLAUDE_GOAL_COMMAND_DESCRIPTION,
  COMPOSER_COMMANDS,
  cacheProviderCommands,
  cachedProviderCommands,
  composerCommandTrigger,
  draftUsesProviderCommand,
  filterComposerCommands,
  forgetProviderCommands,
  goalCommandArgument,
  providerCommandContextKey,
  providerCommandForInvocation,
  providerCommandsAvailable,
  providerComposerCommands,
  type BoundProviderCommand,
  type ComposerCommand,
} from '../lib/composer-commands'
import { insertTeamReference, MAX_TEAM_REFERENCES, reconcileTeamReferences, teamMentionTrigger, teamMessagesAvailable, teamReferenceContractSupported, validTeamReferences, type TeamMentionCandidate, type TeamMentionTrigger } from '../lib/team-references'
import {
  caretAfterTextChange,
  chatMentionAction,
  chatMentionTrigger,
  chatReferenceLabel,
  chatReferenceWithAction,
  insertChatReference,
  localChatReferenceContractSupported,
  MAX_CHAT_REFERENCES,
  parseStoredChatReferences,
  reconcileChatReferences,
  routeHintMentionsAvailable,
  supportedCrossChatActions,
  supportedCrossChatTargetBackends,
  validChatReferences,
  type ChatMentionTrigger,
} from '../lib/chat-references'
import {
  COMPOSER_CARD_MAX_HEIGHT,
  COMPOSER_COMPACT_BACKEND_SLOT_WIDTH,
  COMPOSER_COMPACT_TOOLBAR_GAP,
  COMPOSER_COMPACT_TOOLBAR_HEIGHT,
  COMPOSER_COMPACT_TOOLBAR_PADDING,
  COMPOSER_DENSE_BACKEND_SLOT_WIDTH,
  COMPOSER_DENSE_TOOLBAR_GAP,
  COMPOSER_DENSE_TOOLBAR_PADDING,
  COMPOSER_EMPTY_CARD_MIN_HEIGHT,
  COMPOSER_SEND_FACE_SIZE,
  COMPOSER_SHELL_PADDING,
  COMPOSER_STOP_FACE_SIZE,
  COMPOSER_TOOLBAR_TOUCH_SIZE,
  isCompactComposerToolbar,
  isDenseComposerToolbar,
} from '../lib/composer-toolbar-layout'
import { cursorBackendUnavailableReason, isBackendLocked, runtimeCatalogHasSelectableModels, runtimeCatalogOptions, runtimeEffortAfterModelChange, runtimeEffortOptions, runtimeSelectionError, selectableChatBackends } from '../lib/runtime-catalog'
import { runtimeChipLabel } from '../lib/runtime-chip'
import { usePalette } from '../theme'
import type { AgentCrossChatRoute, AgentFile, Backend, ChatReference, ChatReferenceAction, FailedUpload, ProviderCommandSelection, ProviderCommandsSnapshot, QueuedTurn, Session, TeamReference, UploadRef } from '../types'
import { appendWelcomeExchange, isWelcomeSession } from '../lib/welcome-session'
import { Text, TextInput } from './AppText'
import { BackendMark } from './BackendMark'
import { useCodexRuntime } from './CodexRuntimeContext'
import { CodexGoalBar, CodexGoalEditorSheet } from './CodexGoalBar'
import { WorkingDirectoryPicker } from './WorkingDirectoryPicker'
import { SideChatButton, SideChatSheet } from './SideChatSheet'
import { useClaudeRuntime } from './ClaudeRuntimeContext'
import { IconButton, SheetCloseButton } from './ui'
import { FullscreenViewerCloseButton, SwipeDismissImage } from './FullscreenImageViewer'
import { TeamTargetPicker } from './TeamTargetPicker'
import { ComposerCommandPalette, type ProviderCommandLoadStatus } from './ComposerCommandPalette'
import { ComposerRuntimeSheet } from './ComposerRuntimeSheet'
import { useTextPrompt } from './TextPromptDialog'
import { TEAM_NETWORK_UI_ENABLED } from '../lib/team-network-ui'

const EMPTY_FILES: AgentFile[] = []
const EMPTY_PENDING: UploadRef[] = []
const EMPTY_FAILED: FailedUpload[] = []
const EMPTY_QUEUE: QueuedTurn[] = []
const EMPTY_CHAT_REFERENCES: ChatReference[] = []
const EMPTY_TEAM_REFERENCES: TeamReference[] = []
const EMPTY_SESSIONS: Session[] = []
const EMPTY_ROUTES: AgentCrossChatRoute[] = []
const EMPTY_ROUTE_IDS: ReadonlySet<string> = new Set()
const ATTACHMENT_PICKER_SEND_GUARD_MS = 600
const QUICK_MESSAGES = ['Status report', 'Keep going.', 'Verify the result carefully.'] as const
const QUICK_MESSAGE_ACTIONS: MenuAction[] = QUICK_MESSAGES.map((title, index) => ({
  id: `quick-message:${index}`,
  title,
}))
type AttachmentImageSource = { uri: string; headers?: Record<string, string> }
type ComposerSelection = { start: number; end: number }
type ComposerMentionTrigger = ChatMentionTrigger | TeamMentionTrigger
/** App-shell surfaces a slash command can open: chat details, the digest sheet, the job editor, or a new chat. */
export type ComposerShellAction = 'details' | 'digest' | 'job' | 'new-chat'

export function Composer({ sessionId, keyboardVisible, onSent, onOpenMcp, onShellAction }: { sessionId: string; keyboardVisible: boolean; onSent: () => void; onOpenMcp: () => void; onShellAction: (action: ComposerShellAction) => void }) {
  const welcome = isWelcomeSession(sessionId)
  const colors = usePalette()
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  const draft = useAppStore(state => state.drafts[sessionId] ?? '')
  const uploads = useAppStore(state => state.uploads[sessionId]) ?? EMPTY_FILES
  const pending = useAppStore(state => state.uploadPending[sessionId]) ?? EMPTY_PENDING
  const failed = useAppStore(state => state.uploadFailed[sessionId]) ?? EMPTY_FAILED
  const queuedTurns = useAppStore(state => state.snapshots[sessionId]?.queuedTurns) ?? EMPTY_QUEUE
  const queuedRunStatus = useAppStore(state => state.queuedRunStatus[sessionId])
  const health = useAppStore(state => state.health)
  const references = useAppStore(state => state.chatReferencesBySession[sessionId]) ?? EMPTY_CHAT_REFERENCES
  const teamReferences = useAppStore(state => state.teamReferencesBySession[sessionId]) ?? EMPTY_TEAM_REFERENCES
  const sourceSession = useAppStore(useShallow(state => {
    const session = state.sessions.find(value => value.id === sessionId)
    return session ? {
      backend: session.backend,
      model: session.model,
      effort: session.effort,
      backend_locked: session.backend_locked,
      session_id: session.session_id,
      claude_session_id: session.claude_session_id,
      codex_thread_id: session.codex_thread_id,
      cursor_session_id: session.cursor_session_id,
      cwd: session.cwd,
    } : null
  }))
  const backend = sourceSession?.backend
  const model = sourceSession?.model
  const effort = sourceSession?.effort
  const active = useAppStore(state => state.activeSessionIds.has(sessionId))
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const workspaceAdopting = useAppStore(state => state.workspaceAdopting)
  const setSessionDraft = useAppStore(state => state.setSessionDraft)
  const setChatReferencesForSession = useAppStore(state => state.setChatReferencesForSession)
  const setTeamReferencesForSession = useAppStore(state => state.setTeamReferencesForSession)
  const sendPrompt = useAppStore(state => state.sendPrompt)
  const stopTurn = useAppStore(state => state.stopTurn)
  const reloadProvider = useAppStore(state => state.reloadProvider)
  const updateSession = useAppStore(state => state.updateSession)
  const runtime = useAppStore(state => state.runtime)
  const codexRuntime = useCodexRuntime()
  const claudeRuntime = useClaudeRuntime()
  const { refresh: refreshCodexRuntime } = codexRuntime
  const { refresh: refreshClaudeRuntime } = claudeRuntime
  const attachFiles = useAppStore(state => state.attachFiles)
  const removeUpload = useAppStore(state => state.removeUpload)
  const removeFailedUpload = useAppStore(state => state.removeFailedUpload)
  const sending = useAppStore(state => state.sendingSessionIds.has(sessionId))
  const admitting = useAppStore(state => Boolean(state.turnAdmissionTokens[sessionId]))
  const editingTurn = useAppStore(state => state.editingTurn[sessionId] ?? null)
  const admissionPreflight = admitting && !sending
  const stopping = useAppStore(state => state.stoppingSessionIds.has(sessionId))
  const [pickingAttachment, setPickingAttachment] = useState(false)
  const [providerReloading, setProviderReloading] = useState(false)
  const [attachmentSendGuarded, setAttachmentSendGuarded] = useState(false)
  const [preview, setPreview] = useState<{ name: string; source: AttachmentImageSource } | null>(null)
  const [pickerTrigger, setPickerTrigger] = useState<ComposerMentionTrigger | null>(null)
  const [pickerQuery, setPickerQuery] = useState('')
  const [inputHeight, setInputHeight] = useState(COMPOSER_INPUT_MIN_HEIGHT)
  const [composerWidth, setComposerWidth] = useState(0)
  const [providerCommandState, setProviderCommandState] = useState<{ key: string | null; status: ProviderCommandLoadStatus; snapshot: ProviderCommandsSnapshot | null }>({ key: null, status: 'idle', snapshot: null })
  const [runtimeSheetSection, setRuntimeSheetSection] = useState<'model' | 'reasoning' | null>(null)
  const [goalEditorOpen, setGoalEditorOpen] = useState(false)
  const providerCommandBindingRef = useRef<BoundProviderCommand | null>(null)
  const providerCommandRequestRef = useRef(0)
  const { promptText, textPromptDialog } = useTextPrompt()
  const inputRef = useRef<TextInput>(null)
  const draftRef = useRef(draft)
  const referencesRef = useRef<ChatReference[]>(references)
  const teamReferencesRef = useRef<TeamReference[]>(teamReferences)
  const pickerTriggerRef = useRef<ComposerMentionTrigger | null>(pickerTrigger)
  const mentionOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingTeamPicker = useRef<TeamMentionTrigger | null>(null)
  const selectionRef = useRef<ComposerSelection>({ start: draft.length, end: draft.length })
  const pendingCaretRef = useRef<number | null>(null)
  const restoreInputAfterPickerRef = useRef(false)
  const dismissedMentionStartRef = useRef<number | null>(null)
  const attachmentSendGuardedRef = useRef(false)
  const attachmentSendGuardTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const queued = useMemo(() => queuedTurns.filter(isVisibleQueuedTurn), [queuedTurns])
  const routeRevoking = useAppStore(state => [...(state.revokingAgentRouteIds ?? EMPTY_ROUTE_IDS)].some(key => key.startsWith(`${sessionId}:`)))
  const referencedTargetIds = useMemo(() => new Set(references.map(reference => reference.session_id)), [references])
  // Live events replace the sessions array and the active session object. Keep
  // typing isolated from that high-frequency stream: referenced target objects
  // stay referentially stable unless their own eligibility actually changes.
  useAppStore(state => referencedTargetIds.size ? [...referencedTargetIds].map(targetId => {
    const target = state.sessions.find(candidate => candidate.id === targetId)
    return target ? `${target.id}:${target.backend}:${target.archived ? 1 : 0}` : `${targetId}:missing`
  }).join('|') : '')
  const supportedChatActions = useMemo(() => supportedCrossChatActions(health), [health])
  const supportedTargetBackends = useMemo(() => supportedCrossChatTargetBackends(health), [health])
  const routeHintsSupported = routeHintMentionsAvailable(health)
  const requestReplySupportedForSource = supportedChatActions.includes('request_reply')
    && Boolean(backend && supportedTargetBackends.includes(backend))
  const crossChatSupported = routeHintsSupported
    && supportedChatActions.includes('route')
    && supportedTargetBackends.length > 0
  const referenceSupported = useCallback((reference: ChatReference): boolean => {
    const target = useAppStore.getState().sessions.find(candidate => candidate.id === reference.session_id)
    return Boolean(
      crossChatSupported
      && localChatReferenceContractSupported(health, reference)
      && (reference.action !== 'request_reply' || requestReplySupportedForSource)
      && target
      && !target.archived
      && supportedTargetBackends.includes(target.backend)
    )
  }, [crossChatSupported, health, requestReplySupportedForSource, supportedTargetBackends])
  const referencesSupported = references.length === 0 || references.every(referenceSupported)
  const teamMentionsSupported = teamMessagesAvailable(health)
  const teamReferencesSupported = teamReferences.every(reference => teamReferenceContractSupported(health, reference))
  const switching = Boolean(switchingProfileId) || workspaceAdopting
  const networkDisabled = !connected || connecting || switching || !client.isValidated
  const hasReadyContent = Boolean(draft.trim()) || (!welcome && uploads.length > 0)
  const mcpCommand = !welcome && isClaudeMcpCommand(draft)
  const mcpCommandLabel = backend === 'claude' ? 'Open Claude MCP servers' : 'Run /mcp command'
  // Slash palette: the draft is a lone `/word`. The native caret is not held
  // as state, so a draft ending in that token counts as caret-at-end.
  const commandTrigger = !welcome ? composerCommandTrigger(draft, draft.length) : null
  const providerCommandsKey = !welcome && sourceSession && providerCommandsAvailable(health, backend)
    ? providerCommandContextKey(activeProfileId, profileGeneration, health?.server_identity, { id: sessionId, backend: sourceSession.backend, cwd: sourceSession.cwd })
    : null
  const activeProviderCommandState = providerCommandState.key === providerCommandsKey
    ? providerCommandState
    : { key: providerCommandsKey, status: 'idle' as const, snapshot: null }
  const codexGoalsAvailable = backend === 'codex' && codexRuntime.goalsSupported && codexRuntime.goalsEnabled
  const claudeGoalsAvailable = backend === 'claude' && claudeRuntime.supported && claudeRuntime.runtime?.features?.goals === true
  const commandAvailable = (command: ComposerCommand): boolean => {
    if (!backend) return false
    if (command.provider) return command.provider.command.kind.length > 0
    switch (command.id) {
      case 'chat': return crossChatSupported
      case 'mail': return TEAM_NETWORK_UI_ENABLED && !teamMentionsSupported
      case 'goal': return codexGoalsAvailable || claudeGoalsAvailable
      case 'compact': return backend === 'codex' ? codexRuntime.supported : backend === 'claude' && claudeRuntime.supported
      case 'model': return runtimeCatalogHasSelectableModels(runtime)
      case 'reasoning': return backend !== 'cursor' && runtimeEffortOptions(runtime, backend, model, effort).some(option => Boolean(option.value))
      case 'mcp': return backend === 'claude'
      case 'schedule': return health?.capabilities?.scheduled_jobs?.available === true
      default: return true
    }
  }
  const allComposerCommands = useMemo(() => [
    ...COMPOSER_COMMANDS.map(command => command.id === 'goal' && backend === 'claude' ? { ...command, description: CLAUDE_GOAL_COMMAND_DESCRIPTION } : command),
    ...providerComposerCommands(activeProviderCommandState.snapshot, backend),
  ], [activeProviderCommandState.snapshot, backend])
  const commandCandidates = commandTrigger ? filterComposerCommands(allComposerCommands, commandTrigger.query, commandAvailable) : []
  const commandPaletteVisible = Boolean(commandTrigger && (commandCandidates.length > 0 || activeProviderCommandState.status === 'loading' || activeProviderCommandState.status === 'error'))
  const sendDisabled = welcome ? false : (networkDisabled || pending.length > 0 || failed.length > 0 || sending || admitting || routeRevoking || attachmentSendGuarded || !referencesSupported || !teamReferencesSupported)
  const effectiveSendDisabled = mcpCommand ? switching || admitting : sendDisabled
  const effectiveSendBusy = !mcpCommand && (sending || admitting)
  const attachmentDisabled = networkDisabled || pickingAttachment || admissionPreflight
  const quickMessageDisabled = networkDisabled || sending || admitting
  const providerReloadDisabled = networkDisabled || active || sending || admitting || stopping || providerReloading || !backend || backend === 'cursor'
  // A brand-new chat has no provider session yet, so its coding agent can still
  // change. Once the agent starts (backend_locked or a provider session id) or a
  // turn is in flight, the backend is fixed and only reload remains.
  const backendSwitchable = Boolean(backend) && !networkDisabled && !active && !admitting && !sending && !stopping && !providerReloading && !(sourceSession && isBackendLocked(sourceSession))
  // An active Codex draft renders every toolbar action at once. Keep the
  // entire phone-width row icon-only so the trailing Send target cannot clip.
  // Window width is not the usable composer width when the sidebar or
  // inspector is beside the chat. Measure the card itself before choosing
  // labeled controls; the first render stays compact to avoid a clipped flash.
  const compactToolbar = composerWidth === 0 || isCompactComposerToolbar(composerWidth)
  const denseToolbar = compactToolbar && (composerWidth === 0 ? width < 352 : isDenseComposerToolbar(composerWidth))
  const viewportLimits = composerViewportLimits(width, height, keyboardVisible)
  const [workingDirectoryOpen, setWorkingDirectoryOpen] = useState(false)
  const [sideChatOpen, setSideChatOpen] = useState(false)
  const displayedInputHeight = Math.min(composerInputHeight(draft, inputHeight), viewportLimits.inputMaxHeight)
  const hasAuxiliaryContent = commandPaletteVisible || references.length > 0 || teamReferences.length > 0 || queued.length > 0 || Boolean(queuedRunStatus) || uploads.length > 0 || pending.length > 0 || failed.length > 0
  const validationRevision = client.validationRevision
  useEffect(() => {
    if (welcome || networkDisabled || !routeHintsSupported) return
    void useAppStore.getState().refreshAgentRoutes(sessionId, profileGeneration)
  }, [welcome, networkDisabled, routeHintsSupported, activeProfileId, profileGeneration, sessionId, validationRevision, health?.server_identity, health?.server_instance_id])
  const loadProviderCommands = useCallback(async (refresh = false) => {
    const key = providerCommandsKey
    if (!key || networkDisabled) return
    if (!refresh) {
      const cached = cachedProviderCommands(key)
      if (cached) { setProviderCommandState({ key, status: 'ready', snapshot: cached }); return }
    }
    const requestId = ++providerCommandRequestRef.current
    setProviderCommandState(previous => ({ key, status: 'loading', snapshot: previous.key === key ? previous.snapshot : null }))
    try {
      const snapshot = await client.providerCommands(sessionId, refresh)
      if (providerCommandRequestRef.current !== requestId || !composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
      cacheProviderCommands(key, snapshot)
      setProviderCommandState({ key, status: 'ready', snapshot })
    } catch {
      if (providerCommandRequestRef.current !== requestId) return
      setProviderCommandState(previous => ({ key, status: 'error', snapshot: previous.key === key ? previous.snapshot : null }))
    }
  }, [activeProfileId, networkDisabled, profileGeneration, providerCommandsKey, sessionId])
  useEffect(() => {
    providerCommandBindingRef.current = null
    providerCommandRequestRef.current += 1
  }, [providerCommandsKey])
  const commandPaletteOpen = commandTrigger != null
  useEffect(() => {
    // Fetch when the palette opens; a cached inventory is reused for 30 s, then refreshed server-side.
    if (!commandPaletteOpen || !providerCommandsKey) return
    if (activeProviderCommandState.status === 'idle') void loadProviderCommands()
    else if (activeProviderCommandState.status === 'ready' && !cachedProviderCommands(providerCommandsKey)) void loadProviderCommands(true)
  }, [commandPaletteOpen, providerCommandsKey, activeProviderCommandState.status, loadProviderCommands])
  const closePreview = useCallback(() => {
    setPreview(null)
    requestAnimationFrame(dismissAppKeyboard)
  }, [])
  const openPreview = useCallback((name: string, source: AttachmentImageSource) => {
    setPreview({ name, source })
    requestAnimationFrame(dismissAppKeyboard)
  }, [])
  // Native TextInput can deliver multiple edits before React commits a render.
  // Keep authority-bearing spans synchronized with the latest native edit,
  // rather than with the render closure that happened to create the handler.
  draftRef.current = draft
  referencesRef.current = references
  teamReferencesRef.current = teamReferences
  pickerTriggerRef.current = pickerTrigger
  useEffect(() => {
    setPreview(null)
    setPickerTrigger(null)
    setPickerQuery('')
    setRuntimeSheetSection(null)
    setGoalEditorOpen(false)
    selectionRef.current = { start: draft.length, end: draft.length }
    pendingCaretRef.current = null
    pendingTeamPicker.current = null
    restoreInputAfterPickerRef.current = false
    dismissedMentionStartRef.current = null
    if (mentionOpenTimer.current) clearTimeout(mentionOpenTimer.current)
    mentionOpenTimer.current = null
    return () => { if (mentionOpenTimer.current) clearTimeout(mentionOpenTimer.current) }
  }, [activeProfileId, profileGeneration, sessionId])
  useEffect(() => setInputHeight(COMPOSER_INPUT_MIN_HEIGHT), [activeProfileId, profileGeneration, sessionId])
  useEffect(() => {
    if (!draft.length) setInputHeight(COMPOSER_INPUT_MIN_HEIGHT)
  }, [draft.length])
  useEffect(() => {
    attachmentSendGuardedRef.current = false
    setAttachmentSendGuarded(false)
    if (attachmentSendGuardTimer.current) clearTimeout(attachmentSendGuardTimer.current)
    attachmentSendGuardTimer.current = null
  }, [activeProfileId, profileGeneration, sessionId])
  useEffect(() => () => {
    if (attachmentSendGuardTimer.current) clearTimeout(attachmentSendGuardTimer.current)
  }, [])

  const guardSendAfterPicker = useCallback(() => {
    attachmentSendGuardedRef.current = true
    setAttachmentSendGuarded(true)
    if (attachmentSendGuardTimer.current) clearTimeout(attachmentSendGuardTimer.current)
    attachmentSendGuardTimer.current = setTimeout(() => {
      attachmentSendGuardTimer.current = null
      attachmentSendGuardedRef.current = false
      setAttachmentSendGuarded(false)
    }, ATTACHMENT_PICKER_SEND_GUARD_MS)
  }, [])

  const storeReferences = useCallback((next: ChatReference[]) => {
    if (!composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    referencesRef.current = next
    setChatReferencesForSession(sessionId, next, profileGeneration)
  }, [activeProfileId, profileGeneration, sessionId, setChatReferencesForSession])

  const storeTeamReferences = useCallback((next: TeamReference[]) => {
    if (!composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    teamReferencesRef.current = next
    setTeamReferencesForSession(sessionId, next, profileGeneration)
  }, [activeProfileId, profileGeneration, sessionId, setTeamReferencesForSession])

  const discoverMention = useCallback((trigger: ComposerMentionTrigger | null) => {
    if (mentionOpenTimer.current) clearTimeout(mentionOpenTimer.current)
    mentionOpenTimer.current = null
    if (!trigger) { dismissedMentionStartRef.current = null; return }
    if (pickerTriggerRef.current || dismissedMentionStartRef.current === trigger.start) return
    if (trigger.kind === '@@' && !TEAM_NETWORK_UI_ENABLED) return
    if (trigger.kind !== '@@' && !crossChatSupported) return
    const show = () => {
      mentionOpenTimer.current = null
      if (!remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId) || pickerTriggerRef.current) return
      setPickerQuery(trigger.query)
      pickerTriggerRef.current = trigger
      setPickerTrigger(trigger)
    }
    // Native @ opens a sheet; leave a brief window for the second @ first.
    if (trigger.kind === '@') mentionOpenTimer.current = setTimeout(show, 250)
    else show()
  }, [activeProfileId, profileGeneration, sessionId, crossChatSupported])

  const updateComposerDraft = useCallback((text: string) => {
    if (!composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    const previousDraft = draftRef.current
    const nextReferences = reconcileChatReferences(previousDraft, text, referencesRef.current)
    const nextTeamReferences = reconcileTeamReferences(previousDraft, text, teamReferencesRef.current)
    const previousSelection = selectionRef.current
    const caret = caretAfterTextChange(previousDraft, text, previousSelection)
    draftRef.current = text
    referencesRef.current = nextReferences
    teamReferencesRef.current = nextTeamReferences
    selectionRef.current = { start: caret, end: caret }
    const binding = providerCommandBindingRef.current
    if (binding && !draftUsesProviderCommand(text, binding)) providerCommandBindingRef.current = null
    if (!text.length) setInputHeight(COMPOSER_INPUT_MIN_HEIGHT)
    setSessionDraft(sessionId, text, profileGeneration)
    setChatReferencesForSession(sessionId, nextReferences, profileGeneration)
    setTeamReferencesForSession(sessionId, nextTeamReferences, profileGeneration)
    const trigger = teamMentionTrigger(text, caret, nextReferences, nextTeamReferences) ?? chatMentionTrigger(text, caret, nextReferences)
    discoverMention(trigger)
  }, [activeProfileId, discoverMention, profileGeneration, sessionId, setChatReferencesForSession, setTeamReferencesForSession, setSessionDraft])

  const finishTargetPickerDismissal = useCallback(() => {
    if (!restoreInputAfterPickerRef.current) return
    restoreInputAfterPickerRef.current = false
    if (!composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) {
      pendingCaretRef.current = null
      pendingTeamPicker.current = null
      return
    }
    const teamTrigger = pendingTeamPicker.current
    if (teamTrigger) {
      pendingTeamPicker.current = null
      dismissedMentionStartRef.current = null
      pickerTriggerRef.current = teamTrigger
      setPickerTrigger(teamTrigger)
      setPickerQuery(teamTrigger.query)
      return
    }
    const pendingCaret = pendingCaretRef.current
    pendingCaretRef.current = null
    const selection = pendingCaret == null
      ? selectionRef.current
      : { start: pendingCaret, end: pendingCaret }
    requestAnimationFrame(() => {
      if (!composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
      inputRef.current?.focus()
      inputRef.current?.setNativeProps({ selection })
      selectionRef.current = selection
    })
  }, [activeProfileId, profileGeneration, sessionId])

  const closeTargetPicker = useCallback(() => {
    const currentTrigger = pickerTriggerRef.current
    if (!currentTrigger) return
    dismissedMentionStartRef.current = currentTrigger.start
    restoreInputAfterPickerRef.current = true
    pickerTriggerRef.current = null
    setPickerTrigger(null)
    setPickerQuery('')
    requestAnimationFrame(dismissAppKeyboard)
    if (Platform.OS !== 'ios') requestAnimationFrame(finishTargetPickerDismissal)
  }, [finishTargetPickerDismissal])

  const openTeamFromChatPicker = useCallback((query = '') => {
    const trigger = pickerTriggerRef.current
    if (!TEAM_NETWORK_UI_ENABLED || !trigger || trigger.kind === '@@') return
    pendingTeamPicker.current = { ...trigger, kind: '@@', query }
    closeTargetPicker()
  }, [closeTargetPicker])

  const openTargetPicker = useCallback((trigger?: ComposerMentionTrigger) => {
    if (trigger?.kind === '@@' && !TEAM_NETWORK_UI_ENABLED) return
    if (trigger?.kind !== '@@' && !crossChatSupported) {
      Alert.alert('Chat handoffs unavailable', 'Update the active AgentsServer to use agent-to-agent chat handoffs.')
      return
    }
    const selection = selectionRef.current
    const nextTrigger = trigger ?? {
      kind: '@' as const,
      start: Math.min(selection.start, selection.end),
      end: Math.max(selection.start, selection.end),
      query: '',
    }
    dismissedMentionStartRef.current = null
    if (mentionOpenTimer.current) clearTimeout(mentionOpenTimer.current)
    setPickerQuery(nextTrigger.query)
    pickerTriggerRef.current = nextTrigger
    setPickerTrigger(nextTrigger)
  }, [crossChatSupported])

  const chooseTarget = useCallback((target: Session): boolean => {
    const currentTrigger = pickerTriggerRef.current
    if (!currentTrigger || currentTrigger.kind === '@@' || !crossChatSupported || !remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return false
    if (referencesRef.current.length >= MAX_CHAT_REFERENCES) {
      Alert.alert('Chat reference limit reached', `A message can reference up to ${MAX_CHAT_REFERENCES} chats. Remove one before adding another.`)
      return false
    }
    const action = chatMentionAction(currentTrigger)
    if (!supportedChatActions.includes(action)) {
      Alert.alert('Chat handoffs unavailable', 'This server did not advertise a supported handoff action.')
      return false
    }
    const currentReferences = referencesRef.current
    const state = useAppStore.getState()
    const currentTarget = state.sessions.find(candidate => candidate.id === target.id)
    if (!currentTarget || currentTarget.archived || currentTarget.id === sessionId || !supportedCrossChatTargetBackends(state.health).includes(currentTarget.backend)) return false
    const routeSnapshot = state.agentRoutesBySession?.[sessionId]
    if (routeSnapshot && routeCapacityReached(routeSnapshot.routes, routeSnapshot.max_routes, currentReferences, target.id)) {
      Alert.alert('Route access limit reached', 'Revoke a granted route before adding another chat. Already granted chats remain available.')
      return false
    }
    if (currentReferences.some(reference => reference.session_id === target.id && reference.action === action)) {
      Alert.alert('Already selected', `${chatReferenceLabel(action)} is already selected for ${target.title}.`)
      return false
    }
    const currentDraft = draftRef.current
    const inserted = insertChatReference(currentDraft, currentTrigger, target, action)
    const shifted = reconcileChatReferences(currentDraft, inserted.text, currentReferences)
    const nextReferences = [...shifted, inserted.reference]
      .sort((left, right) => left.source_text_start - right.source_text_start)
    pendingCaretRef.current = inserted.caret
    selectionRef.current = { start: inserted.caret, end: inserted.caret }
    draftRef.current = inserted.text
    restoreInputAfterPickerRef.current = true
    pickerTriggerRef.current = null
    setSessionDraft(sessionId, inserted.text, profileGeneration)
    storeReferences(nextReferences)
    storeTeamReferences(reconcileTeamReferences(currentDraft, inserted.text, teamReferencesRef.current))
    setPickerTrigger(null)
    setPickerQuery('')
    requestAnimationFrame(dismissAppKeyboard)
    if (Platform.OS !== 'ios') requestAnimationFrame(finishTargetPickerDismissal)
    return true
  }, [activeProfileId, backend, crossChatSupported, finishTargetPickerDismissal, health, profileGeneration, sessionId, setSessionDraft, storeReferences, storeTeamReferences])

  const chooseTeamTarget = useCallback((candidate: TeamMentionCandidate) => {
    const trigger = pickerTriggerRef.current
    if (!trigger || trigger.kind !== '@@' || !remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId) || !teamMessagesAvailable(useAppStore.getState().health)) return false
    if (teamReferencesRef.current.length >= MAX_TEAM_REFERENCES) return false
    if (teamReferencesRef.current.some(reference => reference.team_id === candidate.target.team_id && reference.target_id === candidate.target.target_id)) {
      Alert.alert('Already selected', `${candidate.label} is already selected for this message.`)
      return false
    }
    const previousText = draftRef.current
    const inserted = insertTeamReference(previousText, trigger, candidate.target)
    if (!teamReferenceContractSupported(useAppStore.getState().health, inserted.reference)) return false
    const nextTeamReferences = [...reconcileTeamReferences(previousText, inserted.text, teamReferencesRef.current), inserted.reference]
    pickerTriggerRef.current = null
    pendingCaretRef.current = inserted.caret
    selectionRef.current = { start: inserted.caret, end: inserted.caret }
    draftRef.current = inserted.text
    restoreInputAfterPickerRef.current = true
    setSessionDraft(sessionId, inserted.text, profileGeneration)
    storeReferences(reconcileChatReferences(previousText, inserted.text, referencesRef.current))
    storeTeamReferences(nextTeamReferences)
    setPickerTrigger(null)
    setPickerQuery('')
    requestAnimationFrame(dismissAppKeyboard)
    if (Platform.OS !== 'ios') requestAnimationFrame(finishTargetPickerDismissal)
    return true
  }, [activeProfileId, profileGeneration, sessionId, finishTargetPickerDismissal, setSessionDraft, storeReferences, storeTeamReferences])

  const changeReferenceAction = useCallback((reference: ChatReference) => {
    showReferenceActionPicker({
      width,
      reference,
      actions: availableChatReferenceActions(supportedChatActions, requestReplySupportedForSource),
      onSelect: action => {
        const currentReferences = referencesRef.current
        const selected = currentReferences.find(candidate => sameChatReference(candidate, reference))
        if (!selected) return
        if (currentReferences.some(candidate => !sameChatReference(candidate, selected) && candidate.session_id === selected.session_id && candidate.action === action)) {
          Alert.alert('Already selected', `${chatReferenceLabel(action)} is already selected for ${reference.display_title_snapshot}.`)
          return
        }
        storeReferences(currentReferences.map(candidate => sameChatReference(candidate, selected) ? chatReferenceWithAction(candidate, action) : candidate))
      },
    })
  }, [requestReplySupportedForSource, storeReferences, supportedChatActions, width])

  const revokeReference = useCallback((reference: ChatReference) => {
    storeReferences(referencesRef.current.filter(candidate => !sameChatReference(candidate, reference)))
  }, [storeReferences])

  const handleSelectionChange = useCallback((event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
    const selection = event.nativeEvent.selection
    selectionRef.current = selection
    if (selection.start !== selection.end) { discoverMention(null); return }
    const trigger = teamMentionTrigger(draftRef.current, selection.start, referencesRef.current, teamReferencesRef.current) ?? chatMentionTrigger(draftRef.current, selection.start, referencesRef.current)
    discoverMention(trigger)
  }, [discoverMention])

  const setGoalFromCommand = async (argument: string) => {
    if (!remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    try {
      if (backend === 'codex') {
        await codexRuntime.updateGoal({ objective: argument, status: 'active' })
      } else if (backend === 'claude') {
        // Same server path as desktop: AgentsServer turns the condition into a native `/goal` turn.
        if (argument.toLocaleLowerCase() === 'clear') await client.clearClaudeGoal(sessionId)
        else await client.setClaudeGoal(sessionId, argument)
        void refreshClaudeRuntime()
      }
    } catch (error) {
      if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) Alert.alert('Could not update goal', errorText(error))
    }
  }
  const openRuntimeSheet = (section: 'model' | 'reasoning') => { setRuntimeSheetSection(section); requestAnimationFrame(dismissAppKeyboard) }
  const openGoalCommand = () => {
    if (backend === 'codex') { setGoalEditorOpen(true); requestAnimationFrame(dismissAppKeyboard); return }
    void promptText({
      title: 'Claude goal',
      message: 'Claude keeps working until this condition is met. Enter "clear" to remove the current goal.',
      confirmLabel: 'Set goal',
      placeholder: 'Completion condition',
    }).then(value => { if (value?.trim()) void setGoalFromCommand(value.trim()) })
  }
  const send = async (steer = false, promptOverride?: string, consumeComposer = true, skillSelection?: ProviderCommandSelection) => {
    if (welcome) {
      if (!consumeComposer) return
      const text = (useAppStore.getState().drafts[sessionId] ?? draftRef.current).trim()
      if (!text) return
      const snapshot = useAppStore.getState().snapshots[sessionId]
      if (!snapshot || !isWelcomeSession(snapshot.session.id)) return
      const nextSnapshot = appendWelcomeExchange(snapshot, text)
      useAppStore.setState(prev => {
        const prevSnapshot = prev.snapshots[sessionId]
        if (prevSnapshot !== snapshot) return prev
        return {
          snapshots: { ...prev.snapshots, [sessionId]: nextSnapshot },
          sessions: prev.sessions.map(session => isWelcomeSession(session.id) ? nextSnapshot.session : session),
          drafts: { ...prev.drafts, [sessionId]: '' },
          chatReferencesBySession: { ...prev.chatReferencesBySession, [sessionId]: [] },
          teamReferencesBySession: { ...prev.teamReferencesBySession, [sessionId]: [] },
        }
      })
      inputRef.current?.clear()
      onSent()
      return
    }
    const currentState = useAppStore.getState()
    const currentDraft = consumeComposer ? currentState.drafts[sessionId] ?? draftRef.current : ''
    if (consumeComposer && isClaudeMcpCommand(currentDraft)) {
      if (!composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
      const currentSession = currentState.sessions.find(candidate => candidate.id === sessionId)
      draftRef.current = ''
      setSessionDraft(sessionId, '', profileGeneration)
      inputRef.current?.clear()
      if (currentSession?.backend === 'claude') onOpenMcp()
      else Alert.alert('Claude MCP only', '/mcp is available in Claude chats only.')
      return
    }
    const goalArgument = consumeComposer ? goalCommandArgument(currentDraft) : null
    if (goalArgument != null && (codexGoalsAvailable || claudeGoalsAvailable)) {
      if (!composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
      draftRef.current = ''
      setSessionDraft(sessionId, '', profileGeneration)
      inputRef.current?.clear()
      if (goalArgument) void setGoalFromCommand(goalArgument)
      else openGoalCommand()
      return
    }
    const binding = providerCommandBindingRef.current
    const outgoingSkillSelection = skillSelection
      ?? (consumeComposer && binding && binding.contextKey === providerCommandsKey && draftUsesProviderCommand(currentDraft, binding) ? binding.selection : undefined)
    if (!remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    const currentUploads = consumeComposer ? currentState.uploads[sessionId] ?? uploads : EMPTY_FILES
    const currentReferences = consumeComposer ? currentState.chatReferencesBySession[sessionId] ?? referencesRef.current : EMPTY_CHAT_REFERENCES
    const currentTeamReferences = consumeComposer ? currentState.teamReferencesBySession[sessionId] ?? teamReferencesRef.current : EMPTY_TEAM_REFERENCES
    const currentHasReadyContent = Boolean(currentDraft.trim()) || currentUploads.length > 0
    const currentReferencesSupported = currentReferences.every(referenceSupported)
    const currentSendDisabled = networkDisabled
      || (currentState.uploadPending[sessionId]?.length ?? 0) > 0
      || (currentState.uploadFailed[sessionId]?.length ?? 0) > 0
      || currentState.sendingSessionIds.has(sessionId)
      || Boolean(currentState.turnAdmissionTokens[sessionId])
      || attachmentSendGuardedRef.current
      || !currentReferencesSupported
      || (currentTeamReferences.length > 0 && !teamMessagesAvailable(currentState.health))
    if (consumeComposer && (currentSendDisabled || !currentHasReadyContent)) return
    if (!consumeComposer && (networkDisabled || sending || admitting || !promptOverride?.trim())) return
    const mailError = consumeComposer && TEAM_NETWORK_UI_ENABLED ? teamMailCommandError(currentState.health, currentDraft) : null
    if (mailError) {
      Alert.alert('Team Network mail unavailable', mailError)
      return
    }
    const outgoingReferences = consumeComposer
      ? validChatReferences(currentDraft, currentReferences, sessionId)
      : EMPTY_CHAT_REFERENCES
    if (consumeComposer && outgoingReferences.length !== currentReferences.length) {
      Alert.alert('Chat reference changed', 'Remove the changed reference and select that chat again.')
      return
    }
    if (consumeComposer && !outgoingReferences.every(referenceSupported)) {
      Alert.alert('Chat handoff unavailable', 'This server cannot deliver one or more selected actions or target chats.')
      return
    }
    const outgoingTeamReferences = validTeamReferences(currentDraft, currentTeamReferences, outgoingReferences)
    if (outgoingTeamReferences.length !== currentTeamReferences.length) {
      Alert.alert('Team Network reference changed', 'Remove the changed reference and select that recipient again.')
      return
    }
    const editingTurnState = consumeComposer ? useAppStore.getState().editingTurn[sessionId] : null
    if (editingTurnState) {
      // The provider and history must be rewound before this send is admitted;
      // a refused rewind keeps the edit banner so the user can retry or cancel.
      if (!await useAppStore.getState().rewindSession(sessionId, editingTurnState.runId, profileGeneration, editingTurnState.seq)) return
      if (!remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    }
    const admissionToken = useAppStore.getState().beginTurnAdmission(sessionId)
    if (!admissionToken) return
    const admittedDraft = consumeComposer ? currentDraft : undefined
    const admittedFiles = consumeComposer ? currentUploads : undefined
    try {
      try {
        const request = sendPrompt(steer, profileGeneration, sessionId, {
          promptOverride,
          consumeComposer,
          admissionToken,
          admittedDraft,
          admittedFiles,
          chatReferences: outgoingReferences,
          teamReferences: outgoingTeamReferences,
          skillSelection: outgoingSkillSelection,
        })
        // sendPrompt consumes an accepted composer draft synchronously, before
        // its first network await. Clear the focused native buffer in the same
        // turn so iOS cannot echo the submitted text back through onChangeText.
        if (
          consumeComposer
          && useAppStore.getState().sendingSessionIds.has(sessionId)
          && !(useAppStore.getState().drafts[sessionId] ?? '').length
        ) inputRef.current?.clear()
        const sent = await request
        if (sent) trackEvent('message_sent')
        if (consumeComposer && sent) providerCommandBindingRef.current = null
        if (!sent && outgoingSkillSelection && providerCommandsKey) {
          // A refused selection usually means its command is gone; drop the cache so the next palette open re-reads it.
          forgetProviderCommands(providerCommandsKey)
          void loadProviderCommands(true)
        }
        if (sent && remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) onSent()
      } catch {
        // The store surfaces request failures; keep the draft available to retry.
      }
    } finally {
      useAppStore.getState().endTurnAdmission(sessionId, admissionToken)
    }
  }
  const pickFiles = async () => {
    if (attachmentDisabled || !remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    setPickingAttachment(true)
    try {
      const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
      if (!result.canceled && remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) {
        guardSendAfterPicker()
        void attachFiles(result.assets.map(file => ({ uri: file.uri, name: file.name, type: file.mimeType ?? undefined, size: file.size })), profileGeneration, sessionId)
      }
    } catch (error) {
      if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) Alert.alert('Files unavailable', pickerError(error))
    } finally {
      if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) setPickingAttachment(false)
    }
  }
  const pickPhotos = async () => {
    if (attachmentDisabled || !remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    setPickingAttachment(true)
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        orderedSelection: true,
        selectionLimit: 20,
      })
      if (!result.canceled && remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) {
        const photos = photoAssetsToUploads(result.assets)
        if (photos.length) {
          guardSendAfterPicker()
          void attachFiles(photos, profileGeneration, sessionId)
        }
      }
    } catch (error) {
      if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) Alert.alert('Photos unavailable', pickerError(error))
    } finally {
      if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) setPickingAttachment(false)
    }
  }
  const chooseAttachment = () => {
    if (attachmentDisabled || !remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    const choose = (index: number) => {
      if (index === 0) openTargetPicker()
      else if (index === 1) void pickPhotos()
      else if (index === 2) void pickFiles()
      else if (index === 3) openTargetPicker({ kind: '@@', start: Math.min(selectionRef.current.start, selectionRef.current.end), end: Math.max(selectionRef.current.start, selectionRef.current.end), query: '' })
    }
    if (Platform.OS === 'ios' && width < 720) {
      const options = ['Reference another chat', 'Photo Library', 'Files', 'Reference a server (@@)', 'Cancel']
      ActionSheetIOS.showActionSheetWithOptions({
        title: 'Add',
        options,
        cancelButtonIndex: options.length - 1,
      }, choose)
      return
    }
    Alert.alert('Add', undefined, [
      { text: 'Reference another chat', onPress: () => choose(0) },
      { text: 'Photo Library', onPress: () => choose(1) },
      { text: 'Files', onPress: () => choose(2) },
      { text: 'Reference a server (@@)', onPress: () => choose(3) },
      { text: 'Cancel', style: 'cancel' },
    ])
  }
  const quickMessageTrigger = <View
    testID="chat-quick-messages"
    accessible
    accessibilityRole="button"
    accessibilityLabel="Quick messages"
    accessibilityState={{ disabled: quickMessageDisabled }}
    style={[styles.quickMessages, { opacity: quickMessageDisabled ? 0.35 : 1 }]}
  >
    <MessageCircleMore size={19} color={colors.muted} strokeWidth={1.9} />
  </View>
  const quickMessageControl = quickMessageDisabled ? quickMessageTrigger : <MenuView
    title="Quick messages"
    actions={QUICK_MESSAGE_ACTIONS}
    onPressAction={event => {
      if (!remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
      const prefix = 'quick-message:'
      if (!event.nativeEvent.event.startsWith(prefix)) return
      const phrase = QUICK_MESSAGES[Number(event.nativeEvent.event.slice(prefix.length))]
      if (phrase) void send(false, phrase, false)
    }}
    style={styles.quickMessagesMenu}
  >
    {quickMessageTrigger}
  </MenuView>
  /** Replaces the draft with `text`, keeping focus with the caret at its end. */
  const replaceDraft = (text: string) => {
    const caret = text.length
    updateComposerDraft(text)
    pendingCaretRef.current = caret
    selectionRef.current = { start: caret, end: caret }
    requestAnimationFrame(() => {
      if (!composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
      inputRef.current?.focus()
      inputRef.current?.setNativeProps({ selection: { start: caret, end: caret } })
      pendingCaretRef.current = null
    })
  }
  const chooseMailCommand = () => {
    if (networkDisabled || !remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    const capabilityError = teamMailCapabilityError(health)
    if (capabilityError) {
      Alert.alert('Team Network mail unavailable', capabilityError)
      return
    }
    replaceDraft(TEAM_MAIL_COMMAND_TEMPLATE)
  }
  const runCompactCommand = async () => {
    if (!remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    if (backend === 'codex') {
      try {
        await codexRuntime.run(() => client.compactCodexThread(sessionId))
        if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) Alert.alert('Compacting context', 'Native context compaction started.')
      } catch (error) {
        if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) Alert.alert('Could not compact context', errorText(error))
      }
      return
    }
    // Claude compacts through its native `/compact`, sent as a provider command selection.
    let snapshot = activeProviderCommandState.snapshot ?? (providerCommandsKey ? cachedProviderCommands(providerCommandsKey) : null)
    if (!snapshot && providerCommandsKey) {
      try {
        snapshot = await client.providerCommands(sessionId)
        cacheProviderCommands(providerCommandsKey, snapshot)
      } catch (error) {
        if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) Alert.alert('Could not compact context', errorText(error))
        return
      }
    }
    const compact = providerCommandForInvocation(snapshot, backend, '/compact')
    if (!compact) {
      if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) Alert.alert('Compact unavailable', 'This Claude installation does not offer /compact.')
      return
    }
    await send(false, compact.command.invocation, false, compact.selection)
  }
  const chooseCommand = (command: ComposerCommand) => {
    if (!commandTrigger || !commandAvailable(command) || !composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    if (command.provider) {
      // Provider selections start at byte zero to match the server's revalidation contract.
      providerCommandBindingRef.current = {
        contextKey: providerCommandsKey ?? '',
        invocation: command.provider.command.invocation,
        name: command.provider.command.name,
        kind: command.provider.command.kind,
        selection: command.provider.selection,
      }
      replaceDraft(`${command.provider.command.invocation} `)
      return
    }
    if (command.id === 'mail') { chooseMailCommand(); return }
    updateComposerDraft('')
    switch (command.id) {
      case 'attach': chooseAttachment(); break
      case 'chat': openTargetPicker(); break
      case 'compact': void runCompactCommand(); break
      case 'digest': onShellAction('digest'); break
      case 'goal': openGoalCommand(); break
      case 'mcp': onOpenMcp(); break
      case 'model': case 'reasoning': openRuntimeSheet(command.id); break
      case 'new': onShellAction('new-chat'); break
      case 'schedule': onShellAction('job'); break
      case 'status': onShellAction('details'); break
      case 'workdir': setWorkingDirectoryOpen(true); break
    }
  }
  const providerName = backend ? backendLabel(backend) : 'Claude'
  const reloadChatAgent = async () => {
    if (providerReloadDisabled || !backend || !remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    setProviderReloading(true)
    try {
      const result = await reloadProvider(sessionId, profileGeneration)
      if (!composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
      if (!result) {
        Alert.alert(`Could not reload ${providerName}`, useAppStore.getState().error || 'The server did not reload this chat agent.')
        return
      }
      if (backend === 'codex') await refreshCodexRuntime()
      else await refreshClaudeRuntime()
      if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) {
        Alert.alert(`${providerName} reloaded`, result.message?.trim() || 'This chat kept its transcript and now has a fresh agent process.')
      }
    } finally {
      if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) setProviderReloading(false)
    }
  }
  const switchChatBackend = async (next: Backend) => {
    if (!backendSwitchable || next === backend || !remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
    // Clear model and effort: they are catalogued per backend, so the new agent
    // falls back to its server default rather than inheriting an invalid pick.
    const changed = await updateSession(sessionId, { backend: next, model: null, effort: null }, profileGeneration)
    if (!changed && composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) {
      Alert.alert('Could not change chat agent', useAppStore.getState().error || 'The server did not change this chat agent.')
    }
  }
  const cursorUnavailableReason = cursorBackendUnavailableReason(health, runtime)
  const backendActions: MenuAction[] = backendSwitchable ? selectableChatBackends(health).map(value => ({
    id: `switch-backend:${value}`,
    title: backendLabel(value),
    state: value === backend ? 'on' : 'off',
    attributes: value === 'cursor' && Boolean(cursorUnavailableReason) ? { disabled: true } : undefined,
  })) : []
  // Model and effort live in the chip beside the provider control; the sheet
  // only opens once the server has advertised models for every backend.
  const runtimeSelectable = !networkDisabled && runtimeCatalogHasSelectableModels(runtime)
  const selectionError = backend ? runtimeSelectionError(health, runtime, backend, model) : null
  const runtimeActions: MenuAction[] = []
  if (backendActions.length) runtimeActions.push({ id: 'switch-backend', title: 'Backend', subactions: backendActions })
  if (selectionError) runtimeActions.push({ id: 'runtime-selection-error', title: selectionError, attributes: { disabled: true } })
  if (!providerReloadDisabled) runtimeActions.push({ id: 'reload-provider', title: `Reload ${providerName}`, image: 'arrow.clockwise' })
  const runtimeInteractive = runtimeActions.length > 0
  const runtimeTrigger = welcome ? <View
    testID="chat-runtime-menu"
    accessible
    accessibilityRole="text"
    accessibilityLabel="AgentsDock"
    style={[styles.runtime, compactToolbar && styles.runtimeCompact, denseToolbar && styles.runtimeDense]}
  >
    <Image source={require('../../assets/icon.png')} contentFit="contain" style={{ width: 21, height: 21, borderRadius: 5 }} />
    {!compactToolbar ? <Text style={[styles.backend, { color: colors.text }]}>AgentsDock</Text> : null}
  </View> : backend ? <View
    testID="chat-runtime-menu"
    accessible
    accessibilityRole="button"
    accessibilityLabel={`Chat agent options for ${providerName}`}
    accessibilityState={{ disabled: !runtimeInteractive, busy: providerReloading }}
    style={[styles.runtime, compactToolbar && styles.runtimeCompact, denseToolbar && styles.runtimeDense, { opacity: runtimeInteractive ? 1 : 0.45 }]}
  >
    {providerReloading ? <ActivityIndicator size="small" color={colors.muted} /> : <BackendMark backend={backend} size={21} />}
    {!compactToolbar ? <Text style={[styles.backend, { color: colors.text }]}>{providerName}</Text> : null}
  </View> : null
  const runtimeControl = welcome || !runtimeTrigger || !runtimeInteractive ? runtimeTrigger : <MenuView
    title={`${providerName} agent`}
    actions={runtimeActions}
    onPressAction={event => {
      const action = event.nativeEvent.event
      if (action === 'reload-provider') void reloadChatAgent()
      else if (action.startsWith('switch-backend:')) void switchChatBackend(action.slice('switch-backend:'.length) as Backend)
    }}
    style={[styles.runtimeMenu, compactToolbar && styles.runtimeMenuCompact, denseToolbar && styles.runtimeMenuDense]}
  >
    {runtimeTrigger}
  </MenuView>
  // Desktop's runtime chip: `Model · Effort` plus a chevron; one tap opens the model and reasoning sheet.
  const runtimeChip = !welcome && backend ? <Pressable
    testID="chat-runtime-chip"
    accessibilityRole="button"
    accessibilityLabel="Model and reasoning"
    accessibilityState={{ disabled: !runtimeSelectable }}
    disabled={!runtimeSelectable}
    onPress={() => openRuntimeSheet('model')}
    style={({ pressed }) => [styles.runtimeChip, { opacity: !runtimeSelectable ? 0.45 : pressed ? 0.6 : 1 }]}
  >
    <View style={[styles.runtimeChipFace, { backgroundColor: colors.raised }]}>
      <Text style={[styles.backend, { color: colors.text }]} numberOfLines={1}>{runtimeChipLabel(runtime, backend, model, effort)}</Text>
      <ChevronDown size={13} color={colors.muted} />
    </View>
  </Pressable> : null

  return (
    <View testID="chat-composer" style={[styles.shell, { backgroundColor: colors.background }]}>
      {/* The chip hides with the auxiliary rail so a landscape phone keeps Send above the keyboard; /workdir still opens the sheet. */}
      {!welcome ? <WorkingDirectoryPicker sessionId={sessionId} chipVisible={viewportLimits.auxiliaryMaxHeight > 0} open={workingDirectoryOpen} onOpenChange={setWorkingDirectoryOpen} trailing={<SideChatButton sessionId={sessionId} onPress={() => { dismissAppKeyboard(); setSideChatOpen(true) }} />} /> : null}
      {!welcome && backend === 'codex' ? <CodexGoalBar /> : null}
      {hasAuxiliaryContent && viewportLimits.auxiliaryMaxHeight > 0 ? <ScrollView
        testID="composer-auxiliary-scroll"
        style={[styles.auxiliaryScroll, { maxHeight: viewportLimits.auxiliaryMaxHeight }]}
        contentContainerStyle={styles.auxiliaryContent}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {commandPaletteVisible ? <ComposerCommandPalette
          commands={commandCandidates}
          loadStatus={activeProviderCommandState.status}
          onRefresh={() => void loadProviderCommands(true)}
          onSelect={chooseCommand}
        /> : null}
        {references.length ? <ChatReferenceShelf
          references={references}
          referenceSupported={referenceSupported}
          onChangeAction={changeReferenceAction}
          onRemove={revokeReference}
          warning={!referencesSupported ? 'This server cannot deliver one or more selected actions or target chats.' : null}
          testID="composer-chat-references"
        /> : null}
        {teamReferences.length ? <View testID="composer-team-references" accessibilityLabel="Team Network recipients" style={styles.referenceShelfWrap}>
          {teamReferences.map(reference => <View key={`${reference.team_id}:${reference.target_id}`} style={[styles.referenceShelf, { borderColor: colors.border }]}>
            <Mail size={16} color={colors.blue} /><Text style={{ flex: 1, color: colors.text }}>@@{reference.display_name_snapshot} · Server inbox</Text>
            <IconButton icon={X} size={16} touchSize={44} label={`Remove reference to ${reference.display_name_snapshot}`} onPress={() => storeTeamReferences(teamReferencesRef.current.filter(candidate => candidate.team_id !== reference.team_id || candidate.target_id !== reference.target_id))} />
          </View>)}
          {!teamReferencesSupported ? <Text accessibilityRole="alert" style={{ color: colors.red }}>Reconnect this server to Team Network or remove the recipient reference.</Text> : null}
        </View> : null}
        {queued.length || queuedRunStatus ? <QueueShelf sessionId={sessionId} profileId={activeProfileId} profileGeneration={profileGeneration} networkDisabled={networkDisabled} onSent={onSent} onPreview={openPreview} /> : null}
        {(uploads.length || pending.length || failed.length) ? <AttachmentShelf
          sessionId={sessionId}
          uploads={uploads}
          pending={pending}
          failed={failed}
          connectionReady={!networkDisabled}
          disabled={switching || admissionPreflight}
          retryDisabled={networkDisabled || admissionPreflight}
          onPreview={openPreview}
          onRemove={fileId => { if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) removeUpload(fileId, profileGeneration, sessionId) }}
          onRemoveFailed={fileUri => { if (composerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) removeFailedUpload(fileUri, profileGeneration, sessionId) }}
          onRetry={file => { if (remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) void attachFiles([file], profileGeneration, sessionId) }}
        /> : null}
      </ScrollView> : null}
      {editingTurn ? <View testID="composer-editing-turn" accessibilityRole="summary" style={[styles.editingBanner, { backgroundColor: colors.raised, borderColor: colors.border }]}>
        <Pencil size={14} color={colors.blue} />
        <Text style={[styles.editingBannerText, { color: colors.text }]}>Editing an earlier turn. Sending replaces that turn and everything after it.</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel edit"
          testID="composer-cancel-editing-turn"
          onPress={() => useAppStore.getState().cancelEditingTurn(sessionId)}
          style={styles.editingBannerCancel}
        ><Text style={{ color: colors.blue, fontSize: 12, fontWeight: '800' }}>Cancel</Text></Pressable>
      </View> : null}
      <View
        onLayout={event => {
          const nextWidth = Math.floor(event.nativeEvent.layout.width)
          setComposerWidth(current => current === nextWidth ? current : nextWidth)
        }}
        style={[styles.composer, { backgroundColor: colors.surface, borderColor: colors.border }]}
      >
        <TextInput
          ref={inputRef}
          testID="chat-composer-input"
          accessibilityLabel="Message"
          value={draft}
          onChangeText={updateComposerDraft}
          onSelectionChange={handleSelectionChange}
          onContentSizeChange={event => setInputHeight(measuredComposerInputHeight(event.nativeEvent.contentSize.height))}
          placeholder={welcome ? 'Ask about setup…' : workspaceAdopting ? 'Preparing this server workspace…' : networkDisabled ? 'Server offline — drafts stay on this device' : active ? 'Queue a follow-up…' : 'Message'}
          placeholderTextColor={colors.muted}
          multiline
          editable={!switching && !admissionPreflight}
          textAlignVertical="top"
          scrollEnabled
          autoCorrect
          style={[styles.input, { color: colors.text, height: displayedInputHeight, maxHeight: viewportLimits.inputMaxHeight }]}
        />
        <View style={[styles.toolbar, compactToolbar && styles.toolbarCompact, denseToolbar && styles.toolbarDense]}>
          {!welcome ? <IconButton icon={Paperclip} disabled={attachmentDisabled} onPress={chooseAttachment} label="Add files, photos, or another chat" testID="chat-attach" /> : null}
          {runtimeControl}
          {runtimeChip}
          {!welcome ? quickMessageControl : null}
          <View style={styles.toolbarSpacer} />
          {active ? <Pressable
            accessibilityRole="button"
            accessibilityLabel={stopping ? 'Stopping agent' : 'Stop agent'}
            accessibilityState={{ disabled: networkDisabled || stopping, busy: stopping }}
            testID="chat-stop"
            disabled={networkDisabled || stopping}
            onPress={() => { if (remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) void stopTurn(profileGeneration, sessionId) }}
            style={({ pressed }) => [styles.stop, !compactToolbar && styles.stopWide, { backgroundColor: compactToolbar ? 'transparent' : colors.red, opacity: networkDisabled || stopping ? 0.35 : pressed ? 0.65 : 1 }]}
          >{compactToolbar ? <View style={[styles.compactStopFace, { backgroundColor: `${colors.red}18`, borderColor: `${colors.red}55` }]}>{stopping ? <ActivityIndicator size="small" color={colors.red} /> : <Square size={14} color={colors.red} fill={colors.red} strokeWidth={2} />}</View> : <>{stopping ? <ActivityIndicator size="small" color={colors.textOnAccent} /> : <Square size={17} color={colors.textOnAccent} fill={colors.textOnAccent} strokeWidth={2.2} />}<Text style={[styles.stopLabel, { color: colors.textOnAccent }]}>{stopping ? 'Stopping' : 'Stop'}</Text></>}</Pressable> : null}
          {active && hasReadyContent && !mcpCommand ? <Pressable
            accessibilityRole="button"
            accessibilityLabel="Steer current turn"
            accessibilityState={{ disabled: sendDisabled, busy: sending || admitting }}
            testID="chat-send-now"
            disabled={sendDisabled}
            onPress={() => void send(true)}
            style={({ pressed }) => [styles.steer, compactToolbar && styles.steerCompact, { opacity: sendDisabled || pressed ? 0.45 : 1 }]}
          >{sending || admitting ? <ActivityIndicator size="small" color={colors.blue} /> : <CornerDownRight size={compactToolbar ? 17 : 13} color={colors.blue} />}{!compactToolbar ? <Text style={{ color: colors.blue, fontSize: 11, fontWeight: '700' }}>Steer</Text> : null}</Pressable> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={mcpCommand ? mcpCommandLabel : active ? 'Queue message' : 'Send message'}
            accessibilityState={{ disabled: effectiveSendDisabled || !hasReadyContent, busy: effectiveSendBusy }}
            testID="chat-send"
            disabled={effectiveSendDisabled || !hasReadyContent}
            onPress={() => void send(false)}
            style={({ pressed }) => [styles.send, { opacity: effectiveSendDisabled || pressed ? 0.6 : 1 }]}
          >
            <View style={[styles.sendFace, { backgroundColor: !effectiveSendDisabled && hasReadyContent ? colors.blue : colors.raised }]}>{effectiveSendBusy ? <ActivityIndicator size="small" color={!effectiveSendDisabled && hasReadyContent ? colors.textOnAccent : colors.muted} /> : <Send size={17} color={!effectiveSendDisabled && hasReadyContent ? colors.textOnAccent : colors.muted} />}</View>
          </Pressable>
        </View>
      </View>
      <Modal visible={preview != null} animationType="fade" presentationStyle="fullScreen" onRequestClose={closePreview}>
        {preview ? <View onAccessibilityEscape={closePreview} style={[styles.previewModal, { backgroundColor: colors.background }, fullscreenModalPadding(insets, Platform.OS)]}>
          <View style={[styles.previewHeader, { borderColor: colors.border }]}><FullscreenViewerCloseButton onPress={closePreview} label="Close image preview" testID="attachment-preview-close" /><Text style={[styles.previewTitle, { color: colors.text }]} numberOfLines={1}>{preview.name}</Text></View>
          <SwipeDismissImage onDismiss={closePreview} resetKey={preview.source.uri} testID="attachment-image-dismiss-surface" gestureTestID="attachment-image-dismiss-gesture" style={styles.previewImage}>
            <Image source={preview.source} contentFit="contain" style={StyleSheet.absoluteFill} transition={120} />
          </SwipeDismissImage>
        </View> : null}
      </Modal>
      <ChatTargetPicker
        visible={!welcome && pickerTrigger != null && pickerTrigger.kind !== '@@'}
        width={width}
        query={pickerQuery}
        sourceSessionId={sessionId}
        supportedTargetBackends={supportedTargetBackends}
        references={references}
        requestReplySupported={requestReplySupportedForSource}
        referenceLimitReached={references.length >= MAX_CHAT_REFERENCES}
        onQueryChange={query => { if (query.startsWith('@')) openTeamFromChatPicker(query.replace(/^@+/u, '')); else setPickerQuery(query) }}
        onTeamNetwork={() => openTeamFromChatPicker()}
        onSelect={chooseTarget}
        onClose={closeTargetPicker}
        onDidDismiss={finishTargetPickerDismissal}
      />
      <TeamTargetPicker
        visible={TEAM_NETWORK_UI_ENABLED && !welcome && pickerTrigger?.kind === '@@'}
        width={width}
        query={pickerQuery}
        sourceSessionId={sessionId}
        referenceLimitReached={teamReferences.length >= MAX_TEAM_REFERENCES}
        onQueryChange={setPickerQuery}
        onSelect={chooseTeamTarget}
        onClose={closeTargetPicker}
        onDidDismiss={finishTargetPickerDismissal}
      />
      {!welcome && backend ? <ComposerRuntimeSheet
        section={runtimeSheetSection}
        models={runtimeCatalogOptions(runtime, backend, 'models', model)}
        efforts={backend === 'cursor' ? [] : runtimeEffortOptions(runtime, backend, model, effort)}
        model={model}
        effort={effort}
        onPickModel={value => {
          setRuntimeSheetSection(null)
          if (!remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
          void updateSession(sessionId, { model: value || null, effort: runtimeEffortAfterModelChange(runtime, backend, value || null, effort) }, profileGeneration)
        }}
        onPickEffort={value => {
          setRuntimeSheetSection(null)
          if (!remoteComposerScopeIsCurrent(activeProfileId, profileGeneration, sessionId)) return
          void updateSession(sessionId, { effort: value || null }, profileGeneration)
        }}
        onClose={() => setRuntimeSheetSection(null)}
      /> : null}
      {/* Outside the folder row, which hides while a landscape keyboard is up (the sheet's own included). */}
      {sideChatOpen ? <SideChatSheet sessionId={sessionId} onClose={() => setSideChatOpen(false)} /> : null}
      {!welcome && backend === 'codex' ? <CodexGoalEditorSheet visible={goalEditorOpen} onClose={() => { setGoalEditorOpen(false); requestAnimationFrame(dismissAppKeyboard) }} /> : null}
      {textPromptDialog}
    </View>
  )
}

function ChatReferenceShelf({ references, referenceSupported, onChangeAction, onRemove, warning, testID }: {
  references: readonly ChatReference[]
  referenceSupported: (reference: ChatReference) => boolean
  onChangeAction: (reference: ChatReference) => void
  onRemove?: (reference: ChatReference) => void
  warning?: string | null
  testID: string
}) {
  const colors = usePalette()
  return <View testID={testID} accessibilityLabel="Cross-chat actions" style={styles.referenceShelfWrap}>
    <ScrollView
      horizontal
      style={styles.referenceRail}
      contentContainerStyle={styles.referenceShelf}
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
    >
      {references.map(reference => {
        const supported = referenceSupported(reference)
        return <View
          key={`${reference.session_id}:${reference.source_text_start}:${reference.source_text_end}`}
          style={[styles.referenceChip, { backgroundColor: supported ? `${colors.blue}14` : `${colors.red}14`, borderColor: supported ? `${colors.blue}66` : colors.red }]}
        >
          <MessageSquareShare size={14} color={supported ? colors.blue : colors.red} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Cross-chat action for ${reference.display_title_snapshot}: ${chatReferenceLabel(reference.action)}. Change action`}
            onPress={() => onChangeAction(reference)}
            style={styles.referenceAction}
          >
            <Text style={[styles.referenceTitle, { color: colors.text }]} numberOfLines={1}>@{reference.display_title_snapshot}</Text>
            <Text style={[styles.referenceLabel, { color: supported ? colors.blue : colors.red }]} numberOfLines={1}>· {chatReferenceLabel(reference.action)}</Text>
            <ChevronDown size={13} color={supported ? colors.blue : colors.red} />
          </Pressable>
          {onRemove ? <IconButton icon={X} size={13} touchSize={44} onPress={() => onRemove(reference)} label={`Remove reference to ${reference.display_title_snapshot}`} /> : null}
        </View>
      })}
    </ScrollView>
    {warning ? <View accessibilityRole="alert" style={styles.referenceWarning}><AlertCircle size={13} color={colors.red} /><Text style={[styles.referenceWarningText, { color: colors.red }]}>{warning}</Text></View> : null}
  </View>
}

export function ChatTargetPicker({ visible, width, query, sourceSessionId, supportedTargetBackends, references, requestReplySupported, referenceLimitReached, onQueryChange, onTeamNetwork, onSelect, onClose, onDidDismiss }: {
  visible: boolean
  width: number
  query: string
  sourceSessionId: string
  supportedTargetBackends: readonly Session['backend'][]
  references: readonly ChatReference[]
  requestReplySupported: boolean
  referenceLimitReached: boolean
  onQueryChange: (query: string) => void
  onTeamNetwork: () => void
  onSelect: (target: Session) => boolean
  onClose: () => void
  onDidDismiss: () => void
}) {
  const colors = usePalette()
  const tablet = width >= 720
  const searchInputRef = useRef<TextInput>(null)
  const routeSnapshot = useAppStore(state => visible ? state.agentRoutesBySession?.[sourceSessionId] : undefined)
  const routes = routeSnapshot?.routes ?? EMPTY_ROUTES
  const loading = useAppStore(state => visible && (state.agentRouteLoadingSessionIds?.has(sourceSessionId) ?? false))
  const error = useAppStore(state => visible ? state.agentRouteErrorsBySession?.[sourceSessionId] : undefined)
  const revoking = useAppStore(state => visible ? state.revokingAgentRouteIds ?? EMPTY_ROUTE_IDS : EMPTY_ROUTE_IDS)
  const profileId = useAppStore(state => state.activeProfileId)
  const generation = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected && !state.connecting && !state.switchingProfileId && !state.workspaceAdopting)
  const revokedInFlight = useRef(new Map<string, symbol>())
  const selected = useRef(false)
  const validationRevision = client.validationRevision
  const actionScopeKey = useAppStore(state => composerActionScopeKey(state, sourceSessionId))
  useEffect(() => {
    selected.current = false
    revokedInFlight.current.clear()
    if (visible && connected && client.isValidated) void useAppStore.getState().refreshAgentRoutes(sourceSessionId, generation)
    return () => { revokedInFlight.current.clear() }
  }, [visible, sourceSessionId, profileId, generation, connected, validationRevision, actionScopeKey])
  const grantByTarget = useMemo(() => new Map(routes.map(route => [route.target_session_id, route])), [routes])
  const revoke = async (route: AgentCrossChatRoute) => {
    if (revokedInFlight.current.has(route.route_id) || !remoteComposerScopeIsCurrent(profileId, generation, sourceSessionId) || composerActionScopeKey(useAppStore.getState(), sourceSessionId) !== actionScopeKey) return
    const token = Symbol()
    revokedInFlight.current.set(route.route_id, token)
    try { await useAppStore.getState().revokeAgentRoute(sourceSessionId, route.route_id, route.revision, generation) }
    finally { if (revokedInFlight.current.get(route.route_id) === token) revokedInFlight.current.delete(route.route_id) }
  }
  const targets = useAppStore(useShallow(state => visible ? rankChatTargets(
    state.sessions.filter(candidate => (
      candidate.id !== sourceSessionId
      && !candidate.archived
      && supportedTargetBackends.includes(candidate.backend)
    )),
    query,
  ) : EMPTY_SESSIONS))
  // Status changes that do not affect session metadata (notably queued-turn
  // bookkeeping) still refresh an open picker through one stable primitive.
  useAppStore(state => visible ? targets.map(target => [
    target.id,
    state.activeSessionIds.has(target.id) ? 1 : 0,
    state.snapshots[target.id]?.queuedTurns.filter(isUserQueuedTurn).length ?? 0,
  ].join(':')).join('|') : '')
  const activeSessionIds = useAppStore.getState().activeSessionIds
  const queuedCount = (targetId: string) => useAppStore.getState().snapshots[targetId]?.queuedTurns.filter(isUserQueuedTurn).length ?? 0
  const needle = query.trim().toLocaleLowerCase()
  const detachedGrants = routes.filter(route => !targets.some(target => target.id === route.target_session_id)
    && (!needle || [route.alias, route.target.title, route.target_session_id].some(value => value?.toLocaleLowerCase().includes(needle))))
  const routeRevokeButton = (route: AgentCrossChatRoute) => {
    const busy = revoking.has(`${sourceSessionId}:${route.route_id}`)
    const disabled = busy || !connected || !client.isValidated
    return <Pressable testID={`chat-route-revoke-${route.route_id}`} accessibilityRole="button" accessibilityLabel={`Revoke access to ${route.target.title || route.alias || 'chat'}`} accessibilityState={{ disabled, busy }} disabled={disabled} onPress={() => void revoke(route)} style={({ pressed }) => [styles.routeRevoke, { opacity: disabled || pressed ? 0.5 : 1 }]}>{busy ? <ActivityIndicator size="small" color={colors.red} /> : <Text style={{ color: colors.red, fontSize: 12, fontWeight: '700' }}>Revoke</Text>}</Pressable>
  }
  return <Modal
    visible={visible}
    animationType="slide"
    presentationStyle={Platform.OS === 'ios' ? tablet ? 'formSheet' : 'pageSheet' : 'fullScreen'}
    allowSwipeDismissal
    onShow={() => searchInputRef.current?.focus()}
    onRequestClose={onClose}
    onDismiss={onDidDismiss}
  >
    {visible ? <SafeAreaView edges={Platform.OS === 'ios' ? ['bottom'] : ['top', 'bottom']} onAccessibilityEscape={onClose} style={[styles.targetPickerSafe, { backgroundColor: colors.background }]}>
      <View style={[styles.targetPickerGrabber, { backgroundColor: colors.border }]} />
      <View style={[styles.targetPickerPanel, tablet && styles.targetPickerPanelTablet]}>
        <View style={[styles.targetPickerHeader, { borderColor: colors.border }]}>
          <View style={styles.targetPickerHeading}>
            <Text style={[styles.targetPickerTitle, { color: colors.text }]}>Reference another chat</Text>
            <Text style={[styles.targetPickerSubtitle, { color: colors.muted }]}>Choose a chat. New access is granted when you send.</Text>
          </View>
          <SheetCloseButton onPress={onClose} label="Close chat picker" testID="chat-target-picker-close" />
        </View>
        <View style={[styles.targetSearch, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Search size={17} color={colors.muted} />
          <TextInput
            ref={searchInputRef}
            testID="chat-target-search"
            accessibilityLabel="Search target chats"
            value={query}
            onChangeText={onQueryChange}
            returnKeyType="search"
            submitBehavior="blurAndSubmit"
            onSubmitEditing={dismissAppKeyboard}
            clearButtonMode="while-editing"
            placeholder="Search chats"
            placeholderTextColor={colors.muted}
            style={[styles.targetSearchInput, { color: colors.text }]}
          />
        </View>
        {referenceLimitReached ? <View accessibilityRole="alert" testID="chat-target-reference-limit" style={[styles.referenceWarning, styles.targetLimitWarning]}><AlertCircle size={14} color={colors.red} /><Text style={[styles.referenceWarningText, { color: colors.red }]}>Maximum {MAX_CHAT_REFERENCES} chat references reached. Remove one before adding another.</Text></View> : null}
        {loading ? <View testID="chat-routes-loading" style={styles.routeNotice}><ActivityIndicator size="small" color={colors.blue} /><Text style={{ color: colors.muted }}>Refreshing granted access…</Text></View> : null}
        {error ? <View testID="chat-routes-error" accessibilityRole="alert" style={styles.routeNotice}><Text style={{ color: colors.red, flex: 1 }}>{error}</Text><Pressable testID="chat-routes-retry" accessibilityRole="button" accessibilityLabel="Retry loading granted chat access" disabled={!connected || loading} onPress={() => { if (remoteComposerScopeIsCurrent(profileId, generation, sourceSessionId)) void useAppStore.getState().refreshAgentRoutes(sourceSessionId, generation) }} style={styles.routeRevoke}><Text style={{ color: colors.blue }}>Retry</Text></Pressable></View> : null}
        {TEAM_NETWORK_UI_ENABLED ? <Pressable testID="chat-target-team-network" accessibilityRole="button" accessibilityLabel="Reference a server inbox with @@" onPress={onTeamNetwork} style={[styles.targetRow, { marginHorizontal: 16, backgroundColor: colors.surface, borderColor: colors.border }]}><Mail size={20} color={colors.blue} /><Text style={{ color: colors.blue }}>Servers (@@) · Team Network inbox</Text></Pressable> : null}
        <FlatList
          testID="chat-target-list"
          data={targets}
          keyExtractor={target => target.id}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="on-drag"
          onScrollBeginDrag={dismissAppKeyboard}
          contentContainerStyle={[styles.targetList, !targets.length && styles.targetListEmpty]}
          ListEmptyComponent={<View style={styles.targetEmpty}><MessageSquareShare size={28} color={colors.muted} /><Text style={[styles.targetEmptyTitle, { color: colors.text }]}>No matching chats</Text><Text style={[styles.targetEmptyBody, { color: colors.muted }]}>Try another title, folder, backend, or chat ID.</Text></View>}
          ListFooterComponent={<View style={{ gap: 8 }}>
            {detachedGrants.map(route => <View key={route.route_id} testID={`chat-detached-route-${route.route_id}`} style={[styles.targetRow, { borderColor: colors.border, backgroundColor: colors.surface }]}><View style={styles.targetIdentity}><Text style={[styles.targetTitle, { color: colors.text }]}>{route.target.title || route.alias || 'Unavailable chat'}</Text><Text style={[styles.targetMeta, { color: colors.muted }]}>Granted · {routeActionLabel(route)} · {route.target.available ? 'Available' : 'Target unavailable'}</Text></View>{routeRevokeButton(route)}</View>)}
            {routeSnapshot && routeCapacityReached(routes, routeSnapshot.max_routes, references) ? <Text testID="chat-route-capacity" style={{ color: colors.orange, fontSize: 12 }}>Route access limit reached. Granted chats remain available; revoke one to grant another.</Text> : null}
            {routes.length ? <Text style={{ color: colors.muted, fontSize: 12 }}>Revoke removes this chat’s granted cross-chat access. Removing a draft reference does not revoke access.</Text> : null}
          </View>}
          renderItem={({ item }) => {
            const count = queuedCount(item.id)
            const status = chatTargetStatus(item, activeSessionIds.has(item.id), count)
            const meta = [item.folder?.trim(), backendLabel(item.backend), tablet ? item.id.slice(0, 8) : null].filter(Boolean).join(' · ')
            const grant = grantByTarget.get(item.id)
            const capacityReached = Boolean(routeSnapshot && routeCapacityReached(routes, routeSnapshot.max_routes, references, item.id))
            const disabled = referenceLimitReached || capacityReached || !connected || !client.isValidated || Boolean(grant && revoking.has(`${sourceSessionId}:${grant.route_id}`))
            return <View style={[styles.routeRow, { backgroundColor: colors.surface, borderColor: colors.border }]}><Pressable
              testID={`chat-target-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Reference ${item.title}. ${grant ? 'Granted' : 'Will grant when sent'}. ${status}`}
              accessibilityHint={capacityReached ? 'Revoke an existing route to grant another chat.' : undefined}
              accessibilityState={{ disabled }}
              disabled={disabled}
              onPress={() => {
                if (selected.current || disabled || !remoteComposerScopeIsCurrent(profileId, generation, sourceSessionId) || composerActionScopeKey(useAppStore.getState(), sourceSessionId) !== actionScopeKey) return
                selected.current = onSelect(item)
              }}
              style={({ pressed }) => [styles.targetRow, styles.routeTarget, tablet && styles.targetRowTablet, { backgroundColor: pressed ? colors.raised : colors.surface, opacity: disabled ? 0.45 : 1 }]}
            >
              <View style={[styles.targetBackend, { backgroundColor: colors.raised }]}><BackendMark backend={item.backend} size={22} /></View>
              <View style={styles.targetIdentity}><Text style={[styles.targetTitle, { color: colors.text }]} numberOfLines={1}>{item.title || item.id}</Text><Text style={[styles.targetMeta, { color: colors.muted }]}>{grant ? `Granted · ${routeActionLabel(grant)}` : `Will grant when sent · ${requestReplySupported ? 'Send + Ask' : 'Send'}`}</Text><Text style={[styles.targetMeta, { color: colors.muted }]} numberOfLines={1}>{meta} · {status}</Text></View>
            </Pressable>{grant ? routeRevokeButton(grant) : null}</View>
          }}
        />
      </View>
    </SafeAreaView> : null}
  </Modal>
}

function availableChatReferenceActions(actions: readonly ChatReferenceAction[], requestReplySupportedForSource: boolean): ChatReferenceAction[] {
  // Modern local mentions grant a route; legacy one-shot actions must not be
  // offered as if they could be submitted through the current v7 contract.
  if (actions.includes('route')) return ['route']
  return actions.filter(action => action !== 'request_reply' || requestReplySupportedForSource)
}

function routeActionLabel(route: AgentCrossChatRoute): string {
  const send = route.actions.includes('instruction')
  const ask = route.actions.includes('request_reply')
  return send && ask ? 'Send + Ask' : send ? 'Send' : ask ? 'Ask' : 'No actions'
}

function routeCapacityReached(routes: readonly AgentCrossChatRoute[], maximum: number, references: readonly ChatReference[], targetId?: string): boolean {
  const granted = new Set(routes.map(route => route.target_session_id))
  const pending = new Set(references.filter(reference => reference.target_kind !== 'secure_peer' && reference.action === 'route' && reference.grant_intent === true && !granted.has(reference.session_id)).map(reference => reference.session_id))
  if (targetId && (granted.has(targetId) || pending.has(targetId))) return false
  return routes.length + pending.size >= maximum
}

function sameChatReference(left: ChatReference, right: ChatReference): boolean {
  return left.session_id === right.session_id
    && left.display_title_snapshot === right.display_title_snapshot
    && left.source_text_start === right.source_text_start
    && left.source_text_end === right.source_text_end
}

function showReferenceActionPicker({ width, reference, actions, onSelect }: {
  width: number
  reference: ChatReference
  actions: readonly ChatReferenceAction[]
  onSelect: (action: ChatReferenceAction) => void
}) {
  const ordered = (['route', 'direct_message', 'request_reply', 'instruction', 'final_result'] as const).filter(action => actions.includes(action))
  if (!ordered.length) {
    Alert.alert('Chat handoffs unavailable', 'This server did not advertise any compatible actions.')
    return
  }
  const labels = ordered.map(chatReferenceActionMenuLabel)
  if (Platform.OS === 'ios' && width < 720) {
    const options = [...labels, 'Cancel']
    ActionSheetIOS.showActionSheetWithOptions({
      title: `@${reference.display_title_snapshot} · ${chatReferenceLabel(reference.action)}`,
      options,
      cancelButtonIndex: options.length - 1,
    }, index => {
      const action = ordered[index]
      if (action) onSelect(action)
    })
    return
  }
  Alert.alert(`@${reference.display_title_snapshot}`, 'Choose how this chat should receive the message.', [
    ...ordered.map(action => ({ text: chatReferenceActionMenuLabel(action), onPress: () => onSelect(action) })),
    { text: 'Cancel', style: 'cancel' as const },
  ])
}

function chatReferenceActionMenuLabel(action: ChatReferenceAction): string {
  if (action === 'route') return 'Grant durable route'
  if (action === 'direct_message') return 'Direct message'
  if (action === 'request_reply') return 'Ask & return reply'
  if (action === 'final_result') return 'Send my final result'
  return 'Send only'
}

function rankChatTargets(targets: Session[], query: string): Session[] {
  const needle = query.trim().toLocaleLowerCase()
  return [...targets].sort((left, right) => {
    const leftRank = chatTargetSearchRank(left, needle)
    const rightRank = chatTargetSearchRank(right, needle)
    if (leftRank !== rightRank) return leftRank - rightRank
    const leftActivity = Date.parse(left.latest_event_at || left.updated_at || left.created_at || '') || 0
    const rightActivity = Date.parse(right.latest_event_at || right.updated_at || right.created_at || '') || 0
    if (leftActivity !== rightActivity) return rightActivity - leftActivity
    return (left.title || left.id).localeCompare(right.title || right.id)
  }).filter(target => chatTargetSearchRank(target, needle) < 9)
}

function chatTargetSearchRank(target: Session, needle: string): number {
  if (!needle) return 0
  const title = (target.title || '').toLocaleLowerCase()
  const folder = (target.folder || '').toLocaleLowerCase()
  const backend = target.backend.toLocaleLowerCase()
  const id = target.id.toLocaleLowerCase()
  if (title === needle) return 0
  if (title.startsWith(needle)) return 1
  if (title.includes(needle)) return 2
  if (folder.startsWith(needle)) return 3
  if (folder.includes(needle) || backend.includes(needle) || id.includes(needle)) return 4
  return 9
}

function chatTargetStatus(session: Session, active: boolean, queued: number): string {
  if (session.codex_needs_user_action || session.claude_needs_user_action) return 'Needs approval'
  if (active) return 'Running'
  if (queued > 0) return `Queued ${queued}`
  return 'Idle'
}

function AttachmentShelf({ sessionId, uploads, pending, failed, connectionReady, disabled, retryDisabled, onPreview, onRemove, onRemoveFailed, onRetry }: {
  sessionId: string
  uploads: AgentFile[]
  pending: UploadRef[]
  failed: FailedUpload[]
  connectionReady: boolean
  disabled: boolean
  retryDisabled: boolean
  onPreview: (name: string, source: AttachmentImageSource) => void
  onRemove: (fileId: string) => void
  onRemoveFailed: (fileUri: string) => void
  onRetry: (file: FailedUpload) => void
}) {
  const colors = usePalette()
  return <ScrollView
    horizontal
    testID="attachment-shelf"
    style={styles.uploadRail}
    contentContainerStyle={styles.uploads}
    showsHorizontalScrollIndicator={false}
    keyboardShouldPersistTaps="handled"
  >
    {uploads.map(file => {
      const image = isImage(file)
      // fileURL/authHeaders intentionally assert a validated connection, so
      // never evaluate them while the app is offline or switching servers.
      const source = image && connectionReady ? { uri: client.fileURL(sessionId, file.id), headers: client.authHeaders() } : null
      return <View key={`ready:${file.id}`} testID={`attachment-ready-${file.id}`} style={[styles.upload, { backgroundColor: colors.raised, borderColor: colors.border }]}>
        <Pressable disabled={!source} accessibilityRole={source ? 'button' : undefined} accessibilityLabel={source ? `Preview ${file.filename}` : file.filename} onPress={() => source && onPreview(file.filename, source)} style={styles.uploadIdentity}>
          <View style={[styles.fileIconWell, { backgroundColor: colors.surface }]}>{source ? <Image source={source} contentFit="cover" style={StyleSheet.absoluteFill} transition={120} /> : <FileIcon size={21} color={colors.muted} strokeWidth={1.8} />}</View>
          <View style={styles.uploadText}><Text style={[styles.uploadName, { color: colors.text }]} numberOfLines={1}>{file.filename}</Text><Text style={[styles.uploadMeta, { color: colors.muted }]} numberOfLines={1}>{formatBytes(file.size) || (image ? 'Photo ready' : 'File ready')}</Text></View>
        </Pressable>
        <IconButton icon={X} size={14} disabled={disabled} onPress={() => onRemove(file.id)} label={`Remove ${file.filename}`} />
      </View>
    })}
    {pending.map((file, index) => {
      const image = isImageUpload(file)
      const source = image ? { uri: file.uri } : null
      return <View key={`pending:${file.uri}`} testID={`attachment-pending-${index}`} style={[styles.upload, { backgroundColor: colors.raised, borderColor: colors.border }]}>
        <Pressable disabled={!source} accessibilityRole={source ? 'button' : undefined} accessibilityLabel={source ? `Preview ${file.name}` : file.name} onPress={() => source && onPreview(file.name, source)} style={styles.uploadIdentity}>
          <View style={[styles.fileIconWell, { backgroundColor: colors.surface }]}>{source ? <Image source={source} contentFit="cover" style={StyleSheet.absoluteFill} /> : <FileIcon size={21} color={colors.muted} strokeWidth={1.8} />}<View style={styles.uploadBusy}><ActivityIndicator size="small" color="white" /></View></View>
          <View style={styles.uploadText}><Text style={[styles.uploadName, { color: colors.text }]} numberOfLines={1}>{file.name}</Text><Text style={[styles.uploadMeta, { color: colors.blue }]} numberOfLines={1}>Uploading…</Text></View>
        </Pressable>
        <View style={styles.uploadActionSpacer} />
      </View>
    })}
    {failed.map((file, index) => <View key={`failed:${file.uri}`} testID={`attachment-failed-${index}`} style={[styles.upload, { backgroundColor: `${colors.red}12`, borderColor: colors.red }]}>
      <Pressable disabled={retryDisabled} accessibilityRole="button" accessibilityLabel={`Retry ${file.name}`} onPress={() => onRetry(file)} style={styles.uploadIdentity}>
        <View style={[styles.fileIconWell, { backgroundColor: colors.surface }]}>{isImageUpload(file) ? <Image source={{ uri: file.uri }} contentFit="cover" style={StyleSheet.absoluteFill} /> : <FileIcon size={21} color={colors.red} strokeWidth={1.8} />}<View style={[styles.uploadError, { backgroundColor: colors.surface }]}><AlertCircle size={15} color={colors.textOnAccent} fill={colors.red} /></View></View>
        <View style={styles.uploadText}><Text style={[styles.uploadName, { color: colors.text }]} numberOfLines={1}>{file.name}</Text><Text style={[styles.uploadMeta, { color: colors.red }]} numberOfLines={1}>Upload failed · Tap to retry</Text></View>
      </Pressable>
      <IconButton icon={X} size={14} disabled={disabled} onPress={() => onRemoveFailed(file.uri)} label={`Remove ${file.name}`} />
    </View>)}
  </ScrollView>
}

/**
 * A queued message's attachment: a thumbnail while the file is (or may be) an
 * image, else its name. Other devices never saw the upload, so an unknown file
 * tries the image first and falls back to the name.
 */
function QueuedAttachment({ sessionId, fileId, onPreview }: { sessionId: string; fileId: string; onPreview: (name: string, source: AttachmentImageSource) => void }) {
  const colors = usePalette()
  const known = useAppStore(state => state.snapshots[sessionId]?.files.find(file => file.id === fileId))
  const [failed, setFailed] = useState(false)
  const name = known?.filename ?? 'Attachment'
  if (!failed && (!known?.content_type || known.content_type.startsWith('image/'))) {
    const source = { uri: client.fileURL(sessionId, fileId), headers: client.authHeaders() }
    return <Pressable accessibilityRole="button" accessibilityLabel={`Preview ${name}`} onPress={() => onPreview(name, source)}>
      <Image
        source={source}
        contentFit="cover"
        style={[styles.queueThumb, { borderColor: colors.border, backgroundColor: colors.raised }]}
        onError={() => setFailed(true)}
      />
    </Pressable>
  }
  return <View style={[styles.queueFile, { borderColor: colors.border }]}>
    <FileIcon size={12} color={colors.muted} />
    <Text style={{ color: colors.muted, fontSize: 11 }} numberOfLines={1}>{name}</Text>
  </View>
}

export function QueueShelf({ sessionId, profileId, profileGeneration, networkDisabled, onSent, onPreview }: { sessionId: string; profileId: string | null; profileGeneration: number; networkDisabled: boolean; onSent: () => void; onPreview: (name: string, source: AttachmentImageSource) => void }) {
  const colors = usePalette()
  const { width } = useWindowDimensions()
  const allTurns = useAppStore(state => state.snapshots[sessionId]?.queuedTurns) ?? EMPTY_QUEUE
  const turns = useMemo(() => allTurns.filter(isVisibleQueuedTurn), [allTurns])
  const health = useAppStore(state => state.health)
  const sourceBackend = useAppStore(state => state.sessions.find(session => session.id === sessionId)?.backend)
  const queuedTargetIds = useMemo(() => new Set(turns.flatMap(turn => (turn.chat_references ?? []).map(reference => reference.session_id))), [turns])
  useAppStore(state => queuedTargetIds.size ? [...queuedTargetIds].map(targetId => {
    const target = state.sessions.find(candidate => candidate.id === targetId)
    return target ? `${target.id}:${target.backend}:${target.archived ? 1 : 0}` : `${targetId}:missing`
  }).join('|') : '')
  const supportedChatActions = useMemo(() => supportedCrossChatActions(health), [health])
  const supportedTargetBackends = useMemo(() => supportedCrossChatTargetBackends(health), [health])
  const requestReplySupportedForSource = supportedChatActions.includes('request_reply')
    && Boolean(sourceBackend && supportedTargetBackends.includes(sourceBackend))
  const pendingQueuedRunIds = useAppStore(state => state.pendingQueuedRunIds)
  const runStatus = useAppStore(state => state.queuedRunStatus[sessionId])
  const update = useAppStore(state => state.updateQueued)
  const remove = useAppStore(state => state.removeQueued)
  const move = useAppStore(state => state.moveQueued)
  const runNow = useAppStore(state => state.runQueuedNow)
  const skipDelivery = useAppStore(state => state.skipQueuedDelivery)
  const skippingDeliveryIds = useAppStore(state => state.skippingQueuedDeliveryIds ?? EMPTY_ROUTE_IDS)
  const sourceTitles = useAppStore(useShallow(state => Object.fromEntries(turns.filter(isAsyncQueuedChatMessage).map(turn => [turn.source_session_id ?? '', state.sessions.find(session => session.id === turn.source_session_id)?.title ?? 'Unknown agent']))))
  const clearRunStatus = useAppStore(state => state.clearQueuedRunStatus)
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [editReferences, setEditReferences] = useState<ChatReference[]>([])
  const [editTeamReferences, setEditTeamReferences] = useState<TeamReference[]>([])
  const editTextRef = useRef('')
  const editReferencesRef = useRef<ChatReference[]>([])
  const editTeamReferencesRef = useRef<TeamReference[]>([])
  const editingQueuedIdRef = useRef<string | null>(null)
  const [busyTurn, setBusyTurn] = useState<string | null>(null)
  const actionInFlight = useRef<symbol | null>(null)
  const actionScopeKey = useAppStore(state => composerActionScopeKey(state, sessionId))
  useEffect(() => {
    actionInFlight.current = null
    setBusyTurn(null)
    return () => { actionInFlight.current = null }
  }, [actionScopeKey])
  useEffect(() => {
    editingQueuedIdRef.current = null
    editTextRef.current = ''
    editReferencesRef.current = []
    editTeamReferencesRef.current = []
    setEditing(null)
    setEditText('')
    setEditReferences([])
    setEditTeamReferences([])
  }, [profileId, profileGeneration, sessionId])
  const actionScopeCurrent = () => remoteComposerScopeIsCurrent(profileId, profileGeneration, sessionId)
    && composerActionScopeKey(useAppStore.getState(), sessionId) === actionScopeKey
  const referenceSupported = useCallback((reference: ChatReference): boolean => {
    const target = useAppStore.getState().sessions.find(candidate => candidate.id === reference.session_id)
    return Boolean(
      localChatReferenceContractSupported(health, reference)
      && (reference.action !== 'request_reply' || requestReplySupportedForSource)
      && target
      && !target.archived
      && supportedTargetBackends.includes(target.backend)
    )
  }, [health, requestReplySupportedForSource, supportedTargetBackends])
  const beginEdit = (turn: QueuedTurn, references?: ChatReference[]) => {
    if (actionInFlight.current || !actionScopeCurrent()) return
    const text = turn.display_prompt || turn.prompt
    const nextReferences = references ?? parseStoredChatReferences(turn.chat_references, text, sessionId)
    const nextTeamReferences = validTeamReferences(text, turn.team_references ?? [])
    if (nextTeamReferences.length !== (turn.team_references?.length ?? 0)) {
      Alert.alert('Recipient unavailable', 'This queued item has a Team Network reference that Mobile cannot edit. Edit it from Mac.')
      return
    }
    editTextRef.current = text
    editingQueuedIdRef.current = turn.queued_id
    editReferencesRef.current = nextReferences
    editTeamReferencesRef.current = nextTeamReferences
    setEditTeamReferences(nextTeamReferences)
    setEditing(turn.queued_id)
    setEditText(text)
    setEditReferences(nextReferences)
  }
  const cancelEdit = () => {
    editingQueuedIdRef.current = null
    editTextRef.current = ''
    editReferencesRef.current = []
    editTeamReferencesRef.current = []
    setEditTeamReferences([])
    setEditing(null)
    setEditText('')
    setEditReferences([])
  }
  const commitEdit = async (turn: QueuedTurn) => {
    if (networkDisabled || actionInFlight.current || editingQueuedIdRef.current !== turn.queued_id || !actionScopeCurrent()) return
    const currentText = editTextRef.current
    const currentReferences = editReferencesRef.current
    const currentTeamReferences = editTeamReferencesRef.current
    const prompt = currentText.trim()
    const leadingWhitespace = currentText.length - currentText.trimStart().length
    const references = validChatReferences(currentText, currentReferences, sessionId).map(reference => ({
      ...reference,
      source_text_start: reference.source_text_start - leadingWhitespace,
      source_text_end: reference.source_text_end - leadingWhitespace,
    }))
    if (!prompt) {
      Alert.alert('Queued message is empty', 'Enter a message or cancel editing.')
      return
    }
    if (references.length !== currentReferences.length) {
      Alert.alert('Chat reference changed', 'Remove the changed reference or restore its exact @chat text.')
      return
    }
    if (!currentReferences.every(referenceSupported)) {
      Alert.alert('Chat handoff unavailable', 'This server cannot deliver one or more queued actions or target chats.')
      return
    }
    const teamReferences = validTeamReferences(currentText, currentTeamReferences, currentReferences).map(reference => ({ ...reference, source_text_start: reference.source_text_start - leadingWhitespace, source_text_end: reference.source_text_end - leadingWhitespace }))
    if (teamReferences.length !== currentTeamReferences.length || !teamReferences.every(reference => teamReferenceContractSupported(health, reference))) {
      Alert.alert('Team Network reference unavailable', 'Reconnect this server or remove the recipient reference.')
      return
    }
    await act(turn.queued_id, async () => {
      const updated = await update(sessionId, turn.queued_id, prompt, references, profileGeneration, teamReferences)
      if (updated && actionScopeCurrent()) cancelEdit()
      return updated
    }, true)
  }
  const chooseQueuedAction = (turn: QueuedTurn, reference: ChatReference, currentReferences: ChatReference[]) => {
    if (editing && editing !== turn.queued_id) {
      Alert.alert('Finish the current edit', 'Save or cancel the queued message you are editing first.')
      return
    }
    showReferenceActionPicker({
      width,
      reference,
      actions: availableChatReferenceActions(supportedChatActions, requestReplySupportedForSource),
      onSelect: action => {
        const availableReferences = editing === turn.queued_id ? editReferencesRef.current : currentReferences
        const selected = availableReferences.find(candidate => sameChatReference(candidate, reference))
        if (!selected) return
        if (availableReferences.some(candidate => !sameChatReference(candidate, selected) && candidate.session_id === selected.session_id && candidate.action === action)) {
          Alert.alert('Already selected', `${chatReferenceLabel(action)} is already selected for ${reference.display_title_snapshot}.`)
          return
        }
        const next = availableReferences.map(candidate => sameChatReference(candidate, selected) ? chatReferenceWithAction(candidate, action) : candidate)
        if (editing !== turn.queued_id) beginEdit(turn, next)
        else {
          editReferencesRef.current = next
          setEditReferences(next)
        }
      },
    })
  }
  const act = async (queuedId: string, action: () => Promise<boolean>, savingEdit = false) => {
    if (actionInFlight.current || (!savingEdit && editingQueuedIdRef.current) || pendingQueuedRunIds.has(queuedId) || networkDisabled || !actionScopeCurrent()) return false
    const token = Symbol()
    actionInFlight.current = token
    setBusyTurn(queuedId)
    try {
      const result = await action()
      return actionInFlight.current === token && actionScopeCurrent() ? result : false
    }
    catch { return false }
    finally {
      if (actionInFlight.current === token) {
        actionInFlight.current = null
        if (actionScopeCurrent()) setBusyTurn(null)
      }
    }
  }
  const queueBusy = Boolean(busyTurn) || Boolean(editing) || turns.some(value => pendingQueuedRunIds.has(value.queued_id) || skippingDeliveryIds.has(`${sessionId}:${value.queued_id}`))
  return <View style={styles.queue}>
    {turns.length ? <Text style={[styles.queueLabel, { color: colors.muted }]}>Queued {turns.length}</Text> : null}
    {runStatus ? <View testID="queued-run-status" accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.queueStatus, { backgroundColor: runStatus.tone === 'error' ? `${colors.red}14` : `${colors.yellow}14`, borderColor: runStatus.tone === 'error' ? colors.red : colors.yellow }]}>
      <AlertCircle size={14} color={runStatus.tone === 'error' ? colors.red : colors.yellow} />
      <Text style={[styles.queueStatusText, { color: colors.text }]}>{runStatus.message}</Text>
      <IconButton icon={X} size={13} onPress={() => { if (composerScopeIsCurrent(profileId, profileGeneration, sessionId)) clearRunStatus(sessionId, profileGeneration) }} label="Dismiss queue status" />
    </View> : null}
    <View style={styles.queueList}>
      {turns.map((turn, index) => {
        const busy = busyTurn === turn.queued_id || pendingQueuedRunIds.has(turn.queued_id) || skippingDeliveryIds.has(`${sessionId}:${turn.queued_id}`)
        const crossChatDelivery = isCrossChatDeliveryQueuedTurn(turn)
        const agentMessage = isAsyncQueuedChatMessage(turn)
        const sender = turn.source_title?.trim() || sourceTitles[turn.source_session_id ?? ''] || 'Unknown agent'
        const canSkip = Boolean(queuedDeliverySkipIdentity(turn, health))
        const blockedByEarlierDelivery = queuedTurnHasEarlierDeliveryBarrier(allTurns, turn.queued_id)
        const pausedLabel = turn.paused !== true
          ? null
          : turn.pause_reason === 'delivery_uncertain'
            ? 'Delivery unconfirmed — review before retrying'
            : turn.pause_reason === 'stopped'
              ? 'Paused after Stop'
              : 'Paused'
        const turnText = turn.display_prompt || turn.prompt
        const storedReferences = parseStoredChatReferences(turn.chat_references, turnText, sessionId)
        const rowReferences = editing === turn.queued_id ? editReferences : storedReferences
        const validEditReferences = editing !== turn.queued_id
          || (validChatReferences(editText, editReferences, sessionId).length === editReferences.length && editReferences.every(referenceSupported)
            && validTeamReferences(editText, editTeamReferences, editReferences).length === editTeamReferences.length
            && editTeamReferences.every(reference => teamReferenceContractSupported(health, reference)))
        return <View key={turn.queued_id} testID={`queued-row-${turn.queued_id}`} style={[styles.queueRow, { backgroundColor: agentMessage ? colors.surface : colors.queued, borderColor: agentMessage ? colors.blue : colors.yellow, borderLeftWidth: agentMessage ? 2 : StyleSheet.hairlineWidth }]}>
          {editing === turn.queued_id && !crossChatDelivery ? <TextInput
            autoFocus
            editable={!networkDisabled && !busy}
            value={editText}
            onChangeText={next => {
              const nextReferences = reconcileChatReferences(editTextRef.current, next, editReferencesRef.current)
              const nextTeamReferences = reconcileTeamReferences(editTextRef.current, next, editTeamReferencesRef.current)
              editTeamReferencesRef.current = nextTeamReferences
              setEditTeamReferences(nextTeamReferences)
              editTextRef.current = next
              editReferencesRef.current = nextReferences
              setEditReferences(nextReferences)
              setEditText(next)
            }}
            multiline
            style={[styles.queueInput, { color: colors.text }]}
          /> : <Pressable accessibilityRole={crossChatDelivery ? undefined : 'button'} accessibilityLabel={agentMessage ? `${sender}: ${turnText}` : crossChatDelivery ? 'Incoming cross-chat delivery' : 'Edit queued message'} accessibilityState={{ disabled: crossChatDelivery || networkDisabled || queueBusy }} disabled={crossChatDelivery || networkDisabled || queueBusy} style={styles.queuePrompt} onPress={() => { if (remoteComposerScopeIsCurrent(profileId, profileGeneration, sessionId)) beginEdit(turn) }}>{agentMessage ? <Text style={{ color: colors.muted, fontSize: 11, fontWeight: '700' }}>{sender}</Text> : null}<Text style={[styles.queueText, { color: colors.text }]} numberOfLines={3}>{turnText}</Text>{turn.file_ids.length ? <View style={styles.queueAttachments}>{turn.file_ids.map(fileId => <QueuedAttachment key={fileId} sessionId={sessionId} fileId={fileId} onPreview={onPreview} />)}</View> : null}{crossChatDelivery && !agentMessage ? <Text style={{ color: colors.muted, fontSize: 10 }}>Cross-chat delivery · starts automatically</Text> : !agentMessage && pausedLabel ? <Text style={{ color: colors.orange, fontSize: 10 }}>{pausedLabel}</Text> : null}</Pressable>}
          {!crossChatDelivery && rowReferences.length ? <ChatReferenceShelf
            references={rowReferences}
            referenceSupported={referenceSupported}
            onChangeAction={reference => chooseQueuedAction(turn, reference, rowReferences)}
            onRemove={reference => {
              if (editing && editing !== turn.queued_id) {
                Alert.alert('Finish the current edit', 'Save or cancel the queued message you are editing first.')
                return
              }
              const next = rowReferences.filter(candidate => candidate !== reference)
              if (editing !== turn.queued_id) beginEdit(turn, next)
              else {
                editReferencesRef.current = next
                setEditReferences(next)
              }
            }}
            warning={!rowReferences.every(referenceSupported) ? 'Change this action or target before saving.' : null}
            testID={`queued-chat-references-${turn.queued_id}`}
          /> : null}
          {crossChatDelivery ? <View style={styles.queueActions}><View style={styles.toolbarSpacer} /><Pressable testID={`queued-skip-${turn.queued_id}`} accessibilityRole="button" accessibilityLabel={`Remove queued message from ${sender}`} accessibilityHint={!canSkip ? 'Update AgentsServer to safely remove this delivery.' : undefined} accessibilityState={{ disabled: networkDisabled || queueBusy || !canSkip, busy }} disabled={networkDisabled || queueBusy || !canSkip} onPress={() => void act(turn.queued_id, () => skipDelivery(sessionId, turn.queued_id, profileGeneration))} style={({ pressed }) => [styles.routeRevoke, { opacity: networkDisabled || queueBusy || !canSkip || pressed ? 0.45 : 1 }]}>{busy ? <ActivityIndicator size="small" color={colors.red} /> : <Trash2 size={16} color={colors.red} />}</Pressable></View> : editing === turn.queued_id ? <View style={styles.queueEditActions}>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel queued message edit" disabled={Boolean(busyTurn)} onPress={cancelEdit} style={({ pressed }) => [styles.queueEditButton, { backgroundColor: colors.raised, opacity: busyTurn || pressed ? 0.5 : 1 }]}><Text style={[styles.queueEditButtonText, { color: colors.text }]}>Cancel</Text></Pressable>
            <Pressable testID={`queued-save-${turn.queued_id}`} accessibilityRole="button" accessibilityLabel="Save queued message" accessibilityState={{ disabled: networkDisabled || busy || !editText.trim() || !validEditReferences, busy }} disabled={networkDisabled || busy || !editText.trim() || !validEditReferences} onPress={() => void commitEdit(turn)} style={({ pressed }) => [styles.queueEditButton, { backgroundColor: colors.blue, opacity: networkDisabled || busy || !editText.trim() || !validEditReferences || pressed ? 0.45 : 1 }]}>{busy ? <ActivityIndicator size="small" color={colors.textOnAccent} /> : <><Check size={14} color={colors.textOnAccent} /><Text style={[styles.queueEditButtonText, { color: colors.textOnAccent }]}>Save</Text></>}</Pressable>
          </View> : <View style={styles.queueActions}>
            <Pressable testID={`queued-send-now-${turn.queued_id}`} accessibilityRole="button" accessibilityLabel="Run queued message now" accessibilityHint={blockedByEarlierDelivery ? 'Wait for the earlier delivery barrier to finish.' : undefined} accessibilityState={{ disabled: networkDisabled || queueBusy || blockedByEarlierDelivery, busy }} disabled={networkDisabled || queueBusy || blockedByEarlierDelivery} onPress={() => void act(turn.queued_id, () => runNow(sessionId, turn.queued_id, profileGeneration)).then(sent => { if (sent && remoteComposerScopeIsCurrent(profileId, profileGeneration, sessionId)) onSent() })} style={({ pressed }) => [styles.runNow, { opacity: networkDisabled || blockedByEarlierDelivery || pressed || queueBusy && !busy ? 0.45 : 1 }]}>
              {busy ? <ActivityIndicator size="small" color={colors.yellow} /> : <CornerDownRight size={14} color={colors.yellow} />}
              <Text style={{ color: colors.yellow, fontSize: 11, fontWeight: '800' }}>Run now</Text>
            </Pressable>
            <View style={styles.toolbarSpacer} />
            <IconButton icon={ArrowUp} size={13} disabled={networkDisabled || index === 0 || queueBusy || queuedMoveCrossesDeliveryBarrier(allTurns, turn.queued_id, 'up')} onPress={() => void act(turn.queued_id, () => move(sessionId, turn.queued_id, 'up', profileGeneration))} label="Move up" />
            <IconButton icon={ArrowDown} size={13} disabled={networkDisabled || index === turns.length - 1 || queueBusy || queuedMoveCrossesDeliveryBarrier(allTurns, turn.queued_id, 'down')} onPress={() => void act(turn.queued_id, () => move(sessionId, turn.queued_id, 'down', profileGeneration))} label="Move down" />
            <IconButton icon={Trash2} size={13} disabled={networkDisabled || queueBusy} onPress={() => void act(turn.queued_id, () => remove(sessionId, turn.queued_id, profileGeneration))} label="Remove from queue" />
          </View>}
        </View>
      })}
    </View>
  </View>
}

function composerScopeIsCurrent(profileId: string | null, profileGeneration: number, sessionId: string): boolean {
  const state = useAppStore.getState()
  return state.activeProfileId === profileId
    && state.profileGeneration === profileGeneration
    && state.selectedSessionId === sessionId
    && !state.switchingProfileId
    && !state.workspaceAdopting
}

function composerActionScopeKey(state: ReturnType<typeof useAppStore.getState>, sessionId: string): string {
  return JSON.stringify([
    state.activeProfileId, state.profileGeneration, sessionId, state.selectedSessionId,
    client.validationRevision, client.isValidated,
    state.health?.server_identity, state.health?.server_instance_id,
    state.connected, state.connecting, state.switchingProfileId, state.workspaceAdopting,
  ])
}

function remoteComposerScopeIsCurrent(profileId: string | null, profileGeneration: number, sessionId: string): boolean {
  const state = useAppStore.getState()
  return composerScopeIsCurrent(profileId, profileGeneration, sessionId) && client.isValidated && state.connected && !state.connecting
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function pickerError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The attachment picker could not be opened.'
}

const styles = StyleSheet.create({
  routeNotice: { paddingHorizontal: 16, paddingVertical: 8, gap: 8, flexDirection: 'row', alignItems: 'center' },
  routeRow: { flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden' },
  routeTarget: { flex: 1, minWidth: 0, borderWidth: 0 },
  routeRevoke: { minWidth: 64, minHeight: 44, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  shell: { padding: COMPOSER_SHELL_PADDING, gap: 7 },
  auxiliaryScroll: { flexGrow: 0 }, auxiliaryContent: { gap: 7 },
  editingBanner: { minHeight: 44, borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, paddingLeft: 11, paddingRight: 4, flexDirection: 'row', alignItems: 'center', gap: 8 },
  editingBannerText: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 16 }, editingBannerCancel: { minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' },
  referenceShelfWrap: { minWidth: 0, gap: 3 },
  referenceRail: { flexGrow: 0, minHeight: 44, maxHeight: 44 },
  referenceShelf: { flexDirection: 'row', gap: 6, paddingRight: 2 },
  referenceChip: { minWidth: 0, maxWidth: 310, height: 44, flexShrink: 0, borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, paddingLeft: 9, flexDirection: 'row', alignItems: 'center', gap: 5 },
  referenceAction: { minWidth: 0, maxWidth: 230, height: 44, flexDirection: 'row', alignItems: 'center', gap: 3 },
  referenceTitle: { minWidth: 34, maxWidth: 118, flexShrink: 1, fontSize: 11.5, fontWeight: '800' },
  referenceLabel: { minWidth: 0, maxWidth: 114, flexShrink: 1, fontSize: 10.5, fontWeight: '700' },
  referenceWarning: { minHeight: 24, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 4 },
  referenceWarningText: { minWidth: 0, flex: 1, fontSize: 10.5, lineHeight: 14, fontWeight: '600' },
  composer: { maxHeight: COMPOSER_CARD_MAX_HEIGHT, minHeight: COMPOSER_EMPTY_CARD_MIN_HEIGHT, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  input: { minHeight: COMPOSER_INPUT_MIN_HEIGHT, maxHeight: COMPOSER_INPUT_MAX_HEIGHT, paddingHorizontal: 14, paddingTop: 10, fontSize: 15.5, lineHeight: 21 },
  toolbar: { minHeight: 48, flexShrink: 0, paddingHorizontal: 7, flexDirection: 'row', alignItems: 'center', gap: 4 },
  toolbarCompact: { minHeight: COMPOSER_COMPACT_TOOLBAR_HEIGHT, paddingHorizontal: COMPOSER_COMPACT_TOOLBAR_PADDING, gap: COMPOSER_COMPACT_TOOLBAR_GAP },
  toolbarDense: { paddingHorizontal: COMPOSER_DENSE_TOOLBAR_PADDING, gap: COMPOSER_DENSE_TOOLBAR_GAP },
  quickMessagesMenu: { width: COMPOSER_TOOLBAR_TOUCH_SIZE, height: COMPOSER_TOOLBAR_TOUCH_SIZE, flexShrink: 0 }, quickMessages: { width: COMPOSER_TOOLBAR_TOUCH_SIZE, height: COMPOSER_TOOLBAR_TOUCH_SIZE, flexShrink: 0, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  runtimeMenu: { minWidth: 0, flexShrink: 1 }, runtimeMenuCompact: { width: COMPOSER_COMPACT_BACKEND_SLOT_WIDTH, height: COMPOSER_TOOLBAR_TOUCH_SIZE, flexShrink: 0 }, runtimeMenuDense: { width: COMPOSER_TOOLBAR_TOUCH_SIZE, height: COMPOSER_TOOLBAR_TOUCH_SIZE, alignItems: 'center', justifyContent: 'center' }, runtime: { minWidth: 0, flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }, runtimeCompact: { width: COMPOSER_COMPACT_BACKEND_SLOT_WIDTH, height: COMPOSER_TOOLBAR_TOUCH_SIZE, flexShrink: 0, flexDirection: 'column', justifyContent: 'center', gap: 0 }, runtimeDense: { width: COMPOSER_DENSE_BACKEND_SLOT_WIDTH }, backend: { fontSize: 12, fontWeight: '700' }, runtimeChip: { minWidth: 0, flexShrink: 1, height: COMPOSER_TOOLBAR_TOUCH_SIZE, justifyContent: 'center' }, runtimeChipFace: { minHeight: 28, minWidth: 0, borderRadius: 6, paddingLeft: 8, paddingRight: 6, flexDirection: 'row', alignItems: 'center', gap: 3 }, toolbarSpacer: { flex: 1, minWidth: 0 },
  stop: { width: COMPOSER_TOOLBAR_TOUCH_SIZE, height: COMPOSER_TOOLBAR_TOUCH_SIZE, flexShrink: 0, borderRadius: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 }, stopWide: { width: 76 }, compactStopFace: { width: COMPOSER_STOP_FACE_SIZE, height: COMPOSER_STOP_FACE_SIZE, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }, stopLabel: { fontSize: 11, fontWeight: '800' }, send: { width: COMPOSER_TOOLBAR_TOUCH_SIZE, height: COMPOSER_TOOLBAR_TOUCH_SIZE, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }, sendFace: { width: COMPOSER_SEND_FACE_SIZE, height: COMPOSER_SEND_FACE_SIZE, borderRadius: COMPOSER_SEND_FACE_SIZE / 2, alignItems: 'center', justifyContent: 'center' }, steer: { minHeight: COMPOSER_TOOLBAR_TOUCH_SIZE, flexShrink: 0, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3 }, steerCompact: { width: COMPOSER_TOOLBAR_TOUCH_SIZE, paddingHorizontal: 0 },
  uploadRail: { flexGrow: 0, minHeight: 64, maxHeight: 64 }, uploads: { flexDirection: 'row', gap: 7, paddingRight: 2 }, upload: { width: 216, height: 64, flexShrink: 0, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingLeft: 7, flexDirection: 'row', alignItems: 'center' }, uploadIdentity: { minWidth: 0, flex: 1, height: 62, flexDirection: 'row', alignItems: 'center', gap: 8 }, fileIconWell: { width: 48, height: 48, minWidth: 48, flexShrink: 0, borderRadius: 6, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }, uploadText: { minWidth: 0, flex: 1, gap: 2 }, uploadName: { fontSize: 12, fontWeight: '700' }, uploadMeta: { fontSize: 10.5 }, uploadActionSpacer: { width: 44, height: 44, flexShrink: 0 }, uploadBusy: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: '#00000066' }, uploadError: { position: 'absolute', right: 3, bottom: 3, width: 19, height: 19, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  previewModal: { flex: 1 }, previewHeader: { minHeight: FULLSCREEN_HEADER_MIN_HEIGHT, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: FULLSCREEN_HEADER_GUTTER, flexDirection: 'row', alignItems: 'center', gap: 8 }, previewTitle: { minWidth: 0, flex: 1, fontSize: 14, fontWeight: '700' }, previewImage: { flex: 1, margin: 12 },
  targetPickerSafe: { flex: 1 },
  targetPickerGrabber: { width: 38, height: 5, marginTop: 8, marginBottom: 3, borderRadius: 3, alignSelf: 'center' },
  targetPickerPanel: { flex: 1, width: '100%', alignSelf: 'center' }, targetPickerPanelTablet: { maxWidth: 760 },
  targetPickerHeader: { minHeight: 70, paddingLeft: 16, paddingRight: 10, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 10 },
  targetPickerHeading: { minWidth: 0, flex: 1, gap: 3 }, targetPickerTitle: { fontSize: 18, fontWeight: '800' }, targetPickerSubtitle: { fontSize: 12.5 },
  targetSearch: { height: 46, marginHorizontal: 12, marginTop: 12, marginBottom: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  targetSearchInput: { minWidth: 0, flex: 1, height: 44, paddingVertical: 0, fontSize: 15 },
  targetLimitWarning: { minHeight: 40, marginHorizontal: 12, marginBottom: 8, paddingVertical: 6 },
  targetList: { paddingHorizontal: 12, paddingBottom: 20, gap: 7 }, targetListEmpty: { flexGrow: 1 },
  targetRow: { minHeight: 66, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 9 }, targetRowTablet: { minHeight: 74, paddingHorizontal: 14 },
  targetBackend: { width: 40, height: 40, flexShrink: 0, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  targetIdentity: { minWidth: 0, flex: 1, gap: 3 }, targetTitle: { fontSize: 14, fontWeight: '700' }, targetMeta: { fontSize: 10.5 },
  targetStatus: { minHeight: 25, maxWidth: 104, borderRadius: 7, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' }, targetStatusText: { fontSize: 10.5, fontWeight: '700' },
  targetEmpty: { flex: 1, minHeight: 200, alignItems: 'center', justifyContent: 'center', gap: 7, padding: 24 }, targetEmptyTitle: { fontSize: 17, fontWeight: '700' }, targetEmptyBody: { maxWidth: 300, fontSize: 12.5, lineHeight: 18, textAlign: 'center' },
  queue: { gap: 5 }, queueLabel: { fontSize: 10, fontWeight: '800', textAlign: 'right' },
  queueStatus: { minHeight: 42, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingLeft: 10, flexDirection: 'row', alignItems: 'center', gap: 7 }, queueStatusText: { minWidth: 0, flex: 1, paddingVertical: 8, fontSize: 11.5, lineHeight: 16 },
  queueList: { gap: 5 },
  queueRow: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: 10, paddingTop: 6, gap: 4 }, queuePrompt: { width: '100%', minWidth: 60, minHeight: 44, justifyContent: 'center', paddingVertical: 6 }, queueAttachments: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 }, queueThumb: { width: 44, height: 44, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth }, queueFile: { maxWidth: 180, minHeight: 24, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', gap: 4 }, queueText: { fontSize: 12.5, lineHeight: 17 }, queueInput: { width: '100%', minHeight: 52, fontSize: 12.5, lineHeight: 17, paddingVertical: 6 }, queueActions: { minHeight: 44, width: '100%', flexDirection: 'row', alignItems: 'center' }, runNow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 7 },
  queueEditActions: { minHeight: 50, width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
  queueEditButton: { minWidth: 82, height: 44, borderRadius: 8, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 }, queueEditButtonText: { fontSize: 12, fontWeight: '800' },
})
