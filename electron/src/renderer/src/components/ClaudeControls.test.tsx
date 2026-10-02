import { useState } from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { ClaudeRuntimeSnapshot, Health, Session } from '@shared/types'
import { setLocale } from '@shared/i18n'
import { useAppStore } from '../store/app-store'
import { ChatHeader } from './ChatHeader'
import { ClaudeRuntimeProvider } from './ClaudeRuntimeContext'
import { ClaudeGoalControls } from './ClaudeGoalControls'

const session: Session = { id: 'claude-chat', backend: 'claude', title: 'Claude chat' }
const capability = { available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }
const idle: ClaudeRuntimeSnapshot = { available: true, transport: 'sdk', interactive_capability: 'claude_sdk_interactive_v1',
  session_loaded: true, status: { type: 'idle' }, pending_interactions: [], features: { goals: true }, goal: null,
  context_usage_snapshot: { context_tokens: 20000, effective_context_window: 100000 } }
const runtime = vi.fn(), setGoal = vi.fn(), clearGoal = vi.fn(), resolveInteraction = vi.fn()
function GoalSurface() {
  const [open, setOpen] = useState(false)
  return <ClaudeGoalControls open={open} onOpenChange={setOpen} />
}
function surface() {
  return <ClaudeRuntimeProvider session={session} capability={capability}><ChatHeader session={session} /><GoalSurface /></ClaudeRuntimeProvider>
}

