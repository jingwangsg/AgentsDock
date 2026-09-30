// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, Clock3, Download, GripVertical, LoaderCircle, Pencil, Plus, RotateCw, Server, Trash2, Wifi } from 'lucide-react'
import type { PublicServerProfile, ServerSetupProgress } from '@shared/types'
import { DEFAULT_SERVER_URL } from '@shared/server-url'
import { trackEvent } from '../lib/analytics'
import { useAppStore } from '../store/app-store'
import { cleanIPCError } from '../lib/file-actions'

interface ServerDraft {
  profileId: string | null
  name: string
  sshHost: string
  installDir: string
  mode: 'deploy' | 'attach'
  resetServerIdentity: boolean
}

const emptyDraft = (): ServerDraft => ({
  profileId: null,
  name: '',
  sshHost: '',
  installDir: '~/.agentsdock-server',
  mode: 'deploy',
  resetServerIdentity: false
})

interface RowWork { kind: 'redeploy' | 'cli'; text: string; working?: boolean; failed?: boolean; confirm?: boolean }

/** Remote profiles are proxied through the local hub as `${DEFAULT_SERVER_URL}/api/remote/<id>`; that path on another host is a plain saved server. */
const isHubRemote = (url: string) => url.startsWith(`${DEFAULT_SERVER_URL}/api/remote/`)

/** The saved order after dragging one server onto another's place; the local server stays first. */
export function serverOrderAfterDrag(profiles: PublicServerProfile[], hubId: string | null, activeId: string, overId: string): string[] | null {
  const movable = profiles.filter(profile => profile.id !== hubId)
  const from = movable.findIndex(profile => profile.id === activeId)
  const to = movable.findIndex(profile => profile.id === overId)
  if (from < 0 || to < 0 || from === to) return null
  return [...(hubId ? [hubId] : []), ...arrayMove(movable, from, to).map(profile => profile.id)]
}

