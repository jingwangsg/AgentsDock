// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as ContextMenu from '@radix-ui/react-context-menu'
import {
  DndContext, DragOverlay, PointerSensor, closestCenter, pointerWithin, useDraggable, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent
} from '@dnd-kit/core'
import {
  Archive, ArchiveRestore, ArrowDown, ArrowUp, ChevronDown, ChevronRight, Download, Folder, FolderPlus, Globe, GripVertical, Inbox, LoaderCircle, MoreHorizontal,
  Columns2, History, PanelLeftClose, Pencil, Pin, PinOff, Plus, RefreshCw, Search, Settings, Share2, SquareTerminal, Trash2, Undo2, UsersRound, X
} from 'lucide-react'
import type { Session, Surface } from '@shared/types'
import { completedPrefixForkAvailable } from '@shared/session-fork'
import { localSessionImportSupported } from '@shared/local-session-import'
import { readyChatBackends } from '@shared/runtime-catalog'
import { trackEvent } from '../lib/analytics'
import { activeEmergencyAlert } from '../lib/emergency-alert'
import { backendLabel, shortRelativeTime, workingDirectoryTail } from '../lib/format'
import { openSessionHistoryResult } from '../lib/session-history-search'
import { TEAM_NETWORK_UI_ENABLED } from '../lib/team-network-ui'
import { rankSessionsForSearch, sidebarFolders } from '../lib/sessions'
import { surfaceSubline, surfaceTitle } from '../lib/surfaces'
import { getWorkspacePreference, setWorkspacePreference } from '../lib/workspace-preferences'
import { handleMenuCommand, selectMailHintPending, selectBulletinHintPending, sessionUnread, useAppStore } from '../store/app-store'
import { BackendMark } from './BackendMark'
import { ServerSelector } from './ServerSelector'
import { ShortcutTooltip } from './ShortcutTooltip'

interface Section { id: string; title: string; sessions: Session[]; surfaces: Surface[]; kind: 'pinned' | 'folder' | 'archived' | 'search' }
interface DropIndicator { id: string; placement: 'before' | 'after' | 'inside' }
interface DragItemData { type: 'session' | 'folder'; label?: string; section?: string }

export const SIDEBAR_LONG_PRESS = { delay: 280, tolerance: 6 } as const

export type SidebarDropOperation =
  | { kind: 'reorder-folder'; order: string[] }
  | { kind: 'move-session'; sessionId: string; folder: string }
  | { kind: 'reorder-session'; sessionId: string; targetId: string; placement: 'before' | 'after'; targetFolder?: string }

const sidebarCollisionDetection: CollisionDetection = (args) => {
  const activeType = args.active.data.current?.type
  const droppableContainers = activeType === 'folder'
    ? args.droppableContainers.filter(container => container.data.current?.type === 'folder')
    : args.droppableContainers
  const pointerHits = pointerWithin({ ...args, droppableContainers })
  if (pointerHits.length) {
    if (activeType !== 'session') return pointerHits
    const sessionHits = pointerHits.filter(hit => hit.data?.droppableContainer.data.current?.type === 'session')
    return sessionHits.length ? sessionHits : pointerHits
  }
  if (activeType === 'session') return []
  return closestCenter({ ...args, droppableContainers })
}

