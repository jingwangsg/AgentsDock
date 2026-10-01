import { useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  View,
} from 'react-native'
import { MenuView, type MenuAction } from '@expo/ui/community/menu'
import { SafeAreaView } from 'react-native-safe-area-context'
import { NestableDraggableFlatList, NestableScrollContainer, ScaleDecorator } from 'react-native-draggable-flatlist'
import { Check, ChevronDown, Download, GripVertical, MoreHorizontal, Pencil, Plus, RotateCw, Server, UploadCloud, Wifi, X } from 'lucide-react-native'
import {
  buildUpdateServerProfileInput,
  connectionStateLabel,
  draftAccessToken,
  editServerProfileDraft,
  findProfileByIdentity,
  initialServerProfileDraft,
  profileConnectionLabel,
  displayServerProfileName,
  profileHostSubtitle,
  requiresIdentityResetConfirmation,
  unreadCountLabel,
  type RemoteDeployProgressEntry,
  type ServerConnectionTestResult,
  type ServerProfileConnectionState,
  type ServerProfileDraftValues,
  type ServerProfileEditorInitialMode,
  type ServerProfileListItem,
  type ServerProfileTestInput,
  type UpdateServerProfileInput,
} from '../lib/server-profile-ui'
import { hubProxyBaseURL, hubProxyRemoteId } from '../lib/server-profiles'
import { normalizeServerURL } from '../lib/format'
import { usePalette } from '../theme'
import { Text, TextInput } from './AppText'
import { IconButton, SheetCloseButton } from './ui'

export type {
  RemoteDeployProgressEntry,
  ServerConnectionTestResult,
  ServerProfileConnectionState,
  ServerProfileListItem,
  ServerProfileTestInput,
  UpdateServerProfileInput,
} from '../lib/server-profile-ui'

type Awaitable<T> = T | Promise<T>
type ActionResult = boolean | void
type CreatedProfile = string | Pick<ServerProfileListItem, 'id'>

interface CommonServerProfileProps {
  profiles: readonly ServerProfileListItem[]
  activeProfileId: string | null
  switchingProfileId?: string | null
}

export interface ServerProfileSelectorProps extends CommonServerProfileProps {
  disabled?: boolean
  onSelectProfile: (profileId: string) => Awaitable<ActionResult>
  onManageServers: () => void
}

export interface ServerProfilesManagerProps extends CommonServerProfileProps {
  initialMode?: ServerProfileEditorInitialMode
  onSwitchProfile: (profileId: string) => Awaitable<ActionResult>
  onTestConnection: (input: ServerProfileTestInput) => Awaitable<ServerConnectionTestResult>
  onUpdateProfile: (profileId: string, patch: UpdateServerProfileInput) => Awaitable<void>
  onReorderProfiles: (orderedProfileIds: string[]) => Awaitable<void>
  onRemoveProfile: (profileId: string) => Awaitable<void>
  /** True when a saved server is a hub (advertises remote_servers_v1); remote servers are added through it from any server. */
  hubAvailable?: boolean
  onDeployRemote?: (
    input: { mode: 'deploy' | 'attach'; sshHost: string; installDir?: string; name?: string },
    onProgress: (entry: RemoteDeployProgressEntry) => void,
  ) => Awaitable<CreatedProfile>
  onCancelDeploy?: () => Awaitable<void>
  onRedeployRemote: (profileId: string, force: boolean, onProgress: (entry: RemoteDeployProgressEntry) => void) => Promise<{ redeployed: boolean; running: number | null }>
  onUpdateCli: (profileId: string, backend: 'claude' | 'codex') => Promise<string>
}

export interface ServerProfilesSheetProps extends ServerProfilesManagerProps {
  visible: boolean
  onClose: () => void
}

export function ServerProfileSelector({
  profiles,
  activeProfileId,
  switchingProfileId = null,
  disabled = false,
  onSelectProfile,
  onManageServers,
}: ServerProfileSelectorProps) {
  const colors = usePalette()
  const active = profiles.find(profile => profile.id === activeProfileId) ?? profiles[0] ?? null
  const switching = profiles.find(profile => profile.id === switchingProfileId) ?? null
  const host = active ? profileHostSubtitle(active) : null
  const unavailable = disabled || Boolean(switchingProfileId)
  const selectorLabel = switching
    ? `Switching to ${displayServerProfileName(switching)}. Please wait.`
    : active
      ? `${displayServerProfileName(active)}, ${profileConnectionLabel(active)}${active.cachedUnreadCount > 0 ? `, ${active.cachedUnreadCount} unread` : ''}. Choose agent server.`
      : 'Choose agent server'
  const profileActions: MenuAction[] = profiles.length
    ? profiles.map(profile => ({
        id: `profile:${encodeURIComponent(profile.id)}`,
        title: profile.cachedUnreadCount > 0 ? `${displayServerProfileName(profile)} · ${profile.cachedUnreadCount} unread` : displayServerProfileName(profile),
        state: profile.id === activeProfileId ? 'on' : 'off',
        attributes: { disabled: unavailable },
      }))
    : [{ id: 'no-profiles', title: 'No saved servers', attributes: { disabled: true } }]
  const actions: MenuAction[] = [
    { id: 'profiles', title: 'Servers', displayInline: true, subactions: profileActions },
    { id: 'manage', title: 'Manage Servers', image: 'gearshape', attributes: { disabled } },
  ]
  const trigger = <View
    testID="server-profile-selector"
    accessible
    accessibilityRole="button"
    accessibilityLabel={selectorLabel}
    accessibilityState={{ disabled: unavailable, expanded: false }}
    style={[styles.selector, { backgroundColor: colors.raised, borderColor: colors.border, opacity: disabled ? 0.4 : 1 }]}
  >
    <ServerConnectionDot state={switching ? 'connecting' : active?.connectionState ?? 'cached'} label={switching ? `Connecting to ${displayServerProfileName(switching)}` : active ? profileConnectionLabel(active) : 'No server selected'} />
    <View style={styles.selectorCopy}>
      <Text style={[styles.selectorName, { color: colors.text }]} numberOfLines={1}>{active ? displayServerProfileName(active) : 'Choose server'}</Text>
      {host ? <Text style={[styles.selectorHost, { color: colors.muted }]} numberOfLines={1}>{host}</Text> : null}
    </View>
    {active && active.cachedUnreadCount > 0 ? <ServerUnreadBadge count={active.cachedUnreadCount} /> : null}
    {switching ? <ActivityIndicator size="small" color={colors.blue} /> : <ChevronDown size={15} color={colors.muted} />}
  </View>

  if (unavailable) return trigger
  return <MenuView
    title="Servers"
    actions={actions}
    onPressAction={event => {
      const id = event.nativeEvent.event
      if (id === 'manage') onManageServers()
      else if (id.startsWith('profile:')) {
        const profileId = decodeURIComponent(id.slice('profile:'.length))
        if (profileId !== activeProfileId) void Promise.resolve(onSelectProfile(profileId)).catch(error => {
          Alert.alert('Could not switch server', errorMessage(error))
        })
      }
    }}
    style={styles.selectorMenu}
  >{trigger}</MenuView>
}

