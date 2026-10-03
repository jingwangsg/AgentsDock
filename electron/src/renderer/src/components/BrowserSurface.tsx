// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, LoaderCircle, RotateCw, X } from 'lucide-react'
import type { Surface } from '@shared/types'
import { browserAddressURL } from '../lib/surfaces'
import { useAppStore } from '../store/app-store'

/** A web page in an Electron <webview>; the main process strips preload and Node from it. */
export function BrowserSurface({ surface, active }: { surface: Surface; active: boolean }) {
  useLocale()
  const viewRef = useRef<WebviewElement | null>(null)
  const addressRef = useRef<HTMLInputElement | null>(null)
  // Later navigation goes through loadURL(); changing `src` would reload on every render.
  const [initialSrc] = useState(() => surface.url || 'about:blank')
  const [address, setAddress] = useState(surface.url ?? '')
  const [currentURL, setCurrentURL] = useState(surface.url ?? '')
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [partition, setPartition] = useState<string | null>(null)
  const [preparationAttempt, setPreparationAttempt] = useState(0)
  const [history, setHistory] = useState({ back: false, forward: false })

  useEffect(() => {
    let cancelled = false
    setFailure(null)
    void window.agentsDock.surfaces.prepareBrowser(surface.id).then(value => {
      if (!cancelled) setPartition(value)
    }).catch(error => {
      if (!cancelled) setFailure(String(error))
    })
    return () => { cancelled = true }
  }, [surface.id, preparationAttempt])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const navigated = (event: Event) => {
      const url = (event as Event & { url?: string }).url
      if (!url || url === 'about:blank') return
      setAddress(url)
      setCurrentURL(url)
      setFailure(null)
      setHistory({ back: view.canGoBack(), forward: view.canGoForward() })
      void useAppStore.getState().updateSurface(surface.id, { url })
    }
    const titled = (event: Event) => {
      const title = (event as Event & { title?: string }).title?.trim()
      if (title) void useAppStore.getState().updateSurface(surface.id, { page_title: title })
    }
    const started = () => setLoading(true)
    const stopped = () => setLoading(false)
    const failed = (event: Event) => {
      const detail = event as Event & { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean }
      // -3 is ERR_ABORTED: a newer navigation replaced this one.
      if (detail.errorCode === -3 || detail.isMainFrame === false) return
      setFailure(t('surface.browser.loadFailed', { url: detail.validatedURL ?? '', reason: detail.errorDescription || String(detail.errorCode ?? '') }))
    }
    view.addEventListener('did-navigate', navigated)
    view.addEventListener('did-navigate-in-page', navigated)
    view.addEventListener('page-title-updated', titled)
    view.addEventListener('did-start-loading', started)
    view.addEventListener('did-stop-loading', stopped)
    view.addEventListener('did-fail-load', failed)
    return () => {
      view.removeEventListener('did-navigate', navigated)
      view.removeEventListener('did-navigate-in-page', navigated)
      view.removeEventListener('page-title-updated', titled)
      view.removeEventListener('did-start-loading', started)
      view.removeEventListener('did-stop-loading', stopped)
      view.removeEventListener('did-fail-load', failed)
    }
  }, [surface.id, partition])

  useEffect(() => {
    if (active && !currentURL) addressRef.current?.focus()
  }, [active, currentURL])

  const navigate = (event: FormEvent) => {
    event.preventDefault()
    const url = browserAddressURL(address)
    const view = viewRef.current
    if (!url || !view) return
    setFailure(null)
    void view.loadURL(url).catch(() => undefined)
  }

  return <div className="browser-surface">
    <form className="browser-toolbar" onSubmit={navigate}>
      <button type="button" className="icon-button" aria-label={t('surface.browser.back')} disabled={!history.back} onClick={() => viewRef.current?.goBack()}><ArrowLeft size={15} /></button>
      <button type="button" className="icon-button" aria-label={t('surface.browser.forward')} disabled={!history.forward} onClick={() => viewRef.current?.goForward()}><ArrowRight size={15} /></button>
      <button type="button" className="icon-button" aria-label={loading ? t('surface.browser.stop') : t('surface.browser.reload')} disabled={!currentURL && !failure} onClick={() => !partition ? setPreparationAttempt(value => value + 1) : loading ? viewRef.current?.stop() : viewRef.current?.reload()}>
        {loading ? <X size={15} /> : <RotateCw size={15} />}
      </button>
      <input
        ref={addressRef}
        className="browser-address"
        aria-label={t('surface.browser.address')}
        placeholder={t('surface.browser.addressPlaceholder')}
        value={address}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        onChange={event => setAddress(event.target.value)}
        onFocus={event => event.target.select()}
      />
      {(loading || (!partition && !failure)) && <LoaderCircle className="spin browser-loading" size={14} aria-hidden="true" />}
      <button type="button" className="icon-button" aria-label={t('surface.browser.openExternal')} disabled={!currentURL} onClick={() => void window.agentsDock.native.openExternal(currentURL)}><ExternalLink size={15} /></button>
    </form>
    <div className="browser-view-frame">
      {partition && <webview ref={viewRef} className="browser-view" src={initialSrc} partition={partition} />}
      {!currentURL && <div className="browser-surface-empty">{t('surface.browser.empty')}</div>}
      {failure && <div className="browser-surface-notice" role="alert">{failure}</div>}
    </div>
  </div>
}