export function Sidebar({ hidden = false }: { hidden?: boolean }) {
  useLocale()
  const sessions = useAppStore(state => state.sessions)
  const surfaces = useAppStore(state => state.surfaces)
  const selectedSurfaceId = useAppStore(state => state.selectedSurfaceId)
  // While a terminal or browser tab is open, no chat row reads as selected.
  const selectedId = useAppStore(state => state.selectedSurfaceId ? null : state.selectedSessionId)
  const chatPanes = useAppStore(state => state.chatPanes)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const serverIdentity = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const creatingChat = useAppStore(state => state.creatingChat)
  const connected = useAppStore(state => state.connected)
  const newMailArrivals = useAppStore(selectMailHintPending)
  const newBulletinUpdates = useAppStore(selectBulletinHintPending)
  const folderOrder = useAppStore(state => state.folderOrder)
  const collapsed = useAppStore(state => state.collapsedFolders)
  const archivedCollapsed = useAppStore(state => state.archivedCollapsed)
  const chatCount = sessions.filter(session => !session.archived && !isHiddenRunChat(session, selectedId)).length
  const [dragging, setDragging] = useState<{ id: string; label: string; type: 'session' | 'folder' } | null>(null)
  const [drop, setDrop] = useState<DropIndicator | null>(null)
  const dropRef = useRef<DropIndicator | null>(null)
  const suppressClickRef = useRef<string | null>(null)
  const suppressClickTimer = useRef<number | null>(null)
  const sessionListRef = useRef<HTMLDivElement | null>(null)
  const sidebarScrollTop = useRef(0)
  const sidebarScrollingUntil = useRef(0)
  const sidebarScrollTimer = useRef<number | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: SIDEBAR_LONG_PRESS }))
  const sections = useMemo(() => buildSections(sessions, folderOrder, '', undefined, surfaces, selectedId), [sessions, folderOrder, surfaces, selectedId, getLocale()])
  const computedFolders = useMemo(() => sidebarFolders(sessions, folderOrder), [folderOrder, sessions])
  const stableFolders = useRef(computedFolders)
  if (!stringArraysEqual(stableFolders.current, computedFolders)) stableFolders.current = computedFolders
  const folders = stableFolders.current
  const suppressClick = useCallback((id: string) => suppressClickRef.current === id, [])
  const isSidebarScrolling = useCallback(() => Date.now() < sidebarScrollingUntil.current, [])

  useEffect(() => () => {
    if (suppressClickTimer.current != null) window.clearTimeout(suppressClickTimer.current)
  }, [])

  useEffect(() => {
    const profileId = activeProfileId
    const generation = profileGeneration
    const identity = serverIdentity
    const preferenceScope = profileId ? { profileId, profileGeneration: generation, serverIdentity: identity } : null
    let mounted = true
    const persist = () => setWorkspacePreference(preferenceScope, 'sidebarScrollTop:v1', sidebarScrollTop.current)
    void getWorkspacePreference(preferenceScope, 'sidebarScrollTop:v1', 0).then(value => {
      const current = useAppStore.getState()
      if (!mounted || current.activeProfileId !== profileId || current.profileGeneration !== generation || (current.profiles.find(profile => profile.id === current.activeProfileId)?.serverIdentity ?? null) !== identity || !sessionListRef.current) return
      const scrollTop = Number.isFinite(value) && value > 0 ? value : 0
      sidebarScrollTop.current = scrollTop
      sessionListRef.current.scrollTop = scrollTop
    }).catch(() => undefined)
    const flush = (event: Event) => {
      if (sidebarScrollTimer.current != null) window.clearTimeout(sidebarScrollTimer.current)
      sidebarScrollTimer.current = null
      const current = useAppStore.getState()
      if (current.activeProfileId !== profileId || current.profileGeneration !== generation || (current.profiles.find(profile => profile.id === current.activeProfileId)?.serverIdentity ?? null) !== identity) return
      const pending = persist()
      ;(event as CustomEvent<{ waitUntil?: (value: PromiseLike<unknown>) => void }>).detail?.waitUntil?.(pending)
    }
    window.addEventListener('agentsdock:flush-draft', flush)
    return () => {
      mounted = false
      window.removeEventListener('agentsdock:flush-draft', flush)
      if (sidebarScrollTimer.current != null) window.clearTimeout(sidebarScrollTimer.current)
      sidebarScrollTimer.current = null
      const current = useAppStore.getState()
      if (current.activeProfileId === profileId && current.profileGeneration === generation && (current.profiles.find(profile => profile.id === current.activeProfileId)?.serverIdentity ?? null) === identity) void persist().catch(() => undefined)
    }
  }, [activeProfileId, profileGeneration, serverIdentity])

  const rememberSidebarScroll = useCallback((scrollTop: number) => {
    sidebarScrollTop.current = scrollTop
    sidebarScrollingUntil.current = Date.now() + 250
    if (sidebarScrollTimer.current != null) return
    const profileId = activeProfileId
    const generation = profileGeneration
    const identity = serverIdentity
    const preferenceScope = profileId ? { profileId, profileGeneration: generation, serverIdentity: identity } : null
    const persistWhenIdle = () => {
      const remaining = sidebarScrollingUntil.current - Date.now()
      if (remaining > 0) {
        sidebarScrollTimer.current = window.setTimeout(persistWhenIdle, remaining)
        return
      }
      sidebarScrollTimer.current = null
      const current = useAppStore.getState()
      if (current.switchingProfileId || current.activeProfileId !== profileId || current.profileGeneration !== generation || (current.profiles.find(profile => profile.id === current.activeProfileId)?.serverIdentity ?? null) !== identity) return
      void setWorkspacePreference(preferenceScope, 'sidebarScrollTop:v1', sidebarScrollTop.current).catch(() => undefined)
    }
    sidebarScrollTimer.current = window.setTimeout(persistWhenIdle, 250)
  }, [activeProfileId, profileGeneration, serverIdentity])

  const updateDrop = (next: DropIndicator | null) => {
    dropRef.current = next
    setDrop(current => current?.id === next?.id && current?.placement === next?.placement ? current : next)
  }
  const finishDrag = () => {
    setDragging(null)
    updateDrop(null)
    if (suppressClickTimer.current != null) window.clearTimeout(suppressClickTimer.current)
    suppressClickTimer.current = window.setTimeout(() => {
      suppressClickRef.current = null
      suppressClickTimer.current = null
    }, 0)
  }

  const onDragStart = (event: DragStartEvent) => {
    if (switchingProfileId) return
    const data = event.active.data.current as DragItemData | undefined
    if (!data) return
    if (suppressClickTimer.current != null) window.clearTimeout(suppressClickTimer.current)
    suppressClickRef.current = String(event.active.id)
    setDragging({ id: String(event.active.id), label: data.label ?? '', type: data.type })
  }
  const onDragOver = (event: DragOverEvent) => {
    if (!event.over || event.active.id === event.over.id) { updateDrop(null); return }
    const activeData = event.active.data.current as DragItemData | undefined
    const overData = event.over.data.current as DragItemData | undefined
    if (activeData?.type === 'session' && overData?.type === 'folder') {
      updateDrop({ id: String(event.over.id), placement: 'inside' })
      return
    }
    if (
      activeData?.type === 'session'
      && overData?.type === 'session'
      && activeData.section !== overData.section
      && !folderFromSection(overData.section)
    ) {
      updateDrop(null)
      return
    }
    const translated = event.active.rect.current.translated
    const center = translated ? translated.top + translated.height / 2 : 0
    const placement = center < event.over.rect.top + event.over.rect.height / 2 ? 'before' : 'after'
    const overId = activeData?.type === 'folder' && overData?.type === 'session' && overData.section?.startsWith('folder:')
      ? overData.section
      : String(event.over.id)
    updateDrop({ id: overId, placement })
  }
  const onDragEnd = async (event: DragEndEvent) => {
    if (switchingProfileId) { finishDrag(); return }
    const operation = resolveSidebarDrop(
      String(event.active.id),
      event.active.data.current as DragItemData | undefined,
      event.over ? String(event.over.id) : null,
      event.over?.data.current as DragItemData | undefined,
      dropRef.current,
      folders
    )
    finishDrag()
    if (!operation) return
    if (operation.kind === 'reorder-folder') {
      useAppStore.getState().setFolderOrder(operation.order)
      trackEvent('folder_reordered')
    } else if (operation.kind === 'move-session') {
      await useAppStore.getState().updateSession(operation.sessionId, sidebarFolderAssignmentPatch(operation.folder))
    } else {
      try {
        const next = await window.agentsDock.sessions.reorder(
          operation.sessionId,
          operation.targetId,
          operation.placement,
          operation.targetFolder
        )
        useAppStore.setState({ sessions: next })
        trackEvent(sidebarReorderAnalyticsEvent(operation))
      } catch (error) { useAppStore.getState().setError(error instanceof Error ? error.message : String(error)) }
    }
  }

  return (
    <aside className="sidebar" aria-hidden={hidden} inert={hidden ? true : undefined}>
      <div className="sidebar-drag-region" />
      <div className="sidebar-topbar">
        <strong>AgentsDock</strong>
        <div className="toolbar-cluster">
          <ShortcutTooltip shortcut="toggleSidebar" label={t('ui.sidebar.hideChatList')}><button className="icon-button" aria-label={t('ui.sidebar.hideChatList')} onClick={() => window.dispatchEvent(new Event('agentsdock:toggle-sidebar'))}><PanelLeftClose size={15} /></button></ShortcutTooltip>
          <button className="icon-button" title={connected ? t("ui.Sidebar.Sidebar.refresh_0e91610") : t("ui.Sidebar.Sidebar.reconnect_bf8a9ea")} aria-label={connected ? t("ui.Sidebar.Sidebar.refresh_chats_bf904ec") : t("ui.Sidebar.Sidebar.reconnect_server_558abe3")} disabled={Boolean(switchingProfileId)} onClick={() => void useAppStore.getState().refreshSessions()}><RefreshCw size={15} /></button>
          <ShortcutTooltip shortcut="newChat"><button className="icon-button" aria-label={t("ui.Sidebar.Sidebar.new_chat_db18382")} disabled={Boolean(switchingProfileId) || creatingChat} onClick={() => void useAppStore.getState().requestNewChat()}><Plus size={17} /></button></ShortcutTooltip>
        </div>
      </div>
      <ServerSelector />
      <div className="sidebar-actions">
        {TEAM_NETWORK_UI_ENABLED && <button className="sidebar-action sidebar-action-labeled sidebar-team-network-action" title={t('teamNetwork.openBeta')} aria-label={t('teamNetwork.open')} aria-describedby={newMailArrivals || newBulletinUpdates ? 'sidebar-new-mail-arrivals' : undefined} disabled={Boolean(switchingProfileId)} onClick={() => window.dispatchEvent(new CustomEvent('agentsdock:open-teamspace', { detail: { section: newBulletinUpdates && !newMailArrivals ? 'feed' : 'mail' } }))}><UsersRound size={15} /><span>{t('teamNetwork.name')} <small className="team-network-beta">{t('teamNetwork.beta')}</small></span>{(newMailArrivals || newBulletinUpdates) && <><span className="status-dot" aria-hidden="true" /><span id="sidebar-new-mail-arrivals" className="sr-only">{t(newMailArrivals && newBulletinUpdates ? 'teamNetwork.newTeamActivity' : newMailArrivals ? 'teamNetwork.newMailArrivals' : 'teamNetwork.newBulletinUpdates')}</span></>}</button>}
        <button className="sidebar-action sidebar-action-labeled" title={t("ui.Sidebar.Sidebar.resume_chat_790e1b9")} aria-label={t("ui.Sidebar.Sidebar.resume_chat_790e1b9")} disabled={Boolean(switchingProfileId)} onClick={() => {
          const store = useAppStore.getState()
          store.setModal(localSessionImportSupported(store.health) ? 'importChats' : 'resume', true)
        }}><Undo2 size={15} /><span>{t("ui.Sidebar.Sidebar.resume_d640c74")}</span></button>
      </div>
      <div className="sidebar-project-header">
        <span className="sidebar-project-label">{chatCount} {chatCount === 1 ? 'chat' : 'chats'}</span>
        <div className="sidebar-project-actions" role="group" aria-label={t("ui.Sidebar.Sidebar.chat_list_actions_43ea56a")}>
          <button type="button" className="sidebar-project-action" title={t("ui.Sidebar.Sidebar.create_folder_82b9e1e")} aria-label={t("ui.Sidebar.Sidebar.create_folder_82b9e1e")} disabled={Boolean(switchingProfileId)} onClick={() => useAppStore.getState().setModal('folder', true)}><FolderPlus size={14} /></button>
          <ShortcutTooltip shortcut="findChat" label={t("ui.Sidebar.Sidebar.search_chats_02a39c4")} side="right"><button type="button" className="sidebar-project-action" aria-label={t("ui.Sidebar.Sidebar.search_chats_02a39c4")} disabled={Boolean(switchingProfileId)} onClick={() => handleMenuCommand('find-chat', useAppStore.getState, value => useAppStore.setState(value))}><Search size={14} /></button></ShortcutTooltip>
        </div>
      </div>
      {/* onDragOver fires only when the hovered row changes; onDragMove keeps before/after current
          while the pointer moves within a row, so the first and last slot of a folder are reachable. */}
      <DndContext collisionDetection={sidebarCollisionDetection} sensors={sensors} onDragStart={onDragStart} onDragMove={onDragOver} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={finishDrag}>
        <div className="session-list" ref={sessionListRef} inert={switchingProfileId ? true : undefined} aria-busy={Boolean(switchingProfileId)} onScroll={event => rememberSidebarScroll(event.currentTarget.scrollTop)}>
          {sections.map(section => (
            <SidebarSection
              key={section.id}
              section={section}
              selectedId={selectedId}
              selectedSurfaceId={selectedSurfaceId}
              chatPanes={chatPanes}
              collapsed={section.kind === 'archived' ? archivedCollapsed : section.kind === 'folder' && collapsed.has(section.title)}
              drop={drop}
              suppressClick={suppressClick}
              folders={folders}
              isSidebarScrolling={isSidebarScrolling}
            />
          ))}
          {!sections.some(section => section.sessions.length || section.surfaces.length) && <div className="sidebar-empty">{t("ui.Sidebar.Sidebar.no_chats_found_14dbfb5")}</div>}
        </div>
        <DragOverlay dropAnimation={null}>{dragging && <div className="drag-overlay"><GripVertical size={13} />{dragging.label}</div>}</DragOverlay>
      </DndContext>
      <div className="sidebar-footer">
        <ShortcutTooltip shortcut="settings" label={t("ui.Sidebar.Sidebar.app_settings_d43fb8a")} side="right"><button type="button" className="sidebar-settings-button" aria-label={t("ui.Sidebar.Sidebar.open_app_settings_df2cdb4")} onClick={() => useAppStore.getState().setModal('appSettings', true)}><Settings size={15} /><span>{t("ui.Sidebar.Sidebar.settings_74a883a")}</span></button></ShortcutTooltip>
      </div>
    </aside>
  )
}