/** A server row that can be dragged among the others; the local server is pinned and shows no grip. */
function SortableServerRow({ profile, pinned, disabled, className, children }: { profile: PublicServerProfile; pinned: boolean; disabled: boolean; className: string; children: ReactNode }) {
  useLocale()
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: profile.id, disabled: pinned || disabled })
  return <div ref={setNodeRef} className={`${className}${isDragging ? ' dragging' : ''}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
    <button ref={setActivatorNodeRef} type="button" className={`server-management-grip${pinned ? ' pinned' : ''}`} aria-label={t('ui.ServerManagement.drag_to_reorder', { server: profile.name })} disabled={pinned || disabled} {...attributes} {...listeners}><GripVertical size={13} /></button>
    {children}
  </div>
}

export function ServerManagement({ addRequest = 0, manageRequest = 0 }: { addRequest?: number; manageRequest?: number }) {
  useLocale()
  const profiles = useAppStore(state => state.profiles)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const switchServer = useAppStore(state => state.switchServer)
  const [draft, setDraft] = useState<ServerDraft | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [activationError, setActivationError] = useState<{ profileId: string; message: string } | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  // Per row, so a CLI update (minutes) or a redeploy leaves the other rows usable.
  const [rowWork, setRowWork] = useState<Record<string, RowWork>>({})
  const editorRef = useRef<HTMLDivElement | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const revealEditor = useRef(false)

  const hub = profiles.find(profile => profile.serverUrl === DEFAULT_SERVER_URL) ?? null
  const ordered = hub ? [hub, ...profiles.filter(profile => profile.id !== hub.id)] : profiles

  const openEditor = (next: ServerDraft) => {
    revealEditor.current = true
    setEditorError(null)
    setDraft(next)
  }

  const editedProfile = useMemo(
    () => profiles.find(profile => profile.id === draft?.profileId) ?? null,
    [draft?.profileId, profiles, getLocale()]
  )

  useEffect(() => {
    if (addRequest > 0) {
      setBusy(null)
      openEditor(emptyDraft())
    }
  }, [addRequest])
  useEffect(() => {
    if (manageRequest > 0) {
      setBusy(null)
      setDraft(null)
      setEditorError(null)
    }
  }, [manageRequest])
  useEffect(() => {
    if (!draft || !revealEditor.current) return
    revealEditor.current = false
    editorRef.current?.scrollIntoView?.({ block: 'nearest' })
    nameInputRef.current?.focus({ preventScroll: true })
  }, [draft])

  const beginEdit = (profile: PublicServerProfile) => {
    openEditor({ profileId: profile.id, name: profile.name, sshHost: '', installDir: '', mode: 'deploy', resetServerIdentity: false })
    setConfirmRemoveId(null)
  }

  const refreshProfiles = async () => {
    const next = await window.agentsDock.servers.list()
    useAppStore.setState({ profiles: next })
    return next
  }

  const updateDraft = (patch: Partial<ServerDraft>) => {
    setDraft(current => current ? { ...current, ...patch } : current)
  }

  const [deployProgress, setDeployProgress] = useState<ServerSetupProgress[]>([])
  useEffect(() => window.agentsDock.events?.on?.('server:setup-progress', value => {
    setDeployProgress(current => [...current.slice(-49), value])
  }), [])

  // One-field add: the hub deploys the server on the SSH host (or, in attach mode,
  // registers an install another hub deployed), keeps the tunnel and registers the
  // remote; the main process mirrors the registry into profiles.
  const deploy = async () => {
    const host = draft?.sshHost.trim()
    if (!draft || !host || busy) return
    setEditorError(null)
    setBusy('deploy')
    setDeployProgress([])
    let added = false
    try {
      const input = { sshHost: host, installDir: draft.installDir.trim() || undefined, name: draft.name.trim() || undefined }
      const profile = draft.mode === 'attach'
        ? await window.agentsDock.remoteServers.attach(input)
        : await window.agentsDock.remoteServers.deploy(input)
      added = true
      trackEvent('server_added', { success: true })
      await refreshProfiles()
      // The profile now exists: if the switch below fails, a retry must edit or
      // switch to it, not redeploy and add a second profile for the same host.
      setDraft(current => current ? { ...current, profileId: profile.id } : current)
      const switched = await switchServer(profile.id)
      if (!switched || useAppStore.getState().activeProfileId !== profile.id) throw new Error(`“${profile.name}” was saved, but AgentsDock could not switch to it.`)
      setDraft(null)
    } catch (error) {
      if (!added) trackEvent('server_added', { success: false })
      setEditorError(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    if (!draft?.profileId) return
    setBusy('save')
    setEditorError(null)
    try {
      if (!editedProfile) throw new Error('This server profile no longer exists.')
      const name = draft.name.trim() || editedProfile.name
      const patch = {
        ...(name !== editedProfile.name ? { name } : {}),
        ...(draft.resetServerIdentity ? { resetServerIdentity: true } : {})
      }
      const current = useAppStore.getState()
      if (current.switchingProfileId) throw new Error('Wait for the current server switch to finish, then save again.')
      if (draft.profileId === current.activeProfileId && patch.resetServerIdentity) {
        const generation = current.profileGeneration
        const switched = await switchServer(draft.profileId, true, patch)
        const reopened = useAppStore.getState()
        if (!switched || reopened.activeProfileId !== draft.profileId || reopened.profileGeneration <= generation) {
          throw new Error('The updated server could not be reopened safely.')
        }
      } else {
        if (Object.keys(patch).length) await window.agentsDock.servers.update(draft.profileId, patch)
        await refreshProfiles()
      }
      setDraft(null)
    } catch (error) {
      const detail = errorMessage(error)
      setEditorError(detail)
      useAppStore.getState().setError(detail)
    } finally {
      setBusy(null)
    }
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    const order = over ? serverOrderAfterDrag(profiles, hub?.id ?? null, String(active.id), String(over.id)) : null
    if (!order) return
    setBusy(`move:${active.id}`)
    try {
      const next = await window.agentsDock.servers.reorder(order)
      useAppStore.setState({ profiles: next })
    } catch (error) {
      useAppStore.getState().setError(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const activate = async (profileId: string) => {
    if (profileId === activeProfileId || switchingProfileId) return
    setActivationError(null)
    setBusy(`switch:${profileId}`)
    try {
      const switched = await switchServer(profileId)
      if (!switched || useAppStore.getState().activeProfileId !== profileId) throw new Error('The requested server was not activated.')
      trackEvent('server_switched', { success: true })
      useAppStore.getState().setModal('settings', false)
      useAppStore.getState().setModal('appSettings', false)
    } catch (error) {
      trackEvent('server_switched', { success: false })
      const detail = errorMessage(error)
      setActivationError({ profileId, message: detail })
      useAppStore.getState().setError(detail)
    } finally {
      setBusy(null)
    }
  }

  // The hub is down (e.g. launchd has not started it yet after login): start its LaunchAgent in place.
  const startHub = async (profileId: string) => {
    setActivationError(null)
    setBusy(`start:${profileId}`)
    try {
      await window.agentsDock.hub.startLocalServer()
    } catch (error) {
      setActivationError({ profileId, message: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const remove = async (profile: PublicServerProfile) => {
    if (confirmRemoveId !== profile.id) {
      setConfirmRemoveId(profile.id)
      return
    }
    setBusy(`remove:${profile.id}`)
    try {
      if (hub && isHubRemote(profile.serverUrl)) {
        // The active remote is removed after switching to the hub.
        if (profile.id === useAppStore.getState().activeProfileId && !await switchServer(hub.id)) return
        await window.agentsDock.remoteServers.remove(profile.id)
      } else {
        // Legacy profile that is neither the hub nor one of its remotes.
        await window.agentsDock.servers.remove(profile.id)
      }
      await refreshProfiles()
      if (draft?.profileId === profile.id) setDraft(null)
      setConfirmRemoveId(null)
    } catch (error) {
      useAppStore.getState().setError(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  // Works whichever server is active: the main process talks to the hub (redeploy) or to that server (CLI).
  const noteRow = (profileId: string, work: RowWork | null) => setRowWork(({ [profileId]: _previous, ...rest }) => work ? { ...rest, [profileId]: work } : rest)
  const redeploying = Object.values(rowWork).some(work => work.kind === 'redeploy' && work.working)
  const redeploy = async (profile: PublicServerProfile, force: boolean) => {
    noteRow(profile.id, { kind: 'redeploy', working: true, text: t('hub.redeploying') })
    const stop = window.agentsDock.events?.on?.('remote-servers:redeploy-progress', value => noteRow(profile.id, { kind: 'redeploy', working: true, text: value.message }))
    try {
      const { redeployed, running } = await window.agentsDock.remoteServers.redeploy(profile.id, force)
      noteRow(profile.id, redeployed
        ? { kind: 'redeploy', text: t('hub.redeployed') }
        : { kind: 'redeploy', confirm: true, text: running === null ? t('hub.redeployUnchecked') : t('hub.redeployRunning', { count: running }) })
    } catch (error) {
      noteRow(profile.id, { kind: 'redeploy', failed: true, text: cleanIPCError(errorMessage(error)) })
    } finally {
      stop?.()
    }
  }
  const updateCli = async (profile: PublicServerProfile, backend: 'claude' | 'codex') => {
    noteRow(profile.id, { kind: 'cli', working: true, text: t('runtimeUpdate.updating') })
    try {
      const { output, diagnostic } = await window.agentsDock.servers.updateCli(profile.id, backend)
      if (profile.id === useAppStore.getState().activeProfileId) {
        useAppStore.setState(state => ({ health: state.health && { ...state.health, runtimes: { ...state.health.runtimes, [backend]: diagnostic } } }))
      }
      noteRow(profile.id, { kind: 'cli', text: output.split('\n').at(-1) || t('runtimeUpdate.done') })
    } catch (error) {
      noteRow(profile.id, { kind: 'cli', failed: true, text: cleanIPCError(errorMessage(error)) })
    }
  }

  // Phones connect to the same hub over Tailscale; the token stays in the main process.
  const [pairingUrl, setPairingUrl] = useState<string | null>(null)
  const [tokenCopied, setTokenCopied] = useState(false)
  const hubHasToken = Boolean(hub?.hasAccessToken)
  useEffect(() => {
    if (!hubHasToken) return
    let active = true
    void window.agentsDock.hub.pairingUrl().then(url => { if (active) setPairingUrl(url) })
    return () => { active = false }
  }, [hubHasToken])
  const copyToken = async () => {
    if (!await window.agentsDock.hub.copyToken()) return
    setTokenCopied(true)
    window.setTimeout(() => setTokenCopied(false), 2_000)
  }

  return <section className="server-management" aria-label={t("ui.ServerManagement.ServerManagement.saved_servers_4bf0848")}>
    <div className="server-management-heading">
      <div><strong>{t("ui.ServerManagement.ServerManagement.servers_68d7beb")}</strong><small>{t("ui.ServerManagement.ServerManagement.each_server_keeps_its_own_chats_drafts_fil_35087b7")}</small></div>
      <button type="button" className="quiet-button" disabled={Boolean(busy) || !hub} title={hub ? undefined : t('hub.localServerRequired')} onClick={() => openEditor(emptyDraft())}><Plus size={13} />{" "}{t("ui.ServerManagement.ServerManagement.add_server_1099b2a")}</button>
    </div>
    <div className="server-management-list">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={event => void onDragEnd(event)}>
      <SortableContext items={ordered.filter(profile => profile.id !== hub?.id).map(profile => profile.id)} strategy={verticalListSortingStrategy}>
      {ordered.map(profile => {
        const current = profile.id === activeProfileId
        const working = busy === `switch:${profile.id}` || switchingProfileId === profile.id
        const rowActivationError = activationError?.profileId === profile.id ? activationError.message : null
        const details = [profile.serverIdentity ? t("ui.ServerManagement.identity_96fbbb0", { "id": String(profile.serverIdentity) }) : '', profile.serverVersion ? `AgentsServer ${profile.serverVersion}` : ''].filter(Boolean).join(' · ')
        const removableActive = current && hub !== null && isHubRemote(profile.serverUrl)
        const starting = busy === `start:${profile.id}`
        const hubDown = profile.id === hub?.id && (profile.connectionState === 'offline' || profile.connectionState === 'retrying')
        const work = rowWork[profile.id]
        return <SortableServerRow key={profile.id} profile={profile} pinned={profile.id === hub?.id} disabled={Boolean(busy)} className={`server-management-row${current ? ' active' : ''}`}>
          <span className={`server-connection-dot ${profile.connectionState}`} title={connectionLabel(profile)} role="img" aria-label={connectionLabel(profile)} />
          <div className="server-management-copy">
            <strong>{profile.name}{current && <span>{t("ui.ServerManagement.active_9234069")}</span>}</strong>
            <small>{profile.sshHost || profile.serverUrl}</small>
            {(details || profile.lastConnectionError || rowActivationError) && <small className={rowActivationError || profile.lastConnectionError ? profile.connectionState === 'degraded' && !rowActivationError ? 'server-management-warning' : 'server-management-error' : ''}>
              {rowActivationError || profile.lastConnectionError || details}
            </small>}
            {work && <div className="server-management-work">
              <small className={work.failed ? 'server-management-error' : ''} role={work.failed ? 'alert' : 'status'}>{work.text}</small>
              {/* Apart from the Redeploy icon, so a double click there cannot confirm. */}
              {work.confirm && <>
                <button type="button" className="danger-button compact" onClick={() => void redeploy(profile, true)}>{t('hub.redeployAnyway')}</button>
                <button type="button" className="quiet-button" onClick={() => noteRow(profile.id, null)}>{t('editor.cancel')}</button>
              </>}
            </div>}
          </div>
          <div className="server-management-actions">
            {(hubDown || starting) && <button type="button" className="quiet-button" aria-label={t('hub.startLabel', { server: profile.name })} disabled={Boolean(busy)} onClick={() => void startHub(profile.id)}>{starting && <LoaderCircle className="spin" size={12} />} {starting ? t('hub.starting') : t('hub.start')}</button>}
            {!current && <button type="button" className="quiet-button" aria-label={working ? t("ui.ServerManagement.switching_to_e7437c0", { "server": String(profile.name) }) : t("ui.ServerManagement.use_367b9be", { "server": String(profile.name) })} disabled={Boolean(busy) || Boolean(switchingProfileId)} onClick={() => void activate(profile.id)}>{working && <LoaderCircle className="spin" size={12} />} {working ? t("ui.ServerManagement.switching_b7b9fbf") : t("ui.ServerManagement.use_c36d819")}</button>}
            <button type="button" className="icon-button" aria-label={t("ui.ServerManagement.edit_966e044", { "server": String(profile.name) })} disabled={Boolean(busy)} onClick={() => beginEdit(profile)}><Pencil size={13} /></button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger className="icon-button" aria-label={t('runtimeUpdate.menuLabel', { server: profile.name })} title={t('runtimeUpdate.update')} disabled={Boolean(busy) || work?.working}>
                {work?.kind === 'cli' && work.working ? <LoaderCircle className="spin" size={12} /> : <Download size={13} />}
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu-content" align="end" sideOffset={4}>
                  <DropdownMenu.Item className="menu-item" onSelect={() => void updateCli(profile, 'claude')}>{t('runtimeUpdate.claude')}</DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" onSelect={() => void updateCli(profile, 'codex')}>{t('runtimeUpdate.codex')}</DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            {hub && isHubRemote(profile.serverUrl) && <button
              type="button"
              className="icon-button"
              aria-label={t('hub.redeployLabel', { server: profile.name })}
              title={t('hub.redeployTitle')}
              disabled={Boolean(busy) || redeploying || work?.working}
              onClick={() => void redeploy(profile, false)}
            >{work?.kind === 'redeploy' && work.working ? <LoaderCircle className="spin" size={12} /> : <RotateCw size={13} />}</button>}
            {profile.id !== hub?.id && <button
              type="button"
              className={confirmRemoveId === profile.id ? 'danger-button compact' : 'icon-button'}
              aria-label={current && !removableActive ? t("ui.ServerManagement.cannot_remove_active_server_b699625", { "server": String(profile.name) }) : t("ui.ServerManagement.remove_6f8460e", { "filename": String(profile.name) })}
              title={removableActive ? t('hub.removeActiveRemote', { hub: hub.name }) : current ? t("ui.ServerManagement.switch_to_another_server_before_removing_t_1ed6f7e") : t('hub.removeServer')}
              disabled={(current && !removableActive) || Boolean(busy)}
              onClick={() => void remove(profile)}
            >{working ? <LoaderCircle className="spin" size={12} /> : confirmRemoveId === profile.id ? 'Confirm' : <Trash2 size={13} />}</button>}
          </div>
        </SortableServerRow>
      })}
      </SortableContext>
      </DndContext>
    </div>
    {hubHasToken && <div className="server-management-pairing">
      <small>{t('hub.pairing.title')}</small>
      <code>{pairingUrl ?? t('hub.pairing.unavailable')}</code>
      <button type="button" className="quiet-button" onClick={() => void copyToken()}>{tokenCopied ? t('hub.pairing.copied') : t('hub.pairing.copyToken')}</button>
    </div>}
    {draft && <div ref={editorRef} className="server-management-editor">
      <div className="server-management-editor-heading">
        <div><strong>{draft.profileId ? t("ui.ServerManagement.ServerManagement.edit_966e044", { "server": String(editedProfile?.name || 'server') }) : t("ui.ServerManagement.ServerManagement.add_server_1099b2a")}</strong><small>{t("ui.ServerManagement.ServerManagement.connection_credentials_stay_in_this_mac_s__d4f7858")}</small></div>
        <button type="button" className="icon-button" aria-label={t("ui.ServerManagement.ServerManagement.close_server_editor_0b6523b")} disabled={Boolean(busy)} onClick={() => setDraft(null)}><XIcon /></button>
      </div>
      {draft.profileId ? <>
        <label><span>{t('serverProfile.nameOnThisMac')}</span><input ref={nameInputRef} value={draft.name} onChange={event => updateDraft({ name: event.target.value })} placeholder={t("ui.ServerManagement.ServerManagement.production_home_mac_lab_b241246")} title={t('serverProfile.localNameHint')} /></label>
        {editedProfile?.serverIdentity && editedProfile.lastConnectionError?.includes('Server identity changed') && <label className="checkbox-row server-identity-confirm"><input type="checkbox" checked={draft.resetServerIdentity} onChange={event => updateDraft({ resetServerIdentity: event.target.checked })} />{t("ui.ServerManagement.ServerManagement.i_confirm_this_url_may_establish_a_new_ser_9c3f4d1")}</label>}
      </> : <>
        <div className="segmented server-add-mode" role="group" aria-label={t('sshTunnel.mode')}>
          <button type="button" className={draft.mode === 'deploy' ? 'active' : ''} aria-pressed={draft.mode === 'deploy'} disabled={busy === 'deploy'} onClick={() => updateDraft({ mode: 'deploy' })}>{t('sshTunnel.modeDeploy')}</button>
          <button type="button" className={draft.mode === 'attach' ? 'active' : ''} aria-pressed={draft.mode === 'attach'} disabled={busy === 'deploy'} onClick={() => updateDraft({ mode: 'attach' })}>{t('sshTunnel.modeAttach')}</button>
        </div>
        <label><span>{t('sshTunnel.host')}</span><div className="input-with-icon"><Server size={14} /><input ref={nameInputRef} value={draft.sshHost} disabled={busy === 'deploy'} onChange={event => updateDraft({ sshHost: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void deploy() } }} placeholder="osmo_9000 or user@host" autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} /></div></label>
        <p className="field-hint">{t(draft.mode === 'attach' ? 'sshTunnel.attachHint' : 'sshTunnel.hostHint')}</p>
        <label><span>{t('sshTunnel.installDir')}</span><input value={draft.installDir} disabled={busy === 'deploy'} onChange={event => updateDraft({ installDir: event.target.value })} title={t('sshTunnel.installDirHint')} autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} /></label>
        <label><span>{t('serverProfile.nameOnThisMac')}</span><input value={draft.name} disabled={busy === 'deploy'} onChange={event => updateDraft({ name: event.target.value })} placeholder={draft.sshHost.trim() || t("ui.ServerManagement.ServerManagement.production_home_mac_lab_b241246")} title={t('serverProfile.localNameHint')} /></label>
        {deployProgress.length > 0 && <div className="server-setup-progress" role="log">
          {deployProgress.slice(-12).map((item, index, visible) => <div key={`${item.phase}-${deployProgress.length - visible.length + index}`} className={item.phase === 'complete' ? 'complete' : ''}>{item.phase === 'complete' || index < visible.length - 1 ? <Check size={13} /> : busy === 'deploy' ? <LoaderCircle className="spin" size={13} /> : <Clock3 size={13} />}<span>{item.message}</span></div>)}
        </div>}
      </>}
      {editorError && <div className="server-management-test error" role="alert"><Wifi size={14} /><span>{editorError}</span></div>}
      <footer>
        <span className="dialog-spacer" />
        <button type="button" className="quiet-button" disabled={Boolean(busy) && busy !== 'deploy'} onClick={() => { if (busy === 'deploy') void window.agentsDock.remoteServers.cancel(); else setDraft(null) }}>{t("ui.ServerManagement.ServerManagement.cancel_19766ed")}</button>
        {draft.profileId
          ? <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void save()}>{busy === 'save' && <LoaderCircle className="spin" size={13} />} {t("ui.ServerManagement.ServerManagement.save_1509f56")}</button>
          : <button type="button" className="primary-button" disabled={Boolean(busy) || !draft.sshHost.trim()} onClick={() => void deploy()}>{busy === 'deploy' ? <><LoaderCircle className="spin" size={13} />{' '}{t(draft.mode === 'attach' ? 'sshTunnel.attaching' : 'sshTunnel.deploying')}</> : t("ui.ServerManagement.ServerManagement.add_switch_90143f7")}</button>}
      </footer>
    </div>}
  </section>
}

function XIcon() {
  useLocale()
  return <span aria-hidden="true">×</span>
}

function connectionLabel(profile: PublicServerProfile): string {
  if (profile.lastConnectionError && /\b(?:401|403|unauthori[sz]ed|forbidden|authentication|access token|bad token|invalid token)\b/i.test(profile.lastConnectionError)) {
    return t("ui.ServerManagement.connectionLabel.authentication_required_097678f", { "detail": String(profile.lastConnectionError) })
  }
  const label = profile.connectionState.charAt(0).toUpperCase() + profile.connectionState.slice(1)
  return profile.lastConnectionError ? `${label}: ${profile.lastConnectionError}` : label
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
