import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Check, ChevronDown, ChevronRight, CircleAlert, FolderOpen, Import, KeyRound, Search, Square, SquareCheck } from 'lucide-react-native'
import type { AgentServerClient } from '../api/AgentServerClient'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { backendLabel, errorMessage, formatChatDateTime } from '../lib/format'
import { fuzzyScore } from '../lib/fuzzy'
import { cursorLocalSessionImportSupported, localSessionImportBatchLimit, localSessionImportCapability, localSessionImportKey, localSessionImportListLimit } from '../lib/local-session-import'
import { runtimeSelectionError, selectableChatBackends } from '../lib/runtime-catalog'
import { isWelcomeSession } from '../lib/welcome-session'
import { capturedConnectionIsCurrent, client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { Backend, BulkImportSessionItem, BulkImportSessionResult, LocalSessionCandidate, Session } from '../types'
import { Text, TextInput } from './AppText'
import { BackendMark } from './BackendMark'
import { SheetCloseButton } from './ui'

interface ResumeChatDialogProps {
  visible: boolean
  onClose: () => void
  /** Called after the resumed chat is selected, so a phone can bring it forward. */
  onOpened: () => void
}

interface ResumeByIdMatch {
  key: string
  kind: 'existing' | 'candidate'
  backend: Backend
  providerId: string
  label: string
  cwd: string | null
  sessionId?: string
}

/** Port of ImportChatsDialog in electron/src/renderer/src/components/Dialogs.tsx: resume one provider session by ID, or import several from the server's CLI history. */
export function ResumeChatDialog(props: ResumeChatDialogProps) {
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const connection = client
  const connectionKey = `${activeProfileId ?? 'none'}:${profileGeneration}`
  const connectionReady = connected && !connecting && !switchingProfileId && connection.isValidated
  return <ScopedResumeChatDialog
    key={connectionKey}
    {...props}
    connection={connection}
    activeProfileId={activeProfileId}
    profileGeneration={profileGeneration}
    connectionReady={connectionReady}
  />
}

function ScopedResumeChatDialog({ visible, onClose, onOpened, connection, activeProfileId, profileGeneration, connectionReady }: ResumeChatDialogProps & {
  connection: AgentServerClient
  activeProfileId: string | null
  profileGeneration: number
  connectionReady: boolean
}) {
  const colors = usePalette()
  const health = useAppStore(state => state.health)
  const sessions = useAppStore(state => state.sessions)
  const capability = localSessionImportCapability(health)
  const listLimit = capability ? localSessionImportListLimit(capability) : null
  const includeCursor = cursorLocalSessionImportSupported(health)
  const backends = selectableChatBackends(health)
  // Every open, close and operation takes a new epoch; a response applies only while its epoch and connection are current.
  const requestEpoch = useRef(0)
  // load-bearing: a second tap can arrive before `busy` re-renders; this ref refuses it synchronously.
  const activeOperationEpoch = useRef<number | null>(null)
  const [candidates, setCandidates] = useState<LocalSessionCandidate[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [results, setResults] = useState<BulkImportSessionResult[]>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [resumeId, setResumeId] = useState('')
  const [resumeBackend, setResumeBackend] = useState<Backend>('codex')
  const [resumeCwd, setResumeCwd] = useState('')
  // Desktop's resumeNeedsChoice / resumeNeedsDetails, as one value so both panels cannot show at once.
  const [resumeNeeds, setResumeNeeds] = useState<'choice' | 'details' | null>(null)
  // Chats the server reports as owning the typed ID; chat-list rows are summaries without provider IDs.
  const [owners, setOwners] = useState<Session[]>([])
  const [resumeError, setResumeError] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)
  const busy = importing || resuming
  const connectionIsCurrent = () => capturedConnectionIsCurrent(connection, activeProfileId, profileGeneration)
  const isCurrent = (epoch: number) => epoch === requestEpoch.current && connectionIsCurrent()

  useEffect(() => {
    const epoch = ++requestEpoch.current
    activeOperationEpoch.current = null
    setCandidates([])
    setSelected(new Set())
    setLoading(false)
    setImporting(false)
    setLoadError(null)
    setResults([])
    setCollapsed(new Set())
    setQuery('')
    setResumeId('')
    setResumeNeeds(null)
    setOwners([])
    setResumeError(null)
    setResuming(false)
    if (!visible || !connectionReady) return
    const state = useAppStore.getState()
    const seed = state.sessions.find(session => session.id === state.selectedSessionId && !session.archived && !isWelcomeSession(session.id))
    const available = selectableChatBackends(state.health)
    setResumeBackend(seed && available.includes(seed.backend) ? seed.backend : available.includes('codex') ? 'codex' : available[0] ?? 'codex')
    setResumeCwd(seed?.cwd?.trim() || state.health?.default_cwd?.trim() || '')
    if (listLimit == null) {
      setLoadError('Browsing server history needs AgentsServer API 15 with local session import. Resume by session ID still works.')
      return
    }
    setLoading(true)
    connection.listLocalSessions(listLimit, includeCursor)
      .then(list => { if (isCurrent(epoch)) setCandidates(list) })
      .catch((error: unknown) => { if (isCurrent(epoch)) setLoadError(errorMessage(error)) })
      .finally(() => { if (isCurrent(epoch)) setLoading(false) })
  }, [connection, connectionReady, includeCursor, listLimit, visible])

  const resumeMatches = useMemo<ResumeByIdMatch[]>(() => {
    const providerId = resumeId.trim()
    if (!providerId) return []
    const exactSession = sessions.find(session => session.id === providerId)
    if (exactSession) return [existingMatch(exactSession, providerId)]
    const owned = new Map(sessions.filter(session => sessionProviderIds(session).includes(providerId)).map(session => [session.id, session]))
    for (const owner of owners) owned.set(owner.id, owner)
    const matches = [...owned.values()].map(session => existingMatch(session, providerId))
    const existingKeys = new Set(matches.map(match => localSessionImportKey(match.backend, match.providerId)))
    for (const candidate of candidates) {
      const key = localSessionImportKey(candidate.backend, candidate.provider_session_id)
      if (candidate.provider_session_id !== providerId || existingKeys.has(key)) continue
      matches.push({ key: `candidate:${key}`, kind: 'candidate', backend: candidate.backend, providerId, label: candidate.label, cwd: candidate.cwd })
    }
    return matches
  }, [candidates, owners, resumeId, sessions])

  const searching = query.trim().length > 0
  // One haystack per row (label, folder, provider) so a query can span fields;
  // the "\n" separators never match because fuzzyScore drops whitespace from
  // the query. Sorting is stable, so equal scores keep the server's order.
  const { visibleCandidates, highlights } = useMemo(() => {
    if (!searching) return { visibleCandidates: candidates, highlights: new Map<string, Set<number>>() }
    const matches: { candidate: LocalSessionCandidate; score: number; hits: Set<number> }[] = []
    for (const candidate of candidates) {
      const match = fuzzyScore(query, `${candidate.label}\n${candidate.cwd ?? ''}\n${backendLabel(candidate.backend)}`)
      if (!match) continue
      const labelLength = Array.from(candidate.label).length
      matches.push({ candidate, score: match.score, hits: new Set(match.indices.filter(index => index < labelLength)) })
    }
    matches.sort((a, b) => b.score - a.score)
    return {
      visibleCandidates: matches.map(match => match.candidate),
      highlights: new Map(matches.map(match => [localSessionImportKey(match.candidate.backend, match.candidate.provider_session_id), match.hits])),
    }
  }, [candidates, query, searching])

  // CLI transcripts have no AgentsDock folder; group them by the working
  // directory they ran in, keeping the newest project first.
  const groups = useMemo(() => {
    const byCwd = new Map<string, { cwd: string | null; items: LocalSessionCandidate[] }>()
    for (const candidate of visibleCandidates) {
      const key = candidate.cwd ?? '\0'
      const existing = byCwd.get(key)
      if (existing) existing.items.push(candidate)
      else byCwd.set(key, { cwd: candidate.cwd, items: [candidate] })
    }
    return [...byCwd.values()]
  }, [visibleCandidates])
  const showGroupHeaders = groups.some(group => group.cwd)
  const folderCount = groups.filter(group => group.cwd).length

  // Folders start collapsed so the folder structure is what users see first;
  // a search opens them to show its matches.
  useEffect(() => {
    if (!candidates.some(candidate => candidate.cwd)) return
    setCollapsed(searching ? new Set() : new Set(candidates.map(candidate => candidate.cwd ?? '__none__')))
  }, [candidates, searching])

  const close = () => {
    onClose()
    requestAnimationFrame(dismissAppKeyboard)
  }

  const openChat = (sessionId: string) => {
    close()
    // selectSession publishes the selection synchronously; bring the chat
    // forward on a phone without waiting for its timeline sync.
    void useAppStore.getState().selectSession(sessionId, profileGeneration)
    if (connectionIsCurrent() && useAppStore.getState().selectedSessionId === sessionId) onOpened()
  }

  // The chat now exists on the server: list it even if the sheet was closed
  // meanwhile, and open it only if the sheet is still waiting for it.
  const openResumed = async (sessionId: string, epoch: number) => {
    if (!connectionIsCurrent()) return
    await useAppStore.getState().refreshSessions(profileGeneration)
    // A refresh already in flight answers this call and may predate the new chat.
    if (!useAppStore.getState().sessions.some(session => session.id === sessionId)) await useAppStore.getState().refreshSessions(profileGeneration)
    if (isCurrent(epoch)) openChat(sessionId)
  }

  const importSelected = async () => {
    if (!capability || listLimit == null || activeOperationEpoch.current !== null) return
    const items: BulkImportSessionItem[] = candidates
      .filter(candidate => selected.has(localSessionImportKey(candidate.backend, candidate.provider_session_id)))
      .map(candidate => ({ provider_session_id: candidate.provider_session_id, backend: candidate.backend, cwd: candidate.cwd }))
    if (!items.length) return
    const epoch = ++requestEpoch.current
    activeOperationEpoch.current = epoch
    setImporting(true)
    try {
      const batchLimit = localSessionImportBatchLimit(capability)
      const outcome: BulkImportSessionResult[] = []
      const failed = (item: BulkImportSessionItem, error: string): BulkImportSessionResult => ({
        provider_session_id: item.provider_session_id, backend: item.backend, session_id: null, ok: false, imported: 0, error,
      })
      // Closing the sheet hides the outcome but does not abandon the import:
      // as on desktop, every batch is sent and the chat list is refreshed.
      for (let offset = 0; offset < items.length && connectionIsCurrent(); offset += batchLimit) {
        const batch = items.slice(offset, offset + batchLimit)
        try {
          outcome.push(...await connection.bulkImportSessions(batch))
        } catch (error) {
          // The server may have imported part of this batch before the request
          // failed. The re-scan below drops those rows, and bulk import refuses
          // a provider session that a chat already owns.
          const detail = errorMessage(error)
          outcome.push(...batch.map(item => failed(item, `The import request failed: ${detail}`)))
          outcome.push(...items.slice(offset + batch.length).map(item => failed(item, 'Not attempted because an earlier batch failed.')))
          break
        }
      }
      if (outcome.some(result => result.ok) && connectionIsCurrent()) await useAppStore.getState().refreshSessions(profileGeneration)
      if (!isCurrent(epoch)) return
      if (outcome.every(result => result.ok)) {
        close()
        return
      }
      setResults(outcome)
      setSelected(new Set())
      const importedKeys = new Set(outcome.filter(result => result.ok).map(result => localSessionImportKey(result.backend, result.provider_session_id)))
      try {
        const refreshed = await connection.listLocalSessions(listLimit, includeCursor)
        if (isCurrent(epoch)) setCandidates(refreshed)
      } catch {
        if (isCurrent(epoch)) setCandidates(previous => previous.filter(candidate => !importedKeys.has(localSessionImportKey(candidate.backend, candidate.provider_session_id))))
      }
    } finally {
      if (activeOperationEpoch.current === epoch) activeOperationEpoch.current = null
      if (isCurrent(epoch)) setImporting(false)
    }
  }

  const resumeMatch = async (match: ResumeByIdMatch) => {
    if (activeOperationEpoch.current !== null) return
    if (match.kind === 'existing' && match.sessionId) {
      if (useAppStore.getState().selectedSessionId === match.sessionId) {
        // Opening the chat that is already open changes nothing on screen; say so.
        setResumeError(`This session already belongs to the chat that is open now, “${match.label}”.`)
        return
      }
      openChat(match.sessionId)
      return
    }
    const epoch = ++requestEpoch.current
    activeOperationEpoch.current = epoch
    setResumeError(null)
    setResuming(true)
    try {
      const [result] = await connection.bulkImportSessions([{ provider_session_id: match.providerId, backend: match.backend, cwd: match.cwd }])
      if (!result?.ok || !result.session_id) throw new Error(result?.error || 'The selected provider session could not be resumed.')
      await openResumed(result.session_id, epoch)
    } catch (error) {
      if (isCurrent(epoch)) setResumeError(errorMessage(error))
    } finally {
      if (activeOperationEpoch.current === epoch) activeOperationEpoch.current = null
      if (isCurrent(epoch)) setResuming(false)
    }
  }

  // The first submit of an unknown ID reveals the agent and directory fields; the second creates the chat.
  const submitResumeById = async () => {
    const providerId = resumeId.trim()
    // The keyboard's Go key bypasses the disabled Resume button, so refuse here too.
    if (!providerId || loading || activeOperationEpoch.current !== null) return
    dismissAppKeyboard()
    setResumeError(null)
    if (resumeMatches.length === 1) return resumeMatch(resumeMatches[0])
    if (resumeMatches.length > 1) { setResumeNeeds('choice'); return }
    const state = useAppStore.getState()
    const creating = resumeNeeds === 'details'
    if (creating) {
      const runtimeError = runtimeSelectionError(state.health, state.runtime, resumeBackend, null)
      if (runtimeError) { setResumeError(runtimeError); return }
    }
    const epoch = ++requestEpoch.current
    activeOperationEpoch.current = epoch
    setResuming(true)
    try {
      // POST /api/sessions accepts a provider session that another chat already
      // owns (bulk import refuses it), so look for an owner in the full rows first.
      const found = (await connection.sessionsWithProviderIds()).filter(session => sessionProviderIds(session).includes(providerId))
      if (!isCurrent(epoch)) return
      if (found.length === 1) { await openResumed(found[0].id, epoch); return }
      if (found.length > 1) { setOwners(found); setResumeNeeds('choice'); return }
      if (!creating) { setResumeNeeds('details'); return }
      const seed = state.sessions.find(session => session.id === state.selectedSessionId && !session.archived && !isWelcomeSession(session.id))
      const session = await connection.createSession({
        title: `Resumed ${backendLabel(resumeBackend)} ${providerId.slice(0, 8)}`,
        folder: seed?.folder?.trim() || 'General',
        cwd: resumeCwd.trim() || state.health?.default_cwd?.trim() || '',
        backend: resumeBackend,
        model: null,
        effort: null,
        system_prompt: null,
        providerId,
      })
      await openResumed(session.id, epoch)
    } catch (error) {
      if (isCurrent(epoch)) setResumeError(errorMessage(error))
    } finally {
      if (activeOperationEpoch.current === epoch) activeOperationEpoch.current = null
      if (isCurrent(epoch)) setResuming(false)
    }
  }

  const toggle = (key: string) => {
    if (busy) return
    setSelected(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const textButton = (label: string, onPress: () => void, testID?: string) => <Pressable
    testID={testID}
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled: busy }}
    disabled={busy}
    onPress={onPress}
    style={({ pressed }) => [styles.textButton, { opacity: busy ? 0.35 : pressed ? 0.6 : 1 }]}
  ><Text style={[styles.textButtonText, { color: colors.blue }]}>{label}</Text></Pressable>

  const resumeDisabled = !resumeId.trim() || busy || loading
  const importDisabled = busy || selected.size === 0
  const description = includeCursor
    ? 'Continue Claude Code, Codex or Cursor CLI chats from this server. Cursor imports a text snapshot.'
    : 'Continue Claude Code or Codex CLI chats from this server.'

  return <Modal visible={visible} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} allowSwipeDismissal onRequestClose={close}>
    <SafeAreaView testID="resume-chat-dialog" accessibilityViewIsModal onAccessibilityEscape={close} style={[styles.sheet, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={styles.headerCopy}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Resume chat</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>{description}</Text>
        </View>
        <SheetCloseButton label="Close Resume chat" testID="resume-chat-close" onPress={close} />
      </View>
      {!connectionReady ? <Text style={[styles.status, { color: colors.muted, padding: 14 }]}>This server must finish connecting and verifying its identity first.</Text> : <>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.heading}>
              <KeyRound size={15} color={colors.muted} />
              <View style={styles.headingCopy}>
                <Text style={[styles.headingTitle, { color: colors.text }]}>Resume by session ID</Text>
                <Text style={[styles.small, { color: colors.muted }]}>Detected chats reuse their original agent and working directory.</Text>
              </View>
            </View>
            <View style={styles.idRow}>
              <TextInput
                testID="resume-chat-id"
                accessibilityLabel="Session ID"
                value={resumeId}
                editable={!busy}
                onChangeText={value => { setResumeId(value); setResumeNeeds(null); setOwners([]); setResumeError(null) }}
                placeholder="Paste a session ID"
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="go"
                onSubmitEditing={() => void submitResumeById()}
                maxLength={256}
                style={[styles.input, styles.idInput, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]}
              />
              <Pressable
                testID="resume-chat-submit"
                accessibilityRole="button"
                accessibilityLabel="Resume"
                accessibilityState={{ disabled: resumeDisabled, busy: resuming }}
                disabled={resumeDisabled}
                onPress={() => void submitResumeById()}
                style={({ pressed }) => [styles.primary, { backgroundColor: colors.blue, opacity: resumeDisabled ? 0.35 : pressed ? 0.65 : 1 }]}
              >{resuming ? <ActivityIndicator size="small" color={colors.textOnAccent} /> : null}<Text style={[styles.primaryText, { color: colors.textOnAccent }]}>{resuming ? 'Resuming…' : 'Resume'}</Text></Pressable>
            </View>
            {resumeNeeds === 'choice' && resumeMatches.length > 1 ? <View style={styles.matches} accessibilityLabel="Matching sessions">
              <Text style={[styles.small, { color: colors.muted }]}>Choose the matching agent:</Text>
              {resumeMatches.map(match => <Pressable
                key={match.key}
                testID="resume-chat-match"
                accessibilityRole="button"
                accessibilityLabel={`${backendLabel(match.backend)} · ${match.label}`}
                disabled={busy}
                onPress={() => void resumeMatch(match)}
                style={({ pressed }) => [styles.match, { borderColor: colors.border, backgroundColor: colors.raised, opacity: busy ? 0.35 : pressed ? 0.65 : 1 }]}
              >
                <BackendMark backend={match.backend} size={14} />
                <View style={styles.headingCopy}>
                  <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>{backendLabel(match.backend)} · {match.label}</Text>
                  <Text style={[styles.small, { color: colors.muted }]} numberOfLines={1}>{match.kind === 'existing' ? 'Already in AgentsDock' : match.cwd || 'Default working directory'}</Text>
                </View>
                <ChevronRight size={14} color={colors.muted} />
              </Pressable>)}
            </View> : null}
            {resumeNeeds === 'details' && resumeMatches.length === 0 ? <View style={styles.details}>
              <Text style={[styles.small, { color: colors.muted }]}>This ID was not found in server history. Confirm its agent and working directory.</Text>
              <Text style={[styles.label, { color: colors.muted }]}>Agent</Text>
              <View style={styles.segmented}>{backends.map(backend => <Pressable
                key={backend}
                testID={`resume-chat-backend-${backend}`}
                accessibilityRole="button"
                accessibilityLabel={backendLabel(backend)}
                accessibilityState={{ selected: resumeBackend === backend, disabled: busy }}
                disabled={busy}
                onPress={() => setResumeBackend(backend)}
                style={({ pressed }) => [styles.segment, { backgroundColor: resumeBackend === backend ? colors.blue : colors.raised, opacity: pressed ? 0.65 : 1 }]}
              ><BackendMark backend={backend} size={14} /><Text style={[styles.segmentText, { color: resumeBackend === backend ? colors.textOnAccent : colors.text }]}>{backendLabel(backend)}</Text></Pressable>)}</View>
              <Text style={[styles.label, { color: colors.muted }]}>Working directory</Text>
              <TextInput
                testID="resume-chat-cwd"
                accessibilityLabel="Working directory"
                value={resumeCwd}
                editable={!busy}
                onChangeText={setResumeCwd}
                placeholder={health?.default_cwd || '/path/to/project'}
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.input, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]}
              />
            </View> : null}
            {resumeError ? <Text accessibilityRole="alert" style={[styles.small, { color: colors.red }]}>{resumeError}</Text> : null}
          </View>

          <View style={styles.heading}>
            <Import size={15} color={colors.muted} />
            <Text style={[styles.headingTitle, { color: colors.text }]}>Server history</Text>
          </View>
          {!loadError ? <View style={[styles.searchBox, { backgroundColor: colors.raised, borderColor: colors.border }]}>
            <Search size={14} color={colors.muted} />
            <TextInput testID="resume-chat-search" accessibilityLabel="Search server history" value={query} onChangeText={setQuery} placeholder="Search server history" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} maxLength={256} style={[styles.searchInput, { color: colors.text }]} />
          </View> : null}
          {loading ? <View style={styles.statusRow}><ActivityIndicator size="small" color={colors.blue} /><Text style={[styles.status, { color: colors.muted }]}>Scanning chat history…</Text></View> : null}
          {!loading && loadError ? <Text accessibilityRole="alert" style={[styles.status, { color: colors.muted }]}>{loadError}</Text> : null}
          {!loading && !loadError && candidates.length === 0 ? <Text style={[styles.status, { color: colors.muted }]}>No un-imported chats found.</Text> : null}
          {!loading && !loadError && listLimit != null && candidates.length >= listLimit ? <Text style={[styles.status, { color: colors.muted }]}>Showing the {candidates.length} most recent chats; search covers only these.</Text> : null}
          {!loading && !loadError && candidates.length > 0 && visibleCandidates.length === 0 ? <Text style={[styles.status, { color: colors.muted }]}>No chats match your search.</Text> : null}
          {!loading && !loadError && visibleCandidates.length > 0 ? <>
            <View style={styles.toolbar}>
              <Text style={[styles.small, styles.toolbarCount, { color: colors.muted }]}>{showGroupHeaders
                ? `${visibleCandidates.length} ${visibleCandidates.length === 1 ? 'chat' : 'chats'} in ${folderCount} ${folderCount === 1 ? 'folder' : 'folders'} · ${selected.size} selected`
                : `${selected.size} of ${visibleCandidates.length} selected`}</Text>
              {showGroupHeaders && groups.length > 1 ? textButton(collapsed.size ? 'Expand all' : 'Collapse all', () => setCollapsed(previous => previous.size ? new Set() : new Set(groups.map(group => group.cwd ?? '__none__')))) : null}
              {textButton('Select all', () => setSelected(new Set(visibleCandidates.map(candidate => localSessionImportKey(candidate.backend, candidate.provider_session_id)))), 'resume-chat-select-all')}
              {textButton('Select none', () => setSelected(new Set()))}
            </View>
            {groups.map(group => {
              const groupKey = group.cwd ?? '__none__'
              const isCollapsed = collapsed.has(groupKey)
              const groupKeys = group.items.map(candidate => localSessionImportKey(candidate.backend, candidate.provider_session_id))
              const groupSelected = groupKeys.filter(key => selected.has(key)).length
              const allSelected = groupSelected === groupKeys.length
              return <View key={groupKey} style={[styles.group, { borderColor: colors.border }]}>
                {showGroupHeaders ? <View style={styles.groupHeader}>
                  <Pressable
                    testID="resume-chat-folder"
                    accessibilityRole="button"
                    accessibilityLabel={`${group.cwd ?? 'Other'}, ${group.items.length} ${group.items.length === 1 ? 'chat' : 'chats'}`}
                    accessibilityState={{ expanded: !isCollapsed }}
                    onPress={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey); return next })}
                    style={({ pressed }) => [styles.groupTitle, { opacity: pressed ? 0.6 : 1 }]}
                  >
                    {isCollapsed ? <ChevronRight size={14} color={colors.muted} /> : <ChevronDown size={14} color={colors.muted} />}
                    <FolderOpen size={13} color={colors.muted} />
                    <Text style={[styles.rowTitle, styles.groupName, { color: colors.text }]} numberOfLines={1}>{group.cwd ? group.cwd.split('/').filter(Boolean).pop() || group.cwd : 'Other'}</Text>
                    <Text style={[styles.small, { color: colors.muted }]}>{groupSelected ? `${groupSelected}/` : ''}{group.items.length}</Text>
                  </Pressable>
                  {textButton(allSelected ? 'Deselect' : 'Select', () => setSelected(previous => {
                    const next = new Set(previous)
                    for (const key of groupKeys) {
                      if (allSelected) next.delete(key)
                      else next.add(key)
                    }
                    return next
                  }))}
                </View> : null}
                {!isCollapsed ? group.items.map(candidate => {
                  const key = localSessionImportKey(candidate.backend, candidate.provider_session_id)
                  const checked = selected.has(key)
                  const result = results.find(value => value.provider_session_id === candidate.provider_session_id && value.backend === candidate.backend)
                  const hits = highlights.get(key)
                  return <Pressable
                    key={key}
                    testID="resume-chat-candidate"
                    accessibilityRole="checkbox"
                    accessibilityLabel={candidate.label}
                    accessibilityState={{ checked, disabled: busy }}
                    disabled={busy}
                    onPress={() => toggle(key)}
                    style={({ pressed }) => [styles.candidate, { borderTopColor: colors.border, opacity: pressed ? 0.65 : 1 }]}
                  >
                    {checked ? <SquareCheck size={18} color={colors.blue} /> : <Square size={18} color={colors.muted} />}
                    <BackendMark backend={candidate.backend} size={14} />
                    <View style={styles.headingCopy}>
                      <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={2}>{hits ? Array.from(candidate.label).map((char, index) => hits.has(index) ? <Text key={index} style={{ color: colors.blue }}>{char}</Text> : char) : candidate.label}</Text>
                      <Text style={[styles.small, { color: colors.muted }]}>{formatChatDateTime(candidate.updated_at)}</Text>
                      {result && !result.ok && result.error ? <Text style={[styles.small, { color: colors.red }]}>{result.error}</Text> : null}
                    </View>
                    {result ? (result.ok ? <Check size={14} color={colors.green} /> : <CircleAlert size={14} color={colors.red} />) : null}
                  </Pressable>
                }) : null}
              </View>
            })}
          </> : null}
        </ScrollView>
        <View style={[styles.footer, { borderTopColor: colors.border }]}>
          <Pressable
            testID="resume-chat-import"
            accessibilityRole="button"
            accessibilityLabel={selected.size ? `Import ${selected.size}` : 'Import'}
            accessibilityState={{ disabled: importDisabled, busy: importing }}
            disabled={importDisabled}
            onPress={() => void importSelected()}
            style={({ pressed }) => [styles.primary, styles.footerButton, { backgroundColor: colors.blue, opacity: importDisabled ? 0.35 : pressed ? 0.65 : 1 }]}
          >{importing ? <ActivityIndicator size="small" color={colors.textOnAccent} /> : null}<Text style={[styles.primaryText, { color: colors.textOnAccent }]}>{importing ? 'Importing…' : selected.size ? `Import ${selected.size}` : 'Import'}</Text></Pressable>
        </View>
      </>}
    </SafeAreaView>
  </Modal>
}