function SidebarSection({ section, selectedId, selectedSurfaceId, chatPanes, collapsed, drop, suppressClick, folders, isSidebarScrolling }: {
  section: Section; selectedId: string | null; selectedSurfaceId: string | null; chatPanes: { primary: string | null; secondary: string | null }; collapsed: boolean; drop: DropIndicator | null; suppressClick: (id: string) => boolean
  folders: string[]; isSidebarScrolling: () => boolean
}) {
  useLocale()
  const splitOpen = Boolean(chatPanes.primary && chatPanes.secondary && chatPanes.primary !== chatPanes.secondary)
  const droppable = useDroppable({
    id: section.id,
    disabled: section.kind !== 'folder',
    data: { type: 'folder', label: section.title }
  })
  const boundaryIndicator = section.kind === 'folder' && drop?.id === section.id && drop.placement !== 'inside'
    ? `drop-${drop.placement}`
    : ''
  const toggle = () => {
    if (section.kind === 'archived') useAppStore.getState().setArchivedCollapsed(!collapsed)
    else if (section.kind === 'folder') useAppStore.getState().toggleFolder(section.title)
  }
  return (
    <section ref={droppable.setNodeRef} className={`sidebar-section ${boundaryIndicator}`}>
      <FolderHeader section={section} collapsed={collapsed} drop={drop} onToggle={toggle} suppressClick={suppressClick} folders={folders} />
      {!collapsed && section.sessions.map(session => (
        <SessionRow key={session.id} session={session} selected={session.id === selectedId} visiblePane={splitOpen ? chatPanes.primary === session.id ? 'primary' : chatPanes.secondary === session.id ? 'secondary' : null : null} sectionId={section.id} dropIndicator={drop?.id === `session:${session.id}` ? `drop-${drop.placement}` : ''} suppressClick={suppressClick} folders={folders} isSidebarScrolling={isSidebarScrolling} />
      ))}
      {!collapsed && section.surfaces.map(surface => (
        <SurfaceRow key={surface.id} surface={surface} selected={surface.id === selectedSurfaceId} />
      ))}
    </section>
  )
}

