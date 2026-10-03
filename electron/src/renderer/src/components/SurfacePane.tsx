// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useRef, useState } from 'react'
import { Globe, PanelLeft, SquareTerminal, X } from 'lucide-react'
import type { Surface } from '@shared/types'
import { surfaceSubline, surfaceTitle } from '../lib/surfaces'
import { useAppStore } from '../store/app-store'
import { BrowserSurface } from './BrowserSurface'
import { ShortcutTooltip } from './ShortcutTooltip'
import { TerminalSurface } from './TerminalSurface'

/** Every tab stays mounted so shells and pages survive switching; only the selected one is shown. */
export function SurfaceStack({ surfaces, selectedId, sidebarVisible, onSidebarToggle }: {
  surfaces: Surface[]
  selectedId: string | null
  sidebarVisible: boolean
  onSidebarToggle: () => void
}) {
  return <div className="surface-stack" hidden={!selectedId}>
    {surfaces.map(surface => <SurfacePane key={surface.id} surface={surface} active={surface.id === selectedId} sidebarVisible={sidebarVisible} onSidebarToggle={onSidebarToggle} />)}
  </div>
}

function SurfacePane({ surface, active, sidebarVisible, onSidebarToggle }: {
  surface: Surface
  active: boolean
  sidebarVisible: boolean
  onSidebarToggle: () => void
}) {
  useLocale()
  const displayTitle = surfaceTitle(surface)
  const [title, setTitle] = useState(displayTitle)
  const titleInput = useRef<HTMLInputElement | null>(null)
  useEffect(() => setTitle(displayTitle), [displayTitle])
  useEffect(() => {
    const rename = (event: Event) => {
      if ((event as CustomEvent<{ surfaceId?: string }>).detail?.surfaceId !== surface.id) return
      // The sidebar selects this tab first; focus once React has shown it.
      window.requestAnimationFrame(() => {
        titleInput.current?.focus()
        titleInput.current?.select()
      })
    }
    window.addEventListener('agentsdock:rename-surface', rename)
    return () => window.removeEventListener('agentsdock:rename-surface', rename)
  }, [surface.id])
  // An emptied field drops the rename, so the default title (page title or "Terminal") returns.
  const save = () => {
    const name = title.trim() || null
    if (name === surface.name) setTitle(displayTitle)
    else void useAppStore.getState().updateSurface(surface.id, { name })
  }
  const Icon = surface.kind === 'terminal' ? SquareTerminal : Globe
  return <div className="surface-pane" hidden={!active}>
    <header className="chat-header surface-header">
      <div className="title-block">
        <div className="editable-title">
          <Icon size={14} aria-hidden="true" />
          <input
            ref={titleInput}
            aria-label={t('surface.rename', { name: displayTitle })}
            value={title}
            size={Math.max(1, Array.from(title).length)}
            onChange={event => setTitle(event.target.value)}
            onBlur={save}
            onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
          />
        </div>
        <small>{surfaceSubline(surface)}</small>
      </div>
      <div className="header-actions">
        {!sidebarVisible && <ShortcutTooltip shortcut="toggleSidebar" label={t('ui.sidebar.showChatList')}><button className="icon-button" aria-label={t('ui.sidebar.showChatList')} onClick={onSidebarToggle}><PanelLeft size={16} /></button></ShortcutTooltip>}
        <ShortcutTooltip shortcut="closeSurface" label={t('surface.close')}><button className="icon-button" aria-label={t('surface.close')} onClick={() => void useAppStore.getState().removeSurface(surface.id)}><X size={16} /></button></ShortcutTooltip>
      </div>
    </header>
    {surface.kind === 'terminal'
      ? <TerminalSurface surface={surface} active={active} />
      : <BrowserSurface surface={surface} active={active} />}
  </div>
}