export function ServerProfilesSheet({ visible, onClose, ...props }: ServerProfilesSheetProps) {
  const colors = usePalette()
  return <Modal
    visible={visible}
    animationType="slide"
    presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
    allowSwipeDismissal
    onRequestClose={onClose}
  >
    <View style={[styles.sheet, { backgroundColor: colors.surface }]}>
      <SafeAreaView style={styles.sheetSafeArea} edges={['bottom']}>
        <View style={[styles.grabber, { backgroundColor: colors.selected }]} />
        <View style={[styles.sheetHeader, { borderColor: colors.border }]}>
          <View style={styles.sheetHeadingCopy}>
            <Text style={[styles.sheetTitle, { color: colors.text }]}>Servers</Text>
            <Text style={[styles.sheetSubtitle, { color: colors.muted }]}>Each server keeps a separate workspace.</Text>
          </View>
          <SheetCloseButton onPress={onClose} label="Close server management" testID="server-management-close" />
        </View>
        <ServerProfilesManager key={`${visible}:${props.initialMode ?? 'manage'}`} {...props} />
      </SafeAreaView>
    </View>
  </Modal>
}

export function ServerProfilesManager({
  profiles,
  activeProfileId,
  switchingProfileId = null,
  initialMode = 'manage',
  onSwitchProfile,
  onTestConnection,
  onUpdateProfile,
  onReorderProfiles,
  onRemoveProfile,
  hubAvailable = false,
  onDeployRemote,
  onCancelDeploy,
  onRedeployRemote,
  onUpdateCli,
}: ServerProfilesManagerProps) {
  const colors = usePalette()
  const [draft, setDraft] = useState<ServerProfileDraftValues | null>(() => initialServerProfileDraft(initialMode, profiles, activeProfileId))
  const [busy, setBusy] = useState<string | null>(null)
  // Per row, so a CLI update (minutes) or a redeploy leaves the other rows usable.
  const [rowWork, setRowWork] = useState<Record<string, RowWork>>({})
  const [tested, setTested] = useState<ServerConnectionTestResult | null>(null)
  const [feedback, setFeedback] = useState<{ tone: 'error' | 'success' | 'neutral'; message: string } | null>(null)
  const testLease = useRef(0)
  const [deployDraft, setDeployDraft] = useState<{ mode: 'deploy' | 'attach'; sshHost: string; installDir: string; name: string } | null>(null)
  const [deployBusy, setDeployBusy] = useState(false)
  const [deployProgress, setDeployProgress] = useState<RemoteDeployProgressEntry[]>([])
  const [deployError, setDeployError] = useState<string | null>(null)
  const deployLease = useRef(0)
  const editedProfile = useMemo(() => profiles.find(profile => profile.id === draft?.profileId) ?? null, [draft?.profileId, profiles])
  const duplicateProfile = useMemo(
    () => findProfileByIdentity(profiles, tested?.server_identity, draft?.profileId),
    [draft?.profileId, profiles, tested?.server_identity],
  )
  const testedIdentityChanged = Boolean(
    editedProfile?.serverIdentity
    && tested?.server_identity
    && tested.server_identity !== editedProfile.serverIdentity,
  )
  const identityResetRequired = Boolean(editedProfile?.serverIdentity && (
    draft?.resetServerIdentity
    || testedIdentityChanged
    || requiresIdentityResetConfirmation(editedProfile)
    || normalizeComparableURL(draft?.serverUrl) !== normalizeComparableURL(editedProfile.serverUrl)
  ))
  const pendingUpdatePatch = useMemo(
    () => editedProfile && draft ? buildUpdateServerProfileInput(editedProfile, draft) : null,
    [draft, editedProfile],
  )
  const updateConnectionChanged = Boolean(pendingUpdatePatch && (
    pendingUpdatePatch.serverUrl !== undefined
    || pendingUpdatePatch.accessToken !== undefined
    || pendingUpdatePatch.resetServerIdentity === true
  ))
  const updateTestMissing = Boolean(updateConnectionChanged && !tested?.server_identity?.trim())
  const identityResetUnconfirmed = Boolean(testedIdentityChanged && !draft?.resetServerIdentity)

  const invalidateTest = () => {
    testLease.current += 1
    setTested(null)
    setFeedback(null)
    if (busy === 'test') setBusy(null)
  }
  const updateDraft = (patch: Partial<ServerProfileDraftValues>, invalidatesTest = false) => {
    if (invalidatesTest) invalidateTest()
    setDraft(current => current ? { ...current, ...patch } : current)
  }
  const openEdit =(profile: ServerProfileListItem) => {
    if (busy) return
    invalidateTest()
    setDeployDraft(null)
    setDraft(editServerProfileDraft(profile))
  }
  const closeEditor = () => {
    if (busy) return
    invalidateTest()
    setDraft(null)
  }

  const openDeploy = () => {
    if (busy || deployBusy) return
    setDraft(null)
    setDeployError(null)
    setDeployProgress([])
    setDeployDraft({ mode: 'deploy', sshHost: '', installDir: '~/.agentsdock-server', name: '' })
  }
  const closeDeployEditor = () => {
    if (deployBusy) return
    setDeployDraft(null)
  }
  const runDeploy = async () => {
    if (!deployDraft?.sshHost.trim() || deployBusy || !onDeployRemote) return
    const lease = ++deployLease.current
    setDeployBusy(true)
    setDeployError(null)
    setDeployProgress([])
    try {
      const created = await onDeployRemote(
        { mode: deployDraft.mode, sshHost: deployDraft.sshHost.trim(), installDir: deployDraft.installDir.trim() || undefined, name: deployDraft.name.trim() || undefined },
        entry => { if (lease === deployLease.current) setDeployProgress(current => [...current.slice(-49), entry]) },
      )
      if (lease !== deployLease.current) return
      const profileId = typeof created === 'string' ? created : created?.id
      if (!profileId) throw new Error('The remote server was added without a profile identifier.')
      const switched = await onSwitchProfile(profileId)
      if (switched === false) throw new Error('The remote server was saved, but it could not be activated.')
      setDeployDraft(null)
    } catch (error) {
      if (lease === deployLease.current) setDeployError(errorMessage(error))
    } finally {
      if (lease === deployLease.current) setDeployBusy(false)
    }
  }
  const cancelDeploy = async () => {
    if (!deployBusy || !onCancelDeploy) return
    try { await onCancelDeploy() } catch { /* best effort; the poll loop still stops locally */ }
  }

  const testConnection = async () => {
    if (!draft?.serverUrl.trim()) return
    const request = ++testLease.current
    const testedDraft = { ...draft }
    const accessToken = draftAccessToken(testedDraft)
    const input: ServerProfileTestInput = {
      profileId: testedDraft.profileId,
      serverUrl: testedDraft.serverUrl.trim(),
      ...(accessToken !== undefined ? { accessToken } : {}),
    }
    setBusy('test')
    setTested(null)
    setFeedback(null)
    try {
      const result = await onTestConnection(input)
      if (result.ok !== true) throw new Error(result.message || 'Server health check reported unavailable.')
      if (!result.server_identity?.trim()) throw new Error('This AgentsServer did not report a stable server identity.')
      if (request === testLease.current) setTested(result)
    } catch (error) {
      if (request === testLease.current) setFeedback({ tone: 'error', message: errorMessage(error) })
    } finally {
      if (request === testLease.current) setBusy(null)
    }
  }

  const switchProfile = async (profileId: string) => {
    if (profileId === activeProfileId || switchingProfileId || busy) return
    setBusy(`switch:${profileId}`)
    setFeedback(null)
    try {
      const switched = await onSwitchProfile(profileId)
      if (switched === false) throw new Error('The requested server was not activated.')
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    if (!draft?.serverUrl.trim() || busy) return
    if (!editedProfile) {
      setFeedback({ tone: 'error', message: 'This saved server no longer exists.' })
      return
    }
    if (updateConnectionChanged && !tested?.server_identity?.trim()) {
      setFeedback({ tone: 'error', message: 'Test this exact connection successfully before saving address, token, or identity changes.' })
      return
    }
    if (identityResetUnconfirmed) {
      setFeedback({ tone: 'error', message: 'Confirm the server identity reset before saving this replacement server.' })
      return
    }
    setBusy('save')
    setFeedback(null)
    try {
      if (duplicateProfile) throw new Error(`This connection belongs to the existing “${duplicateProfile.name}” profile.`)
      const patch = buildUpdateServerProfileInput(editedProfile, draft, tested?.server_identity)
      if (Object.keys(patch).length) await onUpdateProfile(editedProfile.id, patch)
      testLease.current += 1
      setTested(null)
      setDraft(null)
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  // The hub (the server the proxied remotes go through) stays first; the others are dragged into order.
  const hubId = profiles.find(profile => profiles.some(other => hubProxyBaseURL(other.serverUrl) === normalizeServerURL(profile.serverUrl)))?.id ?? null
  const pinned = profiles.filter(profile => profile.id === hubId)
  const movable = profiles.filter(profile => profile.id !== hubId)
  const reorderProfiles = async (order: readonly ServerProfileListItem[]) => {
    if (busy) return
    setBusy('move')
    setFeedback(null)
    try {
      await onReorderProfiles([...pinned, ...order].map(profile => profile.id))
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const removeProfile = async (profile: ServerProfileListItem) => {
    if (busy) return
    setBusy(`remove:${profile.id}`)
    setFeedback(null)
    try {
      await onRemoveProfile(profile.id)
      if (draft?.profileId === profile.id) setDraft(null)
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const noteRow = (profileId: string, work: RowWork | null) => setRowWork(({ [profileId]: _previous, ...rest }) => work ? { ...rest, [profileId]: work } : rest)
  const redeploying = Object.values(rowWork).some(work => work.kind === 'redeploy' && work.working)
  const redeploy = async (profile: ServerProfileListItem, force: boolean) => {
    noteRow(profile.id, { kind: 'redeploy', working: true, text: 'Redeploying…' })
    try {
      const { redeployed, running } = await onRedeployRemote(profile.id, force, entry => noteRow(profile.id, { kind: 'redeploy', working: true, text: entry.message }))
      if (redeployed) {
        noteRow(profile.id, { kind: 'redeploy', text: 'Redeployed.' })
        return
      }
      noteRow(profile.id, null)
      Alert.alert(`Redeploy “${profile.name}”?`, `${running === null
        ? 'This server could not be checked for running chats.'
        : `${running} running chat${running === 1 ? '' : 's'} on this server will stop.`} Redeploying restarts its AgentsServer.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Redeploy', style: 'destructive', onPress: () => { void redeploy(profile, true) } },
      ])
    } catch (error) {
      noteRow(profile.id, { kind: 'redeploy', failed: true, text: errorMessage(error) })
    }
  }

  const updateCli = async (profile: ServerProfileListItem, backend: 'claude' | 'codex') => {
    noteRow(profile.id, { kind: 'cli', working: true, text: `Updating ${backend === 'claude' ? 'Claude Code' : 'Codex'}…` })
    try {
      noteRow(profile.id, { kind: 'cli', text: await onUpdateCli(profile.id, backend) })
    } catch (error) {
      noteRow(profile.id, { kind: 'cli', failed: true, text: errorMessage(error) })
    }
  }

  const chooseCli = (profile: ServerProfileListItem) => Alert.alert(`Update a CLI on ${profile.name}`, undefined, [
    { text: 'Claude Code', onPress: () => { void updateCli(profile, 'claude') } },
    { text: 'Codex', onPress: () => { void updateCli(profile, 'codex') } },
    { text: 'Cancel', style: 'cancel' },
  ], { cancelable: true })

  const confirmRemove = (profile: ServerProfileListItem) => {
    if (busy) return
    Alert.alert(
      `Remove “${profile.name}”?`,
      hubProxyRemoteId(profile.serverUrl) !== null
        ? `This server will be unregistered from your hub and removed from this device.${profile.id === activeProfileId ? ' The app switches to the hub first.' : ''} Its cached chats remain on this device.`
        : 'The saved connection will be removed. Its cached chats remain on this device.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove server', style: 'destructive', onPress: () => { void removeProfile(profile) } },
      ],
    )
  }

  const confirmIdentityReset = (enabled: boolean) => {
    if (!enabled) {
      updateDraft({ resetServerIdentity: false })
      return
    }
    Alert.alert(
      'Trust a new server identity?',
      'Only continue if you intentionally replaced or moved this AgentsServer. The previous cached workspace will be preserved.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Allow identity reset', style: 'destructive', onPress: () => updateDraft({ resetServerIdentity: true }) },
      ],
    )
  }

  // The hub (or any directly addressed server) can only be removed while
  // another one remains; hub-proxied remotes are always removable.
  const nonProxiedCount = profiles.filter(profile => hubProxyRemoteId(profile.serverUrl) === null).length

  const row = (profile: ServerProfileListItem, drag?: () => void) => {
    const active = profile.id === activeProfileId
    const switching = profile.id === switchingProfileId || busy === `switch:${profile.id}`
    return <ServerManagementRow
      key={profile.id}
      profile={profile}
      active={active}
      switching={switching}
      disabled={Boolean(busy) || Boolean(switchingProfileId)}
      removable={hubProxyRemoteId(profile.serverUrl) !== null || (nonProxiedCount > 1 && !active)}
      onSwitch={() => { void switchProfile(profile.id) }}
      onEdit={() => openEdit(profile)}
      onDrag={drag}
      onRemove={() => confirmRemove(profile)}
      work={rowWork[profile.id] ?? null}
      redeployDisabled={redeploying}
      onRedeploy={hubProxyRemoteId(profile.serverUrl) !== null ? () => { void redeploy(profile, false) } : undefined}
      onUpdateCli={() => chooseCli(profile)}
    />
  }

  return <NestableScrollContainer
    style={styles.manager}
    contentContainerStyle={styles.managerContent}
    automaticallyAdjustKeyboardInsets
    keyboardDismissMode="interactive"
    keyboardShouldPersistTaps="handled"
  >
    <View style={styles.managementHeading}>
      <View style={styles.managementHeadingCopy}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>Servers</Text>
        <Text style={[styles.help, { color: colors.muted }]}>Remote servers registered on your hub appear here automatically.</Text>
      </View>
      {hubAvailable ? <SecondaryButton icon={Plus} label="Add server" disabled={Boolean(busy) || deployBusy} onPress={openDeploy} /> : null}
    </View>

    <View style={[styles.profileList, { borderColor: colors.border }]}>
      {profiles.length ? <>
        {pinned.map(profile => row(profile))}
        <NestableDraggableFlatList
          data={movable}
          keyExtractor={profile => profile.id}
          onDragEnd={({ data }) => { void reorderProfiles(data) }}
          renderItem={({ item, drag }) => <ScaleDecorator activeScale={1.02}>{row(item, drag)}</ScaleDecorator>}
        />
      </> : <View style={styles.noProfiles}>
        <Server size={24} color={colors.muted} />
        <Text style={[styles.noProfilesTitle, { color: colors.text }]}>No saved servers</Text>
        <Text style={[styles.help, { color: colors.muted, textAlign: 'center' }]}>Connect to your hub to begin.</Text>
      </View>}
    </View>

    {feedback ? <View
      accessibilityRole="alert"
      style={[styles.feedback, {
        backgroundColor: feedback.tone === 'error' ? `${colors.red}18` : feedback.tone === 'success' ? `${colors.green}18` : colors.raised,
        borderColor: feedback.tone === 'error' ? `${colors.red}66` : feedback.tone === 'success' ? `${colors.green}66` : colors.border,
      }]}
    ><Text style={{ color: feedback.tone === 'error' ? colors.red : feedback.tone === 'success' ? colors.green : colors.text, fontSize: 12, lineHeight: 17 }}>{feedback.message}</Text></View> : null}

    {draft ? <View testID="server-profile-editor" style={[styles.editor, { backgroundColor: colors.raised, borderColor: colors.border }]}>
      <View style={styles.editorHeader}>
        <View style={styles.editorHeaderCopy}>
          <Text style={[styles.editorTitle, { color: colors.text }]}>{`Edit ${editedProfile?.name || 'server'}`}</Text>
          <Text style={[styles.help, { color: colors.muted }]}>Credentials remain in the device secure store.</Text>
        </View>
        <IconButton icon={X} disabled={Boolean(busy)} onPress={closeEditor} label="Close server editor" />
      </View>

      <FieldLabel text="Name" />
      <TextInput
        testID="server-profile-name"
        accessibilityLabel="Server name"
        value={draft.name}
        onChangeText={name => updateDraft({ name })}
        editable={!busy}
        placeholder="Home Mac"
        placeholderTextColor={colors.muted}
        returnKeyType="next"
        style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
      />

      <FieldLabel text="Server address" />
      <TextInput
        testID="server-profile-url"
        accessibilityLabel="Server address"
        value={draft.serverUrl}
        onChangeText={serverUrl => updateDraft({ serverUrl }, true)}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="my-mac.tailnet.ts.net:7850"
        placeholderTextColor={colors.muted}
        style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
      />

      <FieldLabel text="Access token" />
      <TextInput
        testID="server-profile-token"
        accessibilityLabel="Access token"
        value={draft.accessToken}
        onChangeText={accessToken => updateDraft({ accessToken }, true)}
        editable={!busy && !draft.clearAccessToken}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={editedProfile?.hasAccessToken ? 'Leave blank to keep saved token' : 'Hub access token'}
        placeholderTextColor={colors.muted}
        style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border, opacity: draft.clearAccessToken ? 0.4 : 1 }]}
      />
      {editedProfile?.hasAccessToken ? <View style={styles.switchRow}>
        <View style={styles.switchCopy}>
          <Text style={[styles.switchTitle, { color: colors.text }]}>Remove saved access token</Text>
          <Text style={[styles.help, { color: colors.muted }]}>Blank above preserves it; this switch explicitly deletes it.</Text>
        </View>
        <Switch
          testID="server-profile-clear-token"
          accessibilityLabel="Remove saved access token"
          value={draft.clearAccessToken}
          disabled={Boolean(busy)}
          onValueChange={clearAccessToken => updateDraft({ clearAccessToken, accessToken: '' }, true)}
        />
      </View> : null}

      {identityResetRequired ? <View style={[styles.identityWarning, { backgroundColor: `${colors.orange}14`, borderColor: `${colors.orange}55` }]}>
        <View style={styles.switchRow}>
          <View style={styles.switchCopy}>
            <Text style={[styles.switchTitle, { color: colors.orange }]}>Allow a new server identity</Text>
            <Text style={[styles.help, { color: colors.muted }]}>The endpoint no longer matches the saved identity. Confirm only after intentionally replacing or moving the server.</Text>
          </View>
          <Switch
            testID="server-profile-reset-identity"
            accessibilityLabel="Allow a new server identity"
            value={draft.resetServerIdentity}
            disabled={Boolean(busy)}
            onValueChange={confirmIdentityReset}
          />
        </View>
      </View> : null}

      {tested ? <View accessibilityRole="alert" style={[styles.testResult, { backgroundColor: `${duplicateProfile || testedIdentityChanged ? colors.orange : colors.green}18` }]}>
        <Check size={16} color={duplicateProfile || testedIdentityChanged ? colors.orange : colors.green} />
        <Text style={{ flex: 1, color: duplicateProfile || testedIdentityChanged ? colors.orange : colors.green, fontSize: 12, lineHeight: 17 }}>
          {duplicateProfile
            ? `Already saved as “${duplicateProfile.name}”.`
            : testedIdentityChanged
              ? `Connected, but this endpoint now reports ${tested.server_identity} instead of ${editedProfile?.serverIdentity}. Confirm the identity reset below before saving.`
            : `Connected${tested.server_identity ? ` · ${tested.server_identity}` : ''}${tested.version ? ` · ${tested.version}` : ''}`}
        </Text>
      </View> : null}

      {updateTestMissing ? <Text style={[styles.help, { color: colors.orange }]}>Test this exact connection before saving address, access-token, or identity changes.</Text> : null}

      <View style={styles.editorActions}>
        <SecondaryButton
          icon={Wifi}
          label={busy === 'test' ? 'Testing…' : 'Test connection'}
          disabled={Boolean(busy) || !draft.serverUrl.trim()}
          busy={busy === 'test'}
          onPress={() => { void testConnection() }}
        />
        <View style={styles.actionSpacer} />
        <SecondaryButton label="Cancel" disabled={Boolean(busy)} onPress={closeEditor} />
        <PrimaryButton
          label={busy === 'save' ? 'Saving…' : 'Save'}
          disabled={Boolean(busy) || !draft.serverUrl.trim() || Boolean(duplicateProfile) || updateTestMissing || identityResetUnconfirmed}
          busy={busy === 'save'}
          onPress={() => { void save() }}
        />
      </View>
    </View> : null}

    {deployDraft ? <View testID="remote-deploy-editor" style={[styles.editor, { backgroundColor: colors.raised, borderColor: colors.border }]}>
      <View style={styles.editorHeader}>
        <View style={styles.editorHeaderCopy}>
          <Text style={[styles.editorTitle, { color: colors.text }]}>Add server</Text>
          <Text style={[styles.help, { color: colors.muted }]}>The active server reaches this one over SSH and proxies it; only the hub's own token ever reaches this device.</Text>
        </View>
        <IconButton icon={X} disabled={deployBusy} onPress={closeDeployEditor} label="Close add server editor" />
      </View>

      <View style={[styles.segmented, { borderColor: colors.border }]} accessibilityRole="radiogroup" accessibilityLabel="How to add">
        {([['deploy', 'Deploy a new server'], ['attach', 'Attach an existing server']] as const).map(([mode, label]) => <Pressable
          key={mode}
          testID={`remote-add-mode-${mode}`}
          accessibilityRole="radio"
          accessibilityLabel={label}
          accessibilityState={{ selected: deployDraft.mode === mode, disabled: deployBusy }}
          disabled={deployBusy}
          onPress={() => setDeployDraft(current => current ? { ...current, mode } : current)}
          style={[styles.segment, deployDraft.mode === mode && { backgroundColor: colors.selected }]}
        ><Text style={[styles.segmentLabel, { color: deployDraft.mode === mode ? colors.text : colors.muted }]}>{label}</Text></Pressable>)}
      </View>
      {deployDraft.mode === 'attach' ? <Text style={[styles.help, { color: colors.muted }]}>Registers the AgentsServer another computer already deployed in this directory. Nothing is uploaded and the server is not restarted.</Text> : null}

      <FieldLabel text="SSH host" />
      <TextInput
        testID="remote-deploy-ssh-host"
        accessibilityLabel="SSH host"
        value={deployDraft.sshHost}
        onChangeText={sshHost => setDeployDraft(current => current ? { ...current, sshHost } : current)}
        editable={!deployBusy}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="osmo_9000 or user@host"
        placeholderTextColor={colors.muted}
        style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
      />

      <FieldLabel text="Install directory" />
      <TextInput
        testID="remote-deploy-install-dir"
        accessibilityLabel="Install directory"
        value={deployDraft.installDir}
        onChangeText={installDir => setDeployDraft(current => current ? { ...current, installDir } : current)}
        editable={!deployBusy}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={colors.muted}
        style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
      />

      <FieldLabel text="Name on this device" />
      <TextInput
        testID="remote-deploy-name"
        accessibilityLabel="Name on this device"
        value={deployDraft.name}
        onChangeText={name => setDeployDraft(current => current ? { ...current, name } : current)}
        editable={!deployBusy}
        placeholder={deployDraft.sshHost.trim() || 'osmo, Lab GPU box…'}
        placeholderTextColor={colors.muted}
        style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
      />

      {deployProgress.length ? <View style={styles.deployLog}>
        {deployProgress.slice(-10).map((entry, index) => <Text
          key={`${entry.phase}-${deployProgress.length - 10 + index}`}
          style={[styles.deployLogLine, { color: colors.muted }]}
          numberOfLines={2}
        >{entry.message}</Text>)}
      </View> : null}
      {deployError ? <View accessibilityRole="alert" style={[styles.feedback, { backgroundColor: `${colors.red}18`, borderColor: `${colors.red}66` }]}>
        <Text style={{ color: colors.red, fontSize: 12, lineHeight: 17 }}>{deployError}</Text>
      </View> : null}

      <View style={styles.editorActions}>
        <SecondaryButton label="Cancel" disabled={deployBusy && !onCancelDeploy} onPress={() => { if (deployBusy) void cancelDeploy(); else closeDeployEditor() }} />
        <PrimaryButton
          label={deployDraft.mode === 'attach' ? (deployBusy ? 'Attaching…' : 'Attach & switch') : (deployBusy ? 'Deploying…' : 'Deploy & switch')}
          disabled={deployBusy || !deployDraft.sshHost.trim()}
          busy={deployBusy}
          onPress={() => { void runDeploy() }}
        />
      </View>
    </View> : null}
  </NestableScrollContainer>
}

interface RowWork { kind: 'redeploy' | 'cli'; text: string; working?: boolean; failed?: boolean }

function ServerManagementRow({ profile, active, switching, disabled, removable, work, redeployDisabled, onSwitch, onEdit, onDrag, onRemove, onRedeploy, onUpdateCli }: {
  profile: ServerProfileListItem
  active: boolean
  switching: boolean
  disabled: boolean
  removable: boolean
  work: RowWork | null
  redeployDisabled: boolean
  onSwitch: () => void
  onEdit: () => void
  /** Starts a drag; absent on the pinned hub row. */
  onDrag?: () => void
  onRemove: () => void
  onRedeploy?: () => void
  onUpdateCli: () => void
}) {
  const colors = usePalette()
  const status = profileConnectionLabel(profile)
  const details = [profile.serverIdentity ? `Identity: ${profile.serverIdentity}` : '', profile.serverVersion ? `AgentsServer ${profile.serverVersion}` : ''].filter(Boolean).join(' · ')
  // An Alert, not MenuView: MenuView does not open inside this sheet's Modal on Android, and the
  // row has at most three actions, Android's Alert limit (tapping outside cancels there; iOS
  // ignores `cancelable`, so it gets a Cancel button).
  const rowActions = removable ? [{ text: 'Remove', style: 'destructive' as const, onPress: onRemove }] : []
  const alertButtons = Platform.OS === 'ios' ? [...rowActions, { text: 'Cancel', style: 'cancel' as const }] : rowActions
  return <View style={[styles.profileRow, { borderColor: colors.border, backgroundColor: active ? `${colors.blue}10` : colors.surface }]}>
    {onDrag
      ? <Pressable accessibilityRole="button" accessibilityLabel={`Drag ${profile.name} to reorder`} disabled={disabled} onPressIn={onDrag} hitSlop={8} style={styles.grip}><GripVertical size={16} color={colors.muted} /></Pressable>
      : <View style={styles.grip} />}
    <ServerConnectionDot state={switching ? 'connecting' : profile.connectionState} label={switching ? `Connecting to ${profile.name}` : status} />
    <View style={styles.profileCopy}>
      <View style={styles.profileTitleRow}>
        <Text style={[styles.profileName, { color: colors.text }]} numberOfLines={1}>{profile.name}</Text>
        {active ? <View style={[styles.activeBadge, { backgroundColor: `${colors.blue}20` }]}><Text style={[styles.activeBadgeText, { color: colors.blue }]}>Active</Text></View> : null}
        {profile.cachedUnreadCount > 0 ? <ServerUnreadBadge count={profile.cachedUnreadCount} /> : null}
      </View>
      <Text style={[styles.profileUrl, { color: colors.muted }]} numberOfLines={1}>{profile.serverUrl}</Text>
      {profile.lastConnectionError ? <Text style={[styles.profileDetail, { color: profile.connectionState === 'degraded' ? colors.orange : colors.red }]} numberOfLines={2}>{profile.lastConnectionError}</Text> : details ? <Text style={[styles.profileDetail, { color: colors.muted }]} numberOfLines={1}>{details}</Text> : null}
      {work ? <Text accessibilityRole={work.failed ? 'alert' : undefined} style={[styles.profileDetail, { color: work.failed ? colors.red : colors.muted }]} numberOfLines={2}>{work.text}</Text> : null}
      {/* Under the name, not beside Use/Edit/More: a 375 pt row has no room for two more buttons. */}
      <View style={styles.rowTools}>
        <RowTool icon={Download} label="Update CLI" accessibilityLabel={`Update a CLI on ${profile.name}`} busy={work?.kind === 'cli' && Boolean(work.working)} disabled={disabled || Boolean(work?.working)} onPress={onUpdateCli} />
        {onRedeploy ? <RowTool icon={RotateCw} label="Redeploy" accessibilityLabel={`Redeploy ${profile.name}`} busy={work?.kind === 'redeploy' && Boolean(work.working)} disabled={disabled || redeployDisabled || Boolean(work?.working)} onPress={onRedeploy} /> : null}
      </View>
    </View>
    {!active ? <SecondaryButton label={switching ? 'Using…' : 'Use'} disabled={disabled} busy={switching} accessibilityLabel={`Use ${profile.name}`} compact onPress={onSwitch} /> : null}
    <IconButton icon={Pencil} disabled={disabled} onPress={onEdit} label={`Edit ${profile.name}`} />
    <IconButton icon={MoreHorizontal} disabled={disabled || rowActions.length === 0} onPress={() => Alert.alert(profile.name, undefined, alertButtons, { cancelable: true })} label={`More actions for ${profile.name}`} />
  </View>
}

function RowTool({ icon: Icon, label, accessibilityLabel, busy, disabled, onPress }: { icon: typeof Download; label: string; accessibilityLabel: string; busy: boolean; disabled: boolean; onPress: () => void }) {
  const colors = usePalette()
  // A 30 pt chip with a 44 pt touch target.
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled, busy }} disabled={disabled} onPress={onPress} hitSlop={7}
    style={({ pressed }) => [styles.rowTool, { backgroundColor: colors.raised, opacity: disabled && !busy ? 0.45 : pressed ? 0.7 : 1 }]}>
    {busy ? <ActivityIndicator size="small" color={colors.blue} /> : <Icon size={13} color={colors.blue} />}
    <Text style={[styles.rowToolText, { color: colors.blue }]}>{label}</Text>
  </Pressable>
}

export function ServerConnectionDot({ state, label = connectionStateLabel(state) }: { state: ServerProfileConnectionState; label?: string }) {
  const colors = usePalette()
  const color = state === 'online' ? colors.green : state === 'degraded' || state === 'retrying' ? colors.orange : state === 'connecting' ? colors.blue : state === 'offline' ? colors.red : colors.muted
  return <View accessible accessibilityRole="image" accessibilityLabel={label} style={[styles.connectionDot, { backgroundColor: color }]} />
}

export function ServerUnreadBadge({ count }: { count: number }) {
  const colors = usePalette()
  return <View accessible accessibilityRole="text" accessibilityLabel={`${count} unread chat${count === 1 ? '' : 's'}`} style={[styles.unreadBadge, { backgroundColor: colors.blue }]}>
    <Text style={[styles.unreadText, { color: colors.textOnAccent }]}>{unreadCountLabel(count)}</Text>
  </View>
}

function FieldLabel({ text }: { text: string }) {
  const colors = usePalette()
  return <Text style={[styles.fieldLabel, { color: colors.muted }]}>{text}</Text>
}

function PrimaryButton({ label, disabled, busy, onPress }: { label: string; disabled?: boolean; busy?: boolean; onPress: () => void }) {
  const colors = usePalette()
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled: Boolean(disabled), busy: Boolean(busy) }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.blue, opacity: disabled ? 0.35 : pressed ? 0.65 : 1 }]}
  >{busy ? <ActivityIndicator size="small" color={colors.textOnAccent} /> : null}<Text style={[styles.primaryButtonText, { color: colors.textOnAccent }]}>{label}</Text></Pressable>
}

function SecondaryButton({ icon: Icon, label, accessibilityLabel, disabled, busy, compact, onPress }: {
  icon?: typeof UploadCloud
  label: string
  accessibilityLabel?: string
  disabled?: boolean
  busy?: boolean
  compact?: boolean
  onPress: () => void
}) {
  const colors = usePalette()
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled: Boolean(disabled), busy: Boolean(busy) }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.secondaryButton, compact && styles.compactButton, { backgroundColor: colors.raised, opacity: disabled ? 0.35 : pressed ? 0.65 : 1 }]}
  >{busy ? <ActivityIndicator size="small" color={colors.blue} /> : Icon ? <Icon size={15} color={colors.muted} /> : null}{compact && busy ? null : <Text style={[styles.secondaryButtonText, { color: colors.text }]} numberOfLines={1}>{label}</Text>}</Pressable>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeComparableURL(value?: string): string {
  if (!value?.trim()) return ''
  try { return new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `http://${value.trim()}`).toString().replace(/\/$/, '') }
  catch { return value.trim() }
}

const styles = StyleSheet.create({
  selectorMenu: { minWidth: 0 },
  selector: { minHeight: 48, minWidth: 0, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 9 },
  selectorCopy: { flex: 1, minWidth: 0, gap: 1 },
  selectorName: { fontSize: 13, fontWeight: '800' },
  selectorHost: { fontSize: 10 },
  connectionDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  unreadBadge: { minWidth: 21, minHeight: 20, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2, alignItems: 'center', justifyContent: 'center' },
  unreadText: { fontSize: 10, fontWeight: '800' },
  sheet: { flex: 1 },
  sheetSafeArea: { flex: 1 },
  grabber: { alignSelf: 'center', width: 36, height: 5, marginTop: 7, marginBottom: 1, borderRadius: 3 },
  sheetHeader: { minHeight: 64, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 8 },
  sheetHeadingCopy: { flex: 1, minWidth: 0, gap: 2 },
  sheetTitle: { fontSize: 17, fontWeight: '800' },
  sheetSubtitle: { fontSize: 10 },
  manager: { flex: 1 },
  managerContent: { width: '100%', maxWidth: 760, alignSelf: 'center', padding: 14, paddingBottom: 28, gap: 10 },
  managementHeading: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 10 },
  managementHeadingCopy: { flex: 1, minWidth: 0, gap: 3 },
  sectionTitle: { fontSize: 14, fontWeight: '800' },
  help: { fontSize: 11, lineHeight: 16 },
  profileList: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: 'hidden' },
  profileRow: { minHeight: 68, paddingVertical: 8, paddingLeft: 5, paddingRight: 5, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 8 },
  grip: { width: 18, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  rowTools: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  rowTool: { minHeight: 30, borderRadius: 7, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 5 },
  rowToolText: { fontSize: 12, fontWeight: '700' },
  profileCopy: { flex: 1, minWidth: 74, gap: 2 },
  profileTitleRow: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  profileName: { minWidth: 0, flexShrink: 1, fontSize: 13, fontWeight: '800' },
  profileUrl: { fontSize: 10 },
  profileDetail: { fontSize: 9, lineHeight: 13 },
  activeBadge: { minHeight: 18, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, alignItems: 'center', justifyContent: 'center' },
  activeBadgeText: { fontSize: 8, fontWeight: '800', textTransform: 'uppercase' },
  noProfiles: { minHeight: 150, padding: 20, alignItems: 'center', justifyContent: 'center', gap: 7 },
  noProfilesTitle: { fontSize: 15, fontWeight: '800' },
  feedback: { minHeight: 42, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, padding: 10, justifyContent: 'center' },
  deployLog: { gap: 2 },
  deployLogLine: { fontSize: 11, lineHeight: 15 },
  editor: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 8 },
  editorHeader: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 8 },
  editorHeaderCopy: { flex: 1, minWidth: 0, gap: 2 },
  editorTitle: { fontSize: 14, fontWeight: '800' },
  fieldLabel: { marginTop: 2, fontSize: 11, fontWeight: '700' },
  input: { minHeight: 44, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, fontSize: 14 },
  switchRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 10 },
  switchCopy: { flex: 1, minWidth: 0, gap: 2 },
  switchTitle: { fontSize: 12, fontWeight: '700' },
  identityWarning: { borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 2 },
  testResult: { minHeight: 42, borderRadius: 6, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  editorActions: { paddingTop: 3, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 7 },
  segmented: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, overflow: 'hidden' },
  segment: { flex: 1, minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center' },
  segmentLabel: { fontSize: 12, fontWeight: '700' },
  actionSpacer: { flex: 1, minWidth: 8 },
  primaryButton: { minHeight: 44, borderRadius: 6, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  primaryButtonText: { fontSize: 12, fontWeight: '800' },
  secondaryButton: { minHeight: 44, borderRadius: 6, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  compactButton: { minWidth: 55, paddingHorizontal: 9 },
  secondaryButtonText: { fontSize: 12, fontWeight: '700' },
})