function SurfaceRow({ surface, selected }: { surface: Surface; selected: boolean }) {
  useLocale()
  const select = () => {
    window.dispatchEvent(new Event('agentsdock:close-teamspace'))
    useAppStore.getState().selectSurface(surface.id)
  }
  const Icon = surface.kind === 'terminal' ? SquareTerminal : Globe
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className={`session-row surface-row ${selected ? 'selected' : ''}`}
          role="button"
          tabIndex={0}
          onClick={select}
          onKeyDown={event => { if (event.key === 'Enter') select() }}
        >
          <Icon size={18} aria-hidden="true" />
          <span className="session-copy"><strong>{surfaceTitle(surface)}</strong><small title={surface.kind === 'terminal' ? surface.cwd || undefined : surface.url || undefined}>{surfaceSubline(surface)}</small></span>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content">
          <MenuItem icon={Pencil} label={t('surface.renameMenu')} onSelect={() => {
            select()
            window.dispatchEvent(new CustomEvent('agentsdock:rename-surface', { detail: { surfaceId: surface.id } }))
          }} />
          <MenuItem icon={X} label={t('surface.close')} onSelect={() => void useAppStore.getState().removeSurface(surface.id)} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

function FolderHeader({ section, collapsed, drop, onToggle, suppressClick, folders }: {
  section: Section; collapsed: boolean; drop: DropIndicator | null; onToggle: () => void; suppressClick: (id: string) => boolean; folders: string[]
}) {
  useLocale()
  const health = useAppStore(state => state.health)
  const runtimeCatalog = useAppStore(state => state.runtimeCatalog)
  const id = `folder:${section.title}`
  const draggable = useDraggable({ id, disabled: section.kind !== 'folder', data: { type: 'folder', label: section.title } })
  const indicator = drop?.id === id && drop.placement === 'inside' ? 'drop-inside' : ''
  const header = (
    <div ref={draggable.setNodeRef} className={`section-header ${indicator} ${draggable.isDragging ? 'dragging' : ''}`}>
      <button onClick={() => { if (!suppressClick(id)) onToggle() }} {...draggable.listeners} {...draggable.attributes}>
        {section.kind !== 'search' && (collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />)}
        {section.kind === 'pinned' ? <Pin size={11} /> : section.kind === 'archived' ? <Archive size={11} /> : section.kind === 'search' ? <Search size={11} /> : <Folder size={11} />}
        <span>{section.title}</span><small>{section.sessions.length}</small>
      </button>
    </div>
  )
  if (section.kind !== 'folder') return header
  // `folders` is the rendered order (folderOrder, then folders only chats know about), so a swap
  // persists the full list and unlisted folders keep their place.
  const position = folders.indexOf(section.title)
  const swapWith = (neighbour: number) => {
    const order = [...folders]
    ;[order[position], order[neighbour]] = [order[neighbour], order[position]]
    useAppStore.getState().setFolderOrder(order)
  }
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{header}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content">
          {readyChatBackends(health, runtimeCatalog).map(backend => (
            <MenuItem key={backend} icon={Plus} label={t('ui.sidebar.newBackendChat', { backend: backendLabel(backend) })} onSelect={() => void useAppStore.getState().requestNewChat({ folder: section.title, backend })} />
          ))}
          <MenuItem icon={SquareTerminal} label={t('ui.sidebar.newTerminal')} onSelect={() => void useAppStore.getState().createSurface('terminal', section.title)} />
          <MenuItem icon={Globe} label={t('ui.sidebar.newBrowser')} onSelect={() => void useAppStore.getState().createSurface('browser', section.title)} />
          <ContextMenu.Separator className="menu-separator" />
          <MenuItem icon={Pencil} label={t('ui.sidebar.renameFolder')} onSelect={() => window.dispatchEvent(new CustomEvent('agentsdock:rename-folder', { detail: { folder: section.title } }))} />
          {position > 0 && <MenuItem icon={ArrowUp} label={t('ui.sidebar.moveFolderUp')} onSelect={() => swapWith(position - 1)} />}
          {position < folders.length - 1 && <MenuItem icon={ArrowDown} label={t('ui.sidebar.moveFolderDown')} onSelect={() => swapWith(position + 1)} />}
          <ContextMenu.Separator className="menu-separator" />
          <MenuItem icon={Trash2} label={t("ui.Sidebar.FolderHeader.delete_folder_0fac016")} danger onSelect={() => void useAppStore.getState().deleteFolder(section.title)} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

interface SessionRowProps {
  session: Session
  selected: boolean
  visiblePane: 'primary' | 'secondary' | null
  sectionId: string
  dropIndicator: string
  suppressClick: (id: string) => boolean
  folders: string[]
  isSidebarScrolling: () => boolean
}

const SessionRow = memo(function SessionRow({ session, selected, visiblePane, sectionId, dropIndicator, suppressClick, folders, isSidebarScrolling }: SessionRowProps) {
  useLocale()
  const id = `session:${session.id}`
  const searchResult = sectionId === 'search'
  const draggable = useDraggable({ id, disabled: searchResult, data: { type: 'session', label: session.title, section: sectionId } })
  const droppable = useDroppable({ id, disabled: searchResult, data: { type: 'session', section: sectionId } })
  const ref = (node: HTMLElement | null) => { draggable.setNodeRef(node); droppable.setNodeRef(node) }
  const unread = sessionUnread(session)
  const emergency = activeEmergencyAlert(session)
  const running = useAppStore(state => state.activeSessionIds.has(session.id))
  const needsUserAction = Boolean(session.codex_needs_user_action || session.claude_needs_user_action)
  const prefetchTimer = useRef<number | null>(null)
  useEffect(() => () => { if (prefetchTimer.current) window.clearTimeout(prefetchTimer.current) }, [])
  const schedulePrefetch = () => {
    if (session.archived || selected || isSidebarScrolling()) return
    if (prefetchTimer.current) window.clearTimeout(prefetchTimer.current)
    prefetchTimer.current = window.setTimeout(() => {
      prefetchTimer.current = null
      if (isSidebarScrolling()) return
      void useAppStore.getState().prefetchSession(session.id)
    }, 180)
  }
  const cancelPrefetch = () => {
    if (!prefetchTimer.current) return
    window.clearTimeout(prefetchTimer.current)
    prefetchTimer.current = null
  }
  const select = () => {
    if (suppressClick(id)) return
    window.dispatchEvent(new Event('agentsdock:close-teamspace'))
    void openSessionHistoryResult(session.id)
  }
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          ref={ref}
          className={`session-row ${selected ? 'selected' : visiblePane ? 'visible-in-split' : ''} ${unread ? 'unread' : ''} ${needsUserAction ? 'action-needed' : ''} ${emergency ? 'emergency' : ''} ${dropIndicator} ${draggable.isDragging ? 'dragging' : ''}`}
          title={emergency ? t("ui.Sidebar.SessionRow.emergency_9202f3c", { "chat": String(session.title), "message": String(emergency.message) }) : needsUserAction ? t("ui.Sidebar.SessionRow.action_needed_c2d066a", { "chat": String(session.title) }) : undefined}
          aria-label={emergency ? t("ui.Sidebar.SessionRow.emergency_9e48fd2", { "chat": String(session.title), "message": String(emergency.message) }) : undefined}
          onClick={select}
          onMouseEnter={schedulePrefetch}
          onMouseLeave={cancelPrefetch}
          onKeyDown={event => { if (event.key === 'Enter') select() }}
          {...draggable.listeners}
          {...draggable.attributes}
        >
          <BackendMark backend={session.backend} size={18} />
          <span className="session-copy"><strong>{session.title}</strong><small title={emergency?.message || (needsUserAction ? t("ui.Sidebar.SessionRow.this_agent_is_paused_until_you_respond_82dc6e8") : session.cwd || undefined)}>{emergency ? t("ui.Sidebar.SessionRow.emergency_89e4490", { "message": String(emergency.message) }) : needsUserAction ? t("ui.Sidebar.SessionRow.action_needed_c2d066a", { "chat": String(backendLabel(session.backend)) }) : sessionSubline(session, unread)}</small></span>
          {running && <LoaderCircle className="spin session-spinner" size={14} aria-label={t('ui.sidebar.running')} />}
          {emergency && <span key={emergency.id} className="sr-only" role="alert">{t('ui.sidebar.emergency', { title: session.title, message: emergency.message })}</span>}
          {visiblePane && <span className="sr-only">{t(visiblePane === 'primary' ? 'ui.sidebar.firstPane' : 'ui.sidebar.secondPane')}</span>}
          {(emergency || needsUserAction || unread) && <span className={`status-dot ${emergency ? 'emergency' : needsUserAction ? 'attention' : 'unread'}`} aria-hidden="true" />}
        </div>
      </ContextMenu.Trigger>
      <SessionContextMenu session={session} unread={unread} folders={folders} />
    </ContextMenu.Root>
  )
}, sessionRowPropsEqual)

/** Zed-style thread meta line: "project / dir • 3m", plus a marker for unread activity. */
function sessionSubline(session: Session, unread: boolean): string {
  const parts = [
    workingDirectoryTail(session.cwd),
    shortRelativeTime(session.latest_event_at ?? session.updated_at ?? session.created_at)
  ].filter(Boolean)
  return `${parts.join(' • ')}${unread ? ' • new' : ''}`
}

function SessionContextMenu({ session, unread, folders }: { session: Session; unread: boolean; folders: string[] }) {
  useLocale()
  const shareProfileId = useAppStore(state => state.activeProfileId)
  const shareGeneration = useAppStore(state => state.profileGeneration)
  const shareIdentity = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null)
  const update = (patch: Partial<Session>) => useAppStore.getState().updateSession(session.id, patch)
  const running = useAppStore(state => state.activeSessionIds.has(session.id))
  const admitting = useAppStore(state => Boolean(state.turnAdmissionTokens[session.id]))
  const liveForkSupported = useAppStore(state => completedPrefixForkAvailable(state.health, session.backend))
  const forkBlocked = session?.backend === 'opencode' || (running || admitting) && !liveForkSupported
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content className="menu-content">
        <MenuItem icon={unread ? Inbox : Inbox} label={unread ? t("ui.Sidebar.SessionContextMenu.mark_as_read_75c4ef2") : t("ui.Sidebar.SessionContextMenu.mark_as_unread_1a9220e")} onSelect={() => unread ? void useAppStore.getState().markRead(session.id, true) : void useAppStore.getState().markUnread(session.id)} />
        {!session.archived && <MenuItem icon={Columns2} label={t("ui.Sidebar.SessionContextMenu.open_in_split_view_fd78f06")} onSelect={() => void useAppStore.getState().openSessionInSplit(session.id)} />}
        <MenuItem icon={Pencil} label={t("ui.Sidebar.SessionContextMenu.rename_chat_a257dec")} onSelect={() => window.dispatchEvent(new CustomEvent('agentsdock:rename-chat', { detail: session }))} />
        <MenuItem icon={Share2} label={t('chatShare.menu')} onSelect={() => window.dispatchEvent(new CustomEvent('agentsdock:share-chat', {
          detail: { session, scope: { profileId: shareProfileId, profileGeneration: shareGeneration, serverIdentity: shareIdentity } }
        }))} />
        <MenuItem icon={Download} label={t('sessionExport.markdown')} onSelect={() => void useAppStore.getState().exportSession(session.id, 'markdown')} />
        <MenuItem icon={Download} label={t('sessionExport.html')} onSelect={() => void useAppStore.getState().exportSession(session.id, 'html')} />
        <MenuItem icon={Download} label={t('sessionExport.jsonl')} onSelect={() => void useAppStore.getState().exportSession(session.id, 'jsonl')} />
        <MenuItem icon={session.pinned ? PinOff : Pin} label={session.pinned ? t("ui.Sidebar.SessionContextMenu.unpin_chat_e260efa") : t("ui.Sidebar.SessionContextMenu.pin_chat_633b23e")} onSelect={() => void update({ pinned: !session.pinned })} />
        {!session.archived && <ContextMenu.Sub><ContextMenu.SubTrigger className="menu-item"><Folder size={14} />{t("ui.Sidebar.SessionContextMenu.move_to_folder_91d631e")}<ChevronRight size={13} className="submenu-arrow" /></ContextMenu.SubTrigger><ContextMenu.Portal><ContextMenu.SubContent className="menu-content" sideOffset={3}>{folders.map(folder => <ContextMenu.Item className="menu-item" key={folder} onSelect={() => void update(sidebarFolderAssignmentPatch(folder))}>{folder}</ContextMenu.Item>)}</ContextMenu.SubContent></ContextMenu.Portal></ContextMenu.Sub>}
        <MenuItem icon={session.archived ? ArchiveRestore : Archive} label={session.archived ? t("ui.Sidebar.SessionContextMenu.unarchive_chat_b4d36bb") : t("ui.Sidebar.SessionContextMenu.archive_chat_180f1c3")} onSelect={() => void update({ archived: !session.archived })} />
        <ContextMenu.Separator className="menu-separator" />
        <MenuItem
          icon={Undo2}
          label={t("ui.Sidebar.SessionContextMenu.fork_chat_bc15630")}
          disabled={forkBlocked}
          title={session?.backend === 'opencode' ? t('opencode.forkUnavailable') : forkBlocked ? t('sessionFork.runningUnavailable') : running || admitting ? t('sessionFork.runningDescription') : undefined}
          onSelect={() => void useAppStore.getState().forkSession(session.id)}
        />
        <MenuItem
          icon={History}
          label={t('historyReload.menu')}
          disabled={running || admitting || session.backend === 'opencode' || session.backend === 'cursor'}
          title={running || admitting ? t('historyReload.busy') : undefined}
          onSelect={() => window.dispatchEvent(new CustomEvent('agentsdock:confirm-reload-history', { detail: session }))}
        />
        <MenuItem icon={Trash2} label={t("ui.Sidebar.SessionContextMenu.delete_chat_19f9176")} danger onSelect={() => window.dispatchEvent(new CustomEvent('agentsdock:confirm-delete', { detail: session }))} />
      </ContextMenu.Content>
    </ContextMenu.Portal>
  )
}