describe('Claude header controls', () => {
  beforeEach(() => {
    vi.clearAllMocks(); setLocale('en')
    runtime.mockResolvedValue(idle); setGoal.mockResolvedValue(idle); clearGoal.mockResolvedValue(idle); resolveInteraction.mockResolvedValue({})
    useAppStore.setState({ activeProfileId: 'a', profileGeneration: 1, connected: true, switchingProfileId: null,
      selectedSessionId: session.id, sessions: [session], activeSessionIds: new Set(), turnAdmissionTokens: {}, health: null })
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      claude: { runtime, setGoal, clearGoal, resolveInteraction }, events: { on: vi.fn().mockReturnValue(() => undefined) },
      preferences: { get: vi.fn().mockImplementation((_key, fallback) => Promise.resolve(fallback)) }
    } as unknown as AgentsDockAPI })
  })
  afterEach(() => { cleanup(); setLocale('en') })

  it('opens from the idle header, refreshes native state and shows context without inventing Codex operations', async () => {
    render(surface())
    const trigger = await screen.findByRole('button', { name: 'Claude controls: Idle' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    await userEvent.setup().click(trigger)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Claude controls' })).toBeInTheDocument()
    expect(within(dialog).getByText('20%')).toBeInTheDocument()
    expect(within(dialog).getByText('20k / 100k usable tokens')).toBeInTheDocument()
    expect(within(dialog).getByText('Loaded')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Rollback|Review changes|Run shell/ })).not.toBeInTheDocument()
    await waitFor(() => expect(runtime).toHaveBeenCalledTimes(2))
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Refresh Claude status' }))
    await waitFor(() => expect(runtime).toHaveBeenCalledTimes(3))
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Close Claude controls' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows Claude account usage inside the controls with CLI-style window names', async () => {
    const observedAt = '2026-09-24T12:00:00Z'
    const usage = vi.fn().mockResolvedValue({ backend: 'claude', status: 'available', source: 'claude-events', account_kind: 'subscription', observed_at: observedAt,
      windows: [{ id: 'five_hour', label: null, used_percent: 42, resets_at: 1790254800, window_minutes: 300, observed_at: observedAt, status: 'allowed' },
        { id: 'seven_day', label: null, used_percent: 81, resets_at: 1790254800, window_minutes: 10080, observed_at: observedAt, status: 'allowed_warning' }] })
    Object.assign(window.agentsDock, { runtime: { usage } })
    useAppStore.setState({ health: { capabilities: { provider_usage: { available: true, version: 1 } } } as Health })
    render(surface())
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Claude controls: Idle' }))
    const dialog = screen.getByRole('dialog')
    expect(await within(dialog).findByText('Current session (5h)')).toBeInTheDocument()
    expect(within(dialog).getByText('42% used')).toBeInTheDocument()
    expect(within(dialog).getByText('Current week (all models)').closest('.provider-usage-window')).toHaveClass('warning')
    expect(usage).toHaveBeenCalledExactlyOnceWith({ profileId: 'a', profileGeneration: 1, serverIdentity: undefined }, 'claude', 'claude-chat', false)
  })

  it('keeps lifecycle Running visible when the native snapshot briefly says idle', async () => {
    useAppStore.setState({ activeSessionIds: new Set([session.id]) })
    render(surface())
    const trigger = await screen.findByRole('button', { name: 'Claude controls: Running' })
    await userEvent.setup().click(trigger)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Claude Running' })).not.toBeInTheDocument()
    expect(setGoal).not.toHaveBeenCalled()
  })

  it('opens the same goal dialog from the header and submits only a native Claude completion condition', async () => {
    render(surface())
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Claude controls: Idle' }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Goal…' }))
    const goal = await screen.findByRole('dialog', { name: 'Claude goal' })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    const field = within(goal).getByRole('textbox', { name: 'Completion condition' })
    await userEvent.setup().type(field, 'All changes pass validation.')
    expect(within(goal).queryByRole('spinbutton')).not.toBeInTheDocument()
    await userEvent.setup().click(within(goal).getByRole('button', { name: 'Start goal' }))
    expect(setGoal).toHaveBeenCalledExactlyOnceWith(session.id, 'All changes pass validation.')
  })

  it('resolves pending native approval from the status panel through the Claude bridge', async () => {
    const interaction = { id: 'permission-1', session_id: session.id, tool_use_id: 'tool-1', method: 'item/commandExecution/requestApproval',
      params: { toolName: 'Bash', displayName: 'Run shell command', toolInput: { command: 'git status --short' }, availableDecisions: ['accept', 'decline'] }, created_at: 'now' }
    runtime.mockResolvedValue({ ...idle, status: { type: 'active', activeFlags: ['waitingOnApproval'] }, pending_interactions: [interaction] })
    render(surface())
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Claude controls: 1 waiting' }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve & run' }))
    expect(resolveInteraction).toHaveBeenCalledExactlyOnceWith(session.id, interaction.id, { decision: 'accept' })
  })

  it('compacts context from the panel through the Claude bridge', async () => {
    const compact = vi.fn().mockResolvedValue({ accepted: true, run_id: 'run-1', operation_id: 'run-1' })
    Object.assign(window.agentsDock.claude, { compact })
    runtime.mockResolvedValue({ ...idle, features: { goals: true, compact: true } })
    render(surface())
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Claude controls: Idle' }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Compact' }))
    await waitFor(() => expect(compact).toHaveBeenCalledExactlyOnceWith(session.id))
    expect(await screen.findByText('Context compaction started.')).toBeInTheDocument()
  })

  it('shows the live compaction state and blocks a second compaction until it settles', async () => {
    runtime.mockResolvedValue({ ...idle, status: { type: 'active', activeFlags: [] }, compacting: true, features: { goals: true, compact: true } })
    useAppStore.setState({ activeSessionIds: new Set([session.id]) })
    render(surface())
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Claude controls: Running' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Compacting context…')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Compact' })).toBeDisabled()
  })

  it('hides the compaction action on servers without the Claude compact route', async () => {
    runtime.mockResolvedValue({ ...idle, features: { goals: true } })
    render(surface())
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Claude controls: Idle' }))
    expect(screen.queryByRole('button', { name: 'Compact' })).not.toBeInTheDocument()
  })

  it('closes the panel when switching servers and keeps unsupported goal actions absent', async () => {
    runtime.mockResolvedValue({ ...idle, features: {} })
    render(surface())
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Claude controls: Idle' }))
    expect(screen.queryByRole('button', { name: 'Goal…' })).not.toBeInTheDocument()
    act(() => useAppStore.setState({ activeProfileId: 'b', profileGeneration: 2 }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(setGoal).not.toHaveBeenCalled()
  })
})
