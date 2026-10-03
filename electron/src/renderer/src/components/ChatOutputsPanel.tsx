// Floating "Outputs & sources" card for one chat, anchored to the top-right of its workspace.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useRef, useState, type ComponentType } from 'react'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { Copy, Download, FileDiff, FileText, FolderOpen, Frame, Globe, Image, MessageSquare, Paperclip, Plug, Search, Sparkles, X } from 'lucide-react'
import type { ChatOutputsSummary } from '@shared/chat-outputs'
import { isPreviewableFile } from '@shared/file-content-type'
import { saveAgentFile } from '../lib/file-actions'
import type { CodeReviewTarget } from '../lib/unified-diff'
import { timelineCount } from '../lib/timeline-labels'
import { useTransientClose } from '../lib/transient-close'
import { requestOpenAgentFile } from '../lib/workspace-file-links'
import { useAppStore } from '../store/app-store'

const COLLAPSED_SOURCE_ROWS = 6
const REFRESH_DEBOUNCE_MS = 1_000

export function ChatOutputsPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  useLocale()
  const [summary, setSummary] = useState<ChatOutputsSummary | null>(null)
  const [allSources, setAllSources] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const firstLoad = useRef(true)
  // The pointer-down that dismisses a row menu, or picks an item in its portal, must not also close this card.
  const menuOpen = useRef(false)
  const events = useAppStore(state => state.snapshots[sessionId]?.events)
  // Registered so the app-level Escape closes only this card, not the surface beneath it as well.
  useTransientClose(true, onClose)

  useEffect(() => {
    let stale = false
    // The first load is immediate; later event batches (including history_rewound) are coalesced so a streaming turn does not refetch per token.
    const timer = window.setTimeout(() => {
      window.agentsDock.chat.outputs(sessionId)
        .then(next => { if (!stale) setSummary(next) })
        // A disconnected profile rejects; the card simply keeps what it last showed.
        .catch(() => undefined)
    }, firstLoad.current ? 0 : REFRESH_DEBOUNCE_MS)
    firstLoad.current = false
    return () => { stale = true; window.clearTimeout(timer) }
  }, [events, sessionId])

  useEffect(() => {
    // An open row menu handles Escape first (capture phase) and marks it handled.
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) onClose() }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      // The header toggle closes the card itself; closing here too would reopen it on the same click.
      if (menuOpen.current || panelRef.current?.contains(target) || target?.closest('[data-chat-outputs-toggle]')) return
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [onClose])

  const findEvent = (eventId: string) => window.dispatchEvent(new CustomEvent('agentsdock:find-event', { detail: { sessionId, eventId } }))
  const trackMenu = (open: boolean) => { menuOpen.current = open }
  const reportFailure = (operation: Promise<unknown>) => void operation.catch(error => useAppStore.getState().setError(error instanceof Error ? error.message : String(error)))
  const copyPath = (path: string): RowAction => ({ icon: Copy, label: t('chatOutputs.copyPath'), onSelect: () => reportFailure(window.agentsDock.native.writeClipboard(path)) })
  const sources = summary?.sources ?? []
  const visibleSources = allSources ? sources : sources.slice(0, COLLAPSED_SOURCE_ROWS)

  return <div ref={panelRef} className="chat-outputs-panel" role="dialog" aria-label={t('chatOutputs.title')}>
    <header>
      <strong>{t('chatOutputs.title')}</strong>
      <button type="button" className="icon-button" aria-label={t('chatOutputs.close')} onClick={onClose}><X size={14} /></button>
    </header>
    {summary && <>
      <section aria-label={t('chatOutputs.outputs')}>
        <h3>{t('chatOutputs.outputs')}</h3>
        {summary.outputs.length === 0 && <p className="chat-outputs-empty">{t('chatOutputs.noOutputs')}</p>}
        {summary.outputs.map(item => {
          switch (item.kind) {
            case 'canvas':
              return <Row key={`canvas:${item.path}`} icon={Frame} label={item.label} secondary={t('chatOutputs.canvas')}
                onClick={() => window.dispatchEvent(new CustomEvent('agentsdock:open-canvas', { detail: { sessionId, path: item.path } }))}
                actions={[copyPath(item.path)]} onMenuOpenChange={trackMenu} />
            case 'artifact': {
              const previewable = isPreviewableFile({ filename: item.filename, content_type: item.contentType })
              const extension = /\.([a-z0-9]+)$/i.exec(item.filename)?.[1]
              // Its absolute path on the server, as the timeline card copies it.
              const path = item.file.source_path || item.file.path
              return <Row key={`artifact:${item.eventId}:${item.filename}`} icon={previewable ? Image : FileText} label={item.label}
                secondary={previewable ? t('chatOutputs.generatedImage') : extension ? t('chatOutputs.fileWithExt', { ext: extension.toUpperCase() }) : t('chatOutputs.file')}
                onClick={() => requestOpenAgentFile(sessionId, item.file)}
                actions={[
                  ...(path ? [copyPath(path)] : []),
                  { icon: Download, label: t('chatOutputs.download'), onSelect: () => void saveAgentFile(sessionId, item.file) },
                  { icon: FolderOpen, label: t('chatOutputs.showInFolder'), onSelect: () => reportFailure(window.agentsDock.files.reveal(sessionId, item.file)) }
                ]} onMenuOpenChange={trackMenu} />
            }
            case 'local_preview':
              return <Row key={`preview:${item.host}`} icon={Globe} label={t('chatOutputs.localPreview')} secondary={item.host}
                onClick={() => void window.agentsDock.native.openExternal(item.url)} />
            case 'code_changes':
              return <Row key="code-changes" icon={FileDiff} label={timelineCount('editedFiles', item.filesChanged)} secondary={`+${item.additions} −${item.deletions}`}
                onClick={() => {
                  const target: CodeReviewTarget = { sessionId, ...item.review }
                  window.dispatchEvent(new CustomEvent<CodeReviewTarget>('agentsdock:review-diff', { detail: target }))
                }} />
          }
        })}
      </section>
      <section aria-label={t('chatOutputs.sources')}>
        <h3>{t('chatOutputs.sources')}</h3>
        {sources.length === 0 && <p className="chat-outputs-empty">{t('chatOutputs.noSources')}</p>}
        {visibleSources.map(item => {
          switch (item.kind) {
            case 'mcp':
              return <Row key={`mcp:${item.label}`} icon={Plug} label={item.label} secondary={timelineCount('mcpUses', item.count)} onClick={() => findEvent(item.eventId)} />
            case 'web_search':
              return <Row key="web-search" icon={Search} label={t('chatOutputs.webSearch')} secondary={timelineCount('webSearches', item.count)} onClick={() => findEvent(item.eventId)} />
            case 'web_fetch':
              return <Row key="web-fetch" icon={Globe} label={t('chatOutputs.webPages')} secondary={timelineCount('webPages', item.count)} onClick={() => findEvent(item.eventId)} />
            case 'skill':
              return <Row key={`skill:${item.label}`} icon={Sparkles} label={item.label} secondary={t('chatOutputs.skill')} onClick={() => findEvent(item.eventId)} />
            case 'chat_reference':
              return <Row key={`chat:${item.eventId}:${item.label}`} icon={MessageSquare} label={item.label} secondary={t('chatOutputs.referencedChat')} onClick={() => findEvent(item.eventId)} />
            case 'attached_file':
              return <Row key={`file:${item.eventId}:${item.label}`} icon={Paperclip} label={item.label} secondary={t('chatOutputs.attachedFile')} onClick={() => findEvent(item.eventId)} />
          }
        })}
        {sources.length > COLLAPSED_SOURCE_ROWS && <button type="button" className="chat-outputs-more" aria-expanded={allSources} onClick={() => setAllSources(value => !value)}>
          {allSources ? t('chatOutputs.showLess') : t('chatOutputs.viewAll', { count: sources.length })}
        </button>}
      </section>
    </>}
  </div>
}

type RowAction = { icon: ComponentType<{ size?: number }>; label: string; onSelect: () => void }

function Row({ icon: Icon, label, secondary, onClick, actions, onMenuOpenChange }: { icon: ComponentType<{ size?: number }>; label: string; secondary: string; onClick: () => void; actions?: RowAction[]; onMenuOpenChange?: (open: boolean) => void }) {
  const row = <button type="button" className="chat-outputs-row" title={label} onClick={onClick}>
    <Icon size={16} />
    <span><strong>{label}</strong><small>{secondary}</small></span>
  </button>
  if (!actions) return row
  return <ContextMenu.Root onOpenChange={onMenuOpenChange}>
    <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content className="menu-content">
        {actions.map(action => <ContextMenu.Item key={action.label} className="menu-item" onSelect={action.onSelect}><action.icon size={14} />{action.label}</ContextMenu.Item>)}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>
}