function MenuItem({ icon: Icon, label, onSelect, danger, disabled, title }: { icon: typeof MoreHorizontal; label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; title?: string }) {
  useLocale()
  return <ContextMenu.Item className={`menu-item ${danger ? 'danger' : ''}`} disabled={disabled} title={title} onSelect={onSelect}><Icon size={14} />{label}</ContextMenu.Item>
}

/**
 * A chat that a standalone scheduled job opened because its own chat was busy. It is reached from
 * the job card in the chat that scheduled it, and archived when the run ends, so the sidebar lists
 * it only while it is the open chat or once archived.
 */
export function isHiddenRunChat(session: Pick<Session, 'id' | 'archived' | 'scheduled_job_run'>, selectedSessionId: string | null | undefined): boolean {
  return Boolean(session.scheduled_job_run) && !session.archived && session.id !== selectedSessionId
}

export function buildSections(sessions: Session[], folderOrder: string[], query: string, historySessionIds: Set<string> = new Set(), surfaces: Surface[] = [], selectedSessionId: string | null = null): Section[] {
  const filtered = rankSessionsForSearch(sessions.filter(session => !isHiddenRunChat(session, selectedSessionId)), query, historySessionIds)
  if (query.trim()) return filtered.length ? [{ id: 'search', title: t("ui.Sidebar.buildSections.matches_98abff2"), sessions: filtered, surfaces: [], kind: 'search' }] : []
  const pinned = filtered.filter(session => session.pinned && !session.archived)
  const archived = filtered.filter(session => session.archived)
  const byFolder = new Map<string, Session[]>()
  for (const session of filtered.filter(session => !session.archived && !session.pinned)) {
    const folder = session.folder?.trim() || 'General'
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), session])
  }
  const folders = sidebarFolders(filtered, folderOrder)
  // A folder that only a terminal or browser tab lives in still gets listed, after the chat folders.
  for (const folder of [...new Set(surfaces.map(surface => surface.folder))].sort()) {
    if (!folders.includes(folder)) folders.push(folder)
  }
  return [
    ...(pinned.length ? [{ id: 'pinned', title: t("ui.Sidebar.buildSections.pinned_f20c879"), sessions: pinned, surfaces: [], kind: 'pinned' as const }] : []),
    ...folders.map(folder => ({ id: `folder:${folder}`, title: folder, sessions: byFolder.get(folder) ?? [], surfaces: surfaces.filter(surface => surface.folder === folder), kind: 'folder' as const })),
    ...(archived.length ? [{ id: 'archived', title: t("ui.Sidebar.buildSections.archived_bdb8650"), sessions: archived, surfaces: [], kind: 'archived' as const }] : [])
  ]
}

