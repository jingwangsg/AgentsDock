// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, Clock3, LoaderCircle, Pencil, Plus, Server, Trash2, Wifi } from 'lucide-react'
import type { PublicServerProfile, ServerSetupProgress } from '@shared/types'
import { DEFAULT_SERVER_URL } from '@shared/server-url'
import { trackEvent } from '../lib/analytics'
import { useAppStore } from '../store/app-store'
import { captureWorkspaceScope } from '../lib/workspace-preferences'

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

/** Remote profiles are proxied through the local hub as `${DEFAULT_SERVER_URL}/api/remote/<id>`. */
const hubRemoteId = (url: string) => /\/api\/remote\/([A-Za-z0-9_-]+)$/.exec(url)?.[1] ?? null

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
  const editorRef = useRef<HTMLDivElement | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const revealEditor = useRef(false)

  const hub = profiles.find(profile => profile.serverUrl === DEFAULT_SERVER_URL) ?? null
  // Remotes are registered on the hub, so adding/removing them only works while the hub is the active server.
  const hubActive = Boolean(hub && hub.id === activeProfileId)

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
    if (!hubActive) {
      setEditorError(t('hub.switchToLocalFirst'))
      return
    }
    setBusy('deploy')
    setDeployProgress([])
    let added = false
    try {
      const scope = captureWorkspaceScope(useAppStore.getState())
      if (!scope) throw new Error('The active server profile is still loading. Retry in a moment.')
      const input = { sshHost: host, installDir: draft.installDir.trim() || undefined, name: draft.name.trim() || undefined }
      const profile = draft.mode === 'attach'
        ? await window.agentsDock.remoteServers.attach(scope, input)
        : await window.agentsDock.remoteServers.deploy(scope, input)
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

  const move = async (profileId: string, direction: -1 | 1) => {
    const index = profiles.findIndex(profile => profile.id === profileId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= profiles.length) return
    const order = profiles.map(profile => profile.id)
    ;[order[index], order[target]] = [order[target], order[index]]
    setBusy(`move:${profileId}`)
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
    if (profile.id === activeProfileId) return
    if (confirmRemoveId !== profile.id) {
      setConfirmRemoveId(profile.id)
      return
    }
    const remoteId = hubRemoteId(profile.serverUrl)
    if (remoteId && !hubActive) {
      useAppStore.getState().setError(t('hub.switchToLocalFirst'))
      return
    }
    setBusy(`remove:${profile.id}`)
    try {
      if (remoteId) {
        const scope = captureWorkspaceScope(useAppStore.getState())
        if (!scope) throw new Error('The active server profile is still loading. Retry in a moment.')
        await window.agentsDock.remoteServers.remove(scope, remoteId)
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
      <button type="button" className="quiet-button" disabled={Boolean(busy) || !hubActive} title={hubActive ? undefined : t('hub.switchToLocalFirst')} onClick={() => openEditor(emptyDraft())}><Plus size={13} />{" "}{t("ui.ServerManagement.ServerManagement.add_server_1099b2a")}</button>
    </div>
    <div className="server-management-list">
      {profiles.map((profile, index) => {
        const current = profile.id === activeProfileId
        const working = busy === `switch:${profile.id}` || switchingProfileId === profile.id
        const rowActivationError = activationError?.profileId === profile.id ? activationError.message : null
        const details = [profile.serverIdentity ? t("ui.ServerManagement.identity_96fbbb0", { "id": String(profile.serverIdentity) }) : '', profile.serverVersion ? `AgentsServer ${profile.serverVersion}` : ''].filter(Boolean).join(' · ')
        const remoteLocked = !hubActive && hubRemoteId(profile.serverUrl) !== null
        const starting = busy === `start:${profile.id}`
        const hubDown = profile.id === hub?.id && (profile.connectionState === 'offline' || profile.connectionState === 'retrying')
        return <div className={`server-management-row${current ? ' active' : ''}`} key={profile.id}>
          <span className={`server-connection-dot ${profile.connectionState}`} title={connectionLabel(profile)} role="img" aria-label={connectionLabel(profile)} />
          <div className="server-management-copy">
            <strong>{profile.name}{current && <span>{t("ui.ServerManagement.active_9234069")}</span>}</strong>
            <small>{profile.sshHost || profile.serverUrl}</small>
            {(details || profile.lastConnectionError || rowActivationError) && <small className={rowActivationError || profile.lastConnectionError ? profile.connectionState === 'degraded' && !rowActivationError ? 'server-management-warning' : 'server-management-error' : ''}>
              {rowActivationError || profile.lastConnectionError || details}
            </small>}
          </div>
          <div className="server-management-actions">
            <button type="button" className="icon-button" aria-label={t("ui.ServerManagement.move_up_0bca820", { "server": String(profile.name) })} disabled={index === 0 || Boolean(busy)} onClick={() => void move(profile.id, -1)}><ArrowUp size={13} /></button>
            <button type="button" className="icon-button" aria-label={t("ui.ServerManagement.move_down_c5ebfeb", { "server": String(profile.name) })} disabled={index === profiles.length - 1 || Boolean(busy)} onClick={() => void move(profile.id, 1)}><ArrowDown size={13} /></button>
            {(hubDown || starting) && <button type="button" className="quiet-button" aria-label={t('hub.startLabel', { server: profile.name })} disabled={Boolean(busy)} onClick={() => void startHub(profile.id)}>{starting && <LoaderCircle className="spin" size={12} />} {starting ? t('hub.starting') : t('hub.start')}</button>}
            {!current && <button type="button" className="quiet-button" aria-label={working ? t("ui.ServerManagement.switching_to_e7437c0", { "server": String(profile.name) }) : t("ui.ServerManagement.use_367b9be", { "server": String(profile.name) })} disabled={Boolean(busy) || Boolean(switchingProfileId)} onClick={() => void activate(profile.id)}>{working && <LoaderCircle className="spin" size={12} />} {working ? t("ui.ServerManagement.switching_b7b9fbf") : t("ui.ServerManagement.use_c36d819")}</button>}
            <button type="button" className="icon-button" aria-label={t("ui.ServerManagement.edit_966e044", { "server": String(profile.name) })} disabled={Boolean(busy)} onClick={() => beginEdit(profile)}><Pencil size={13} /></button>
            {profile.id !== hub?.id && <button
              type="button"
              className={confirmRemoveId === profile.id ? 'danger-button compact' : 'icon-button'}
              aria-label={current ? t("ui.ServerManagement.cannot_remove_active_server_b699625", { "server": String(profile.name) }) : t("ui.ServerManagement.remove_6f8460e", { "filename": String(profile.name) })}
              title={current ? t("ui.ServerManagement.switch_to_another_server_before_removing_t_1ed6f7e") : remoteLocked ? t('hub.switchToLocalFirst') : t("ui.ServerManagement.remove_saved_server_cached_chats_are_prese_3fae6c2")}
              disabled={current || remoteLocked || Boolean(busy)}
              onClick={() => void remove(profile)}
            >{working ? <LoaderCircle className="spin" size={12} /> : confirmRemoveId === profile.id ? 'Confirm' : <Trash2 size={13} />}</button>}
          </div>
        </div>
      })}
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
