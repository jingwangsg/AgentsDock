import { Copy, LoaderCircle, Play, Square, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { InferenceProxyStatus } from '@shared/types'
import { t, useLocale } from '../lib/i18n'

type Copied = 'endpoint' | 'token'

/**
 * Settings → NV Inference Hub: the proxy on this machine that holds the upstream API keys. Chats on
 * the local hub and on every remote server reach it at 127.0.0.1:<port> with the proxy token.
 */
export function InferenceHubSettings() {
  useLocale()
  const fieldId = useId()
  const [status, setStatus] = useState<InferenceProxyStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [portDraft, setPortDraft] = useState('')
  const [copied, setCopied] = useState<Copied | null>(null)
  const keyNameRef = useRef<HTMLInputElement>(null)
  const keyValueRef = useRef<HTMLInputElement>(null)
  const requestRef = useRef(0)
  const mountedRef = useRef(true)
  // Reset on every mount: StrictMode in development mounts, unmounts and mounts again.
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])

  // One request at a time owns the page; the result of a superseded or unmounted one is dropped.
  const perform = async (label: string, action: () => Promise<InferenceProxyStatus>, onDone?: (next: InferenceProxyStatus) => void) => {
    const id = ++requestRef.current
    const current = () => mountedRef.current && id === requestRef.current
    setBusy(label)
    setError(null)
    try {
      const next = await action()
      if (!current()) return
      setStatus(next)
      setPortDraft(String(next.port))
      onDone?.(next)
    } catch (failure) {
      if (current()) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (current()) setBusy(null)
    }
  }
  useEffect(() => { void perform('load', () => window.agentsDock.inferenceProxy.status()) }, [])

  const portValue = Number(portDraft)
  const portChanged = status !== null && Number.isInteger(portValue) && portValue >= 1024 && portValue <= 65535 && portValue !== status.port
  const savePort = (port: number) => perform('port', () => window.agentsDock.inferenceProxy.setPort(port), next => setNotice(t('inferenceHub.portSaved', { port: next.port })))
  const addKey = () => {
    const name = keyNameRef.current?.value.trim() ?? ''
    const apiKey = keyValueRef.current?.value.trim() ?? ''
    if (!name || !apiKey) return
    void perform('add', () => window.agentsDock.inferenceProxy.addKey(name, apiKey), () => {
      if (keyNameRef.current) keyNameRef.current.value = ''
      if (keyValueRef.current) keyValueRef.current.value = ''
    })
  }
  const copy = async (what: Copied) => {
    if (!status) return
    try {
      if (what === 'endpoint') await window.agentsDock.native.writeClipboard(status.baseUrl)
      else if (!await window.agentsDock.inferenceProxy.copyProxyToken()) return
      if (!mountedRef.current) return
      setCopied(what)
      setTimeout(() => { if (mountedRef.current) setCopied(current => current === what ? null : current) }, 1500)
    } catch (failure) {
      if (mountedRef.current) setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const serviceText = !status ? ''
    : status.service === 'not-installed' ? t('inferenceHub.notInstalled', { path: status.plistFile })
    : status.service === 'stopped' ? t('inferenceHub.stopped')
    : status.healthy ? t('inferenceHub.running', { port: status.port })
    : t('inferenceHub.unhealthy', { port: status.port })
  const remoteText = !status ? ''
    : !status.localHubInstalled ? t('inferenceHub.remoteNoHub')
    : status.hubForwardPort === status.port ? t('inferenceHub.remoteForwarded', { port: status.port })
    : status.hubForwardPort === null ? t('inferenceHub.remoteNotForwarded')
    : t('inferenceHub.remoteMismatch', { port: status.hubForwardPort })

  return <section className="app-settings-section inference-hub-settings" aria-labelledby="app-settings-inference-hub-title" aria-busy={busy !== null}>
    <header><h2 id="app-settings-inference-hub-title">{t('settings.inferenceHub')}</h2></header>
    {!status && !error && <LoaderCircle className="spin" size={15} aria-hidden="true" />}
    {status && <>
      <div className="app-settings-list">
        <div className="app-settings-row">
          <div className="app-settings-row-copy"><strong>{t('inferenceHub.service')}</strong><span role="status">{serviceText}</span></div>
          <div className="app-settings-actions">
            {status.service === 'stopped' && <button type="button" className="primary-button" disabled={busy !== null} onClick={() => void perform('start', () => window.agentsDock.inferenceProxy.start())}>
              {busy === 'start' ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />}{busy === 'start' ? t('inferenceHub.starting') : t('inferenceHub.start')}
            </button>}
            {status.service === 'running' && <button type="button" className="quiet-button" disabled={busy !== null} onClick={() => void perform('stop', () => window.agentsDock.inferenceProxy.stop())}>
              {busy === 'stop' ? <LoaderCircle className="spin" size={13} /> : <Square size={13} />}{busy === 'stop' ? t('inferenceHub.stopping') : t('inferenceHub.stop')}
            </button>}
          </div>
        </div>
        <form className="app-settings-row" onSubmit={event => { event.preventDefault(); if (portChanged) void savePort(portValue) }}>
          <div className="app-settings-row-copy"><label className="app-settings-row-title" htmlFor={`${fieldId}-port`}>{t('inferenceHub.port')}</label><span>{t('inferenceHub.portHelp')}</span></div>
          <div className="app-settings-actions">
            <input id={`${fieldId}-port`} className="inference-hub-input inference-hub-port" type="number" inputMode="numeric" min={1024} max={65535} value={portDraft} disabled={busy !== null} onChange={event => setPortDraft(event.currentTarget.value)} />
            <button type="submit" className="quiet-button" disabled={!portChanged || busy !== null}>{busy === 'port' ? t('inferenceHub.saving') : t('inferenceHub.save')}</button>
          </div>
        </form>
        <div className="app-settings-row">
          <div className="app-settings-row-copy"><strong>{t('inferenceHub.endpoint')}</strong><span>{t('inferenceHub.endpointHelp')}</span></div>
          <div className="app-settings-actions">
            <code>{status.baseUrl}</code>
            <button type="button" className="quiet-button" aria-label={t('inferenceHub.copyEndpoint')} onClick={() => void copy('endpoint')}><Copy size={13} />{copied === 'endpoint' ? t('inferenceHub.copied') : t('inferenceHub.copy')}</button>
          </div>
        </div>
        <div className="app-settings-row">
          <div className="app-settings-row-copy"><strong>{t('inferenceHub.proxyToken')}</strong><span>{status.hasProxyToken ? t('inferenceHub.proxyTokenHelp') : t('inferenceHub.proxyTokenMissing')}</span></div>
          <div className="app-settings-actions">
            {status.hasProxyToken && <button type="button" className="quiet-button" aria-label={t('inferenceHub.copyProxyToken')} onClick={() => void copy('token')}><Copy size={13} />{copied === 'token' ? t('inferenceHub.copied') : t('inferenceHub.copy')}</button>}
          </div>
        </div>
        <div className="app-settings-row">
          <strong className="app-settings-row-title">{t('inferenceHub.upstream')}</strong>
          <code className="app-settings-value">{status.upstreamBaseUrl}</code>
        </div>
        <div className="app-settings-row">
          <div className="app-settings-row-copy"><strong>{t('inferenceHub.remoteServers')}</strong><span>{remoteText}</span></div>
          <div className="app-settings-actions">
            {status.localHubInstalled && status.hubForwardPort !== status.port && <button type="button" className="quiet-button" disabled={busy !== null} onClick={() => void savePort(status.port)}>{busy === 'port' ? t('inferenceHub.saving') : t('inferenceHub.enableRemote')}</button>}
          </div>
        </div>
        <div className="app-settings-row">
          <strong className="app-settings-row-title">{t('inferenceHub.configFile')}</strong>
          <code className="app-settings-value">{status.configFile}</code>
        </div>
      </div>
      {notice && <p className="app-settings-server-notice" role="status">{notice}</p>}

      <h3>{t('inferenceHub.keys')}</h3>
      <p className="inference-hub-help">{t('inferenceHub.keysHelp')}</p>
      {status.keys.length === 0 && <p className="inference-hub-help">{t('inferenceHub.noKeys')}</p>}
      <ul className="app-settings-list inference-hub-keys">
        {status.keys.map(key => <li key={key.name} className="app-settings-row">
          <div className="app-settings-row-copy"><strong>{key.name}</strong><span><code>••••{key.hint}</code></span></div>
          <div className="app-settings-actions">
            <label className="inference-hub-toggle">
              <input type="checkbox" checked={key.enabled} disabled={busy !== null} aria-label={t('inferenceHub.enableKey', { name: key.name })} onChange={event => {
                const enabled = event.currentTarget.checked
                void perform('key', () => window.agentsDock.inferenceProxy.setKeyEnabled(key.name, enabled))
              }} />
              {t('inferenceHub.keyEnabled')}
            </label>
            <button type="button" className="quiet-button" disabled={busy !== null} aria-label={t('inferenceHub.removeKey', { name: key.name })} onClick={() => void perform('remove', () => window.agentsDock.inferenceProxy.removeKey(key.name))}><Trash2 size={13} /></button>
          </div>
        </li>)}
      </ul>
      <form className="inference-hub-add-key" onSubmit={event => { event.preventDefault(); addKey() }}>
        <input ref={keyNameRef} className="inference-hub-input" type="text" autoComplete="off" spellCheck={false} placeholder={t('inferenceHub.keyName')} aria-label={t('inferenceHub.keyName')} disabled={busy !== null} />
        <input ref={keyValueRef} className="inference-hub-input" type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" placeholder={t('inferenceHub.keyValue')} aria-label={t('inferenceHub.keyValue')} disabled={busy !== null} />
        <button type="submit" className="primary-button" disabled={busy !== null}>{busy === 'add' ? t('inferenceHub.adding') : t('inferenceHub.addKey')}</button>
      </form>
    </>}
    {error && <p className="app-settings-server-notice error" role="alert">{error}</p>}
  </section>
}