function stringArraysEqual(current: readonly string[], next: readonly string[]): boolean {
  return current === next || (current.length === next.length && current.every((value, index) => value === next[index]))
}

function sessionRowPropsEqual(current: SessionRowProps, next: SessionRowProps): boolean {
  if (
    current.selected !== next.selected
    || current.visiblePane !== next.visiblePane
    || current.sectionId !== next.sectionId
    || current.dropIndicator !== next.dropIndicator
    || current.suppressClick !== next.suppressClick
    || current.isSidebarScrolling !== next.isSidebarScrolling
    || !stringArraysEqual(current.folders, next.folders)
  ) return false
  const left = current.session
  const right = next.session
  if (left === right) return true
  return left.id === right.id
    && left.title === right.title
    && left.folder === right.folder
    && left.backend === right.backend
    && left.cwd === right.cwd
    && left.latest_event_at === right.latest_event_at
    && left.updated_at === right.updated_at
    && left.pinned === right.pinned
    && left.archived === right.archived
    && left.manual_unread === right.manual_unread
    && left.latest_agent_event_seq === right.latest_agent_event_seq
    && left.last_read_agent_event_seq === right.last_read_agent_event_seq
    && left.codex_needs_user_action === right.codex_needs_user_action
    && left.claude_needs_user_action === right.claude_needs_user_action
    && left.emergency_alert?.id === right.emergency_alert?.id
    && left.emergency_alert?.status === right.emergency_alert?.status
    && left.emergency_alert?.severity === right.emergency_alert?.severity
    && left.emergency_alert?.message === right.emergency_alert?.message
    && left.emergency_alert?.raised_at === right.emergency_alert?.raised_at
}