function existingMatch(session: Session, providerId: string): ResumeByIdMatch {
  return { key: `existing:${session.id}`, kind: 'existing', backend: session.backend, providerId, label: session.title, cwd: session.cwd ?? null, sessionId: session.id }
}

function sessionProviderIds(session: Session): string[] {
  return [session.session_id, session.claude_session_id, session.codex_thread_id, session.cursor_session_id]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value))
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  header: { minHeight: 64, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, fontWeight: '900' },
  subtitle: { marginTop: 2, fontSize: 11, lineHeight: 15 },
  scroll: { flex: 1 },
  content: { width: '100%', maxWidth: 720, alignSelf: 'center', padding: 14, paddingBottom: 32, gap: 10 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, padding: 11, gap: 9 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headingCopy: { flex: 1, minWidth: 0, gap: 2 },
  headingTitle: { fontSize: 13, fontWeight: '800' },
  small: { fontSize: 11, lineHeight: 15 },
  label: { fontSize: 11, fontWeight: '800', marginTop: 2 },
  idRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: 10, fontSize: 13 },
  idInput: { flex: 1, minWidth: 0 },
  primary: { minHeight: 44, minWidth: 92, borderRadius: 7, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  primaryText: { fontSize: 13, fontWeight: '800' },
  matches: { gap: 6 },
  match: { minHeight: 52, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  details: { gap: 6 },
  segmented: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  segment: { minHeight: 40, borderRadius: 7, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
  segmentText: { fontSize: 12, fontWeight: '700' },
  searchBox: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchInput: { flex: 1, minHeight: 44, fontSize: 13 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  status: { fontSize: 12, lineHeight: 17 },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 4 },
  toolbarCount: { flexGrow: 1, flexBasis: '100%' },
  textButton: { minHeight: 40, paddingHorizontal: 8, justifyContent: 'center' },
  textButtonText: { fontSize: 12, fontWeight: '800' },
  group: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, overflow: 'hidden' },
  groupHeader: { flexDirection: 'row', alignItems: 'center', paddingRight: 4 },
  groupTitle: { flex: 1, minWidth: 0, minHeight: 48, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  groupName: { flexShrink: 1 },
  candidate: { minHeight: 56, borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 9 },
  rowTitle: { fontSize: 13, fontWeight: '700' },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 10 },
  footerButton: { width: '100%', maxWidth: 720, alignSelf: 'center' },
})