function folderFromSection(section: string | undefined): string | null {
  if (!section?.startsWith('folder:')) return null
  return section.slice('folder:'.length).trim() || 'General'
}

export function reorderFolderList(folders: string[], active: string, target: string, placement: 'before' | 'after'): string[] {
  if (active === target || !folders.includes(active) || !folders.includes(target)) return folders
  const reordered = folders.filter(folder => folder !== active)
  let index = reordered.indexOf(target)
  if (placement === 'after') index += 1
  reordered.splice(Math.max(0, index), 0, active)
  return reordered
}

export function resolveSidebarDrop(
  activeId: string,
  activeData: DragItemData | undefined,
  overId: string | null,
  overData: DragItemData | undefined,
  drop: DropIndicator | null,
  folders: string[]
): SidebarDropOperation | null {
  if (!overId || !drop || activeId === overId) return null
  if (activeData?.type === 'folder' && drop.id.startsWith('folder:') && drop.placement !== 'inside') {
    const active = activeId.replace('folder:', '')
    const target = drop.id.replace('folder:', '')
    const order = reorderFolderList(folders, active, target, drop.placement)
    return order === folders ? null : { kind: 'reorder-folder', order }
  }
  if (activeData?.type === 'session' && overData?.type === 'folder') {
    if (activeData.section === overId) return null
    return { kind: 'move-session', sessionId: activeId.replace('session:', ''), folder: overId.replace('folder:', '') }
  }
  if (activeData?.type === 'session' && overData?.type === 'session' && activeData.section !== 'search' && drop.placement !== 'inside') {
    const targetFolder = activeData.section === overData.section
      ? undefined
      : folderFromSection(overData.section)
    if (activeData.section !== overData.section && !targetFolder) return null
    if (activeData.section === 'pinned' && targetFolder) {
      return { kind: 'move-session', sessionId: activeId.replace('session:', ''), folder: targetFolder }
    }
    return {
      kind: 'reorder-session',
      sessionId: activeId.replace('session:', ''),
      targetId: overId.replace('session:', ''),
      placement: drop.placement,
      ...(targetFolder ? { targetFolder } : {})
    }
  }
  return null
}

export function sidebarFolderAssignmentPatch(folder: string): Partial<Session> {
  return { folder, archived: false }
}

export function sidebarReorderAnalyticsEvent(
  operation: Extract<SidebarDropOperation, { kind: 'reorder-session' }>
): 'chat_moved_to_folder' | 'chat_reordered' {
  return operation.targetFolder ? 'chat_moved_to_folder' : 'chat_reordered'
}
