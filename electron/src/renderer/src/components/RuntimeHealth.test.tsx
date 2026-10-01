import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Event, RuntimeCatalog, RuntimeDiagnosticStatus, SessionSnapshot } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { RuntimeHealthNotice, RuntimeHealthPanel } from './RuntimeHealth'

afterEach(cleanup)

const readyCatalog: RuntimeCatalog = {
  generated_at: '2026-07-30T20:01:00Z',
  backends: {
    claude: {
      models: [{ value: 'sonnet', label: 'Sonnet' }],
      efforts: [],
      diagnostic: {
        backend: 'claude',
        status: 'ready',
        available: true,
        installed: true,
        authenticated: true,
        message: 'Claude Code is installed and authenticated.',
        checked_at: '2026-07-30T20:01:00Z',
      },
    },
    codex: {
      models: [{ value: 'gpt-5.6', label: 'GPT-5.6' }],
      efforts: [],
      diagnostic: {
        backend: 'codex',
        status: 'ready',
        available: true,
        installed: true,
        authenticated: true,
        message: 'Codex is installed and authenticated.',
        checked_at: '2026-07-30T20:01:00Z',
      },
    },
  },
}

beforeEach(() => {
  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: {
      runtime: { catalog: vi.fn().mockResolvedValue(readyCatalog) },
    } as unknown as AgentsDockAPI,
  })
  useAppStore.setState({ error: null })
})

describe('a Codex thread held by another process', () => {
  it('offers to end the holder from the composer notice', () => {
    useAppStore.setState({
      health: null,
      runtimeCatalog: readyCatalog,
      snapshots: { 'codex-chat': {
        session: { id: 'codex-chat', title: 'Chat', backend: 'codex' },
        events: [{
          id: 'event-1', seq: 1, session_id: 'codex-chat', backend: 'codex', type: 'error', run_id: 'run-1', ts: '2026-10-01T09:56:16Z',
          message: "409: Another Codex process still holds this chat's thread: a `codex resume` left open on the server, or an app-server that has not finished unloading it. Close it or wait, then retry.",
        }],
        queuedTurns: [], files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0,
      } },
    })
    render(<RuntimeHealthNotice backend="codex" sessionId="codex-chat" />)
    expect(screen.getByRole('button', { name: 'Kill Codex writers' })).toBeInTheDocument()
  })
})

describe('passive Claude authentication in the composer', () => {
  const message = 'Claude Code is installed. Authentication will be checked by Claude when you send a message.'
  const failure = 'Not logged in. Please run claude auth login and retry your message.'
  const snapshot = (events: Event[] = []): SessionSnapshot => ({
    session: { id: 'claude-chat', title: 'Chat', backend: 'claude' },
    events, queuedTurns: [], files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0,
  })
  const event = (type: string, run: string, seq: number, text?: string): Event => ({
    id: `event-${seq}`, seq, session_id: 'claude-chat', backend: 'claude',
    type, run_id: run, ts: '2026-09-25T20:00:00Z', message: text,
  })
  const setup = (status: 'unknown' | 'unauthenticated', events: Event[] = []) => {
    useAppStore.setState({
      health: null,
      runtimeCatalog: { backends: { claude: {
        models: [{ value: 'sonnet', label: 'Sonnet' }], efforts: [], available: false,
        diagnostic: {
          backend: 'claude', status, installed: true, available: false,
          authenticated: status === 'unknown' ? null : false,
          message: status === 'unknown' ? message : failure,
          action: status === 'unknown' ? null : 'Run claude auth login, then retry your message.',
        },
      } } },
      snapshots: { 'claude-chat': snapshot(events) },
    })
  }

  it.each(['unknown', 'unauthenticated'] as const)('does not warn before this chat sends when backend auth is %s', status => {
    setup(status)
    const { container } = render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    expect(container).toBeEmptyDOMElement()
    expect(window.agentsDock.runtime.catalog).not.toHaveBeenCalled()
  })

  it('stays quiet after a successful reply while the client still has unknown readiness', () => {
    setup('unknown', [event('assistant_message', 'run-1', 1, 'Hello!'), event('turn_finished', 'run-1', 2)])
    const { container } = render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows an actual authentication failure from this chat without blocking a native retry', () => {
    setup('unauthenticated', [event('error', 'run-1', 1, failure)])
    render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    expect(screen.getByText('Latest chat error')).toBeInTheDocument()
    expect(screen.getByText(failure)).toBeInTheDocument()
    expect(screen.getByText('Run claude auth login, then retry your message.')).toBeInTheDocument()
    expect(window.agentsDock.runtime.catalog).not.toHaveBeenCalled()
  })

  it('clears the warning after a successful retry even if cached authentication is stale', () => {
    setup('unauthenticated', [event('error', 'run-1', 1, failure), event('turn_finished', 'run-2', 2)])
    const { container } = render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('does not hide a real send error while readiness is unknown', () => {
    setup('unknown', [event('error', 'run-1', 1, 'Request timed out.')])
    render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    expect(screen.getByText('Request timed out.')).toBeInTheDocument()
    expect(screen.queryByText(/Run claude auth login/)).not.toBeInTheDocument()
  })

  it('keeps the passive status available in Settings', () => {
    setup('unknown')
    render(<RuntimeHealthPanel />)
    expect(screen.getByText(message)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Recheck CLIs' })).toBeEnabled()
    expect(window.agentsDock.runtime.catalog).not.toHaveBeenCalled()
  })

  it('still warns when Claude is actually missing', () => {
    useAppStore.setState({ health: { ok: true, runtimes: { claude: {
      backend: 'claude', status: 'missing', installed: false, available: false,
      message: 'Claude Code is not installed.',
    } } }, runtimeCatalog: null, snapshots: {} })
    render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    expect(screen.getByText('Claude Code is not installed.')).toBeInTheDocument()
  })
})

describe('Claude token in the composer', () => {
  const token = 'sk-ant-oat01-synthetic_token-value'
  const missingToken = 'failed to start Claude: Claude is not authenticated on this server: CLAUDE_CODE_OAUTH_TOKEN is not set.'
  const setup = (configured: boolean | undefined, error = '', status: RuntimeDiagnosticStatus = 'unauthenticated') => {
    useAppStore.setState({
      activeProfileId: 'profile-a',
      profileGeneration: 3,
      health: null,
      runtimeCatalog: { backends: { claude: {
        models: [], efforts: [], available: false,
        diagnostic: {
          backend: 'claude', status, installed: status !== 'missing', available: false, authenticated: null,
          message: 'This server has no Claude token.', oauth_token_configured: configured,
        },
      } } },
      snapshots: { 'claude-chat': {
        session: { id: 'claude-chat', title: 'Chat', backend: 'claude' },
        events: error ? [{
          id: 'event-1', seq: 1, session_id: 'claude-chat', backend: 'claude', type: 'error', run_id: 'run-1',
          ts: '2026-09-29T07:11:00Z', message: error,
        }] : [],
        queuedTurns: [], files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0,
      } },
    })
  }
  // What the recheck returns once the server has the token.
  const savedCatalog: RuntimeCatalog = { backends: { ...readyCatalog.backends, claude: {
    ...readyCatalog.backends.claude,
    diagnostic: { ...readyCatalog.backends.claude.diagnostic!, status: 'unknown', oauth_token_configured: true },
  } } }
  const withAgentsDock = (extra: Record<string, unknown>) => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { runtime: { catalog: vi.fn().mockResolvedValue(savedCatalog) }, ...extra } as unknown as AgentsDockAPI,
    })
  }

  it('asks for a token before any send when the server has none, then saves it to this profile and rechecks', async () => {
    const setToken = vi.fn().mockResolvedValue(undefined)
    withAgentsDock({ claude: { setToken } })
    setup(false)
    const { container } = render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    expect(screen.getByText('Token required')).toBeInTheDocument()
    expect(screen.getByText('This server has no Claude token.')).toBeInTheDocument()
    const input = screen.getByLabelText('Claude token')
    expect(input).toHaveAttribute('type', 'password')
    await userEvent.type(input, `  ${token}  `)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    // The recheck reports the token, so the whole notice goes away.
    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(setToken).toHaveBeenCalledExactlyOnceWith({ profileId: 'profile-a', profileGeneration: 3 }, token)
    expect(window.agentsDock.runtime.catalog).toHaveBeenCalledWith(true, true)
  })

  it('confirms the save while this chat still shows the missing-token error', async () => {
    withAgentsDock({ claude: { setToken: vi.fn().mockResolvedValue(undefined) } })
    setup(false, missingToken)
    render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    await userEvent.type(screen.getByLabelText('Claude token'), token)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Token saved. New Claude messages on this server use it.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Claude token')).not.toBeInTheDocument()
  })

  it.each([
    'Claude assistant error: authentication_failed',
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
  ])('offers a replacement token after this chat fails with %s', error => {
    setup(true, error)
    render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    expect(screen.getByText('Latest chat error')).toBeInTheDocument()
    expect(screen.getByLabelText('Claude token')).toBeInTheDocument()
  })

  it.each([
    ['the token is configured', true, '', 'unknown'],
    ['the server predates the token field', undefined, 'Claude assistant error: authentication_failed', 'unauthenticated'],
    ['the CLI is missing, not the token', false, '', 'missing'],
    ['an unrelated OAuth or 401 error', true, 'MCP server "linear" requires OAuth authorization; status 401', 'unknown'],
  ] as const)('shows no token field when %s', (_case, configured, error, status) => {
    setup(configured, error, status)
    render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    expect(screen.queryByLabelText('Claude token')).not.toBeInTheDocument()
  })

  it('never asks a shared-chat guest for the host server token', () => {
    withAgentsDock({ sharedChat: {} })
    setup(false)
    render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    expect(screen.queryByLabelText('Claude token')).not.toBeInTheDocument()
  })

  it('shows a short error without the token when the server rejects it', async () => {
    withAgentsDock({ claude: { setToken: vi.fn().mockRejectedValue(new Error("Error invoking remote method 'claude:token:set': Error: CLAUDE_TOKEN_INVALID")) } })
    setup(false)
    render(<RuntimeHealthNotice backend="claude" sessionId="claude-chat" />)
    await userEvent.type(screen.getByLabelText('Claude token'), token)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The server rejected this value.')
    expect(screen.getByRole('alert')).not.toHaveTextContent(token)
    expect(window.agentsDock.runtime.catalog).not.toHaveBeenCalled()
  })
})

describe('RuntimeHealthPanel tmux prerequisite', () => {
  it('shows a missing tmux capability with actionable installation guidance', () => {
    useAppStore.setState({
      health: {
        ok: true,
        capabilities: {
          tmux: {
            available: false,
            required: true,
            message: 'tmux is missing; terminal sessions and detached updates are unavailable.',
            action: 'Install tmux, then restart AgentsServer.'
          }
        }
      },
      runtimeCatalog: null
    })

    render(<RuntimeHealthPanel />)

    expect(screen.getByText('Missing')).toBeInTheDocument()
    expect(screen.getByText('tmux is missing; terminal sessions and detached updates are unavailable.')).toBeInTheDocument()
    expect(screen.getByText('Install tmux, then restart AgentsServer.')).toHaveClass('runtime-action')
  })

  it('shows tmux as ready when the server reports it available', () => {
    useAppStore.setState({
      health: {
        ok: true,
        capabilities: {
          tmux: { available: true, required: true, message: 'tmux is available.', action: null }
        }
      },
      runtimeCatalog: null
    })

    render(<RuntimeHealthPanel />)

    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByText('tmux is available.')).toBeInTheDocument()
  })

  it('keeps older servers without capability data in an unknown state', () => {
    useAppStore.setState({ health: { ok: true }, runtimeCatalog: null })

    const { container } = render(<RuntimeHealthPanel />)

    expect(screen.getByText('Not reported')).toBeInTheDocument()
    expect(screen.getByText('This AgentsServer version has not reported tmux readiness.')).toBeInTheDocument()
    expect(container.querySelector('.runtime-health-row.unknown')).toBeInTheDocument()
    expect(container.querySelector('.runtime-health-row.unknown')).not.toHaveClass('warning', 'error')
  })

  it('does not advertise Cursor in Settings on a legacy server', () => {
    useAppStore.setState({
      health: { ok: true },
      runtimeCatalog: {
        ...readyCatalog,
        backends: {
          ...readyCatalog.backends,
          cursor: {
            available: true,
            models: [{ value: 'auto', label: 'Auto' }],
            efforts: []
          }
        }
      }
    })

    render(<RuntimeHealthPanel />)

    expect(screen.queryByText('Cursor')).not.toBeInTheDocument()
  })

  it('keeps an existing Cursor chat readable with an explicit legacy-server diagnostic', () => {
    useAppStore.setState({
      health: { ok: true },
      runtimeCatalog: readyCatalog,
      snapshots: {}
    })

    render(<RuntimeHealthNotice backend="cursor" sessionId="cursor-chat" />)

    expect(screen.getByRole('alert')).toHaveTextContent('Cursor Unavailable')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Cursor is unavailable because this AgentsServer does not support it yet. Update the server, then reconnect.'
    )
  })

  it('shows catalog loading instead of contradictory setup guidance for ready Cursor health', () => {
    useAppStore.setState({
      health: {
        ok: true,
        capabilities: {
          cursor_backend: {
            available: true,
            required: false,
            message: 'Cursor backend is supported.',
            action: null,
            version: 2,
          }
        },
        runtimes: {
          cursor: {
            backend: 'cursor',
            status: 'ready',
            available: true,
            installed: true,
            authenticated: true,
            message: 'Cursor is installed and authenticated.',
            checked_at: '2026-07-30T20:02:00Z',
          }
        }
      },
      runtimeCatalog: null,
      snapshots: {}
    })

    render(<RuntimeHealthNotice backend="cursor" sessionId="cursor-chat" />)

    expect(screen.getByRole('alert')).toHaveTextContent('Cursor Unavailable')
    expect(screen.getByRole('alert')).toHaveTextContent(/model choices are still loading/i)
    expect(screen.getByRole('alert')).not.toHaveTextContent('Cursor is installed and authenticated.')
  })

  it('forces a fresh CLI probe and applies its returned diagnostics immediately', async () => {
    useAppStore.setState({
      health: {
        ok: true,
        runtimes: {
          codex: {
            backend: 'codex',
            status: 'missing',
            available: false,
            message: 'Codex is not available.',
            checked_at: '2026-07-30T20:01:00Z',
          },
        },
      },
      runtimeCatalog: null,
    })
    const user = userEvent.setup()
    render(<RuntimeHealthPanel />)

    await user.click(screen.getByRole('button', { name: 'Recheck CLIs' }))

    expect(window.agentsDock.runtime.catalog).toHaveBeenCalledWith(true, true)
    await waitFor(() => expect(screen.getByText('Codex is installed and authenticated.')).toBeInTheDocument())
    expect(screen.queryByText('Codex is not available.')).not.toBeInTheDocument()
  })

  it('lets a user recheck an unavailable CLI directly from the composer warning', async () => {
    useAppStore.setState({
      health: {
        ok: true,
        runtimes: {
          codex: {
            backend: 'codex',
            status: 'missing',
            available: false,
            message: 'Codex is not available.',
            checked_at: '2026-07-30T20:01:00Z',
          },
        },
      },
      runtimeCatalog: null,
      snapshots: {},
    })
    const user = userEvent.setup()
    render(<RuntimeHealthNotice backend="codex" sessionId="chat-1" />)

    await user.click(screen.getByRole('button', { name: 'Recheck Codex CLI status' }))

    expect(window.agentsDock.runtime.catalog).toHaveBeenCalledWith(true, true)
    await waitFor(() => expect(screen.queryByText('Codex is not available.')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Recheck Codex CLI status' })).not.toBeInTheDocument()
  })

  it('keeps the warning actionable when a CLI recheck fails and allows retry', async () => {
    vi.mocked(window.agentsDock.runtime.catalog)
      .mockRejectedValueOnce(new Error('CLI probe timed out'))
      .mockResolvedValueOnce(readyCatalog)
    useAppStore.setState({
      health: {
        ok: true,
        runtimes: {
          codex: {
            backend: 'codex',
            status: 'missing',
            available: false,
            message: 'Codex is not available.',
            checked_at: '2026-07-30T20:01:00Z',
          },
        },
      },
      runtimeCatalog: null,
      snapshots: {},
    })
    const user = userEvent.setup()
    render(<RuntimeHealthNotice backend="codex" sessionId="chat-1" />)

    const recheck = screen.getByRole('button', { name: 'Recheck Codex CLI status' })
    await user.click(recheck)

    await waitFor(() => expect(useAppStore.getState().error).toBe('CLI probe timed out'))
    expect(screen.getByText('Codex is not available.')).toBeInTheDocument()
    expect(recheck).toBeEnabled()

    await user.click(recheck)

    expect(window.agentsDock.runtime.catalog).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.queryByText('Codex is not available.')).not.toBeInTheDocument())
    expect(useAppStore.getState().error).toBeNull()
  })

  it('shows a current provider failure in Settings and clears it after rechecking', async () => {
    useAppStore.setState({
      health: null,
      runtimeCatalog: {
        ...readyCatalog,
        backends: {
          ...readyCatalog.backends,
          codex: {
            ...readyCatalog.backends.codex,
            diagnostic: {
              ...readyCatalog.backends.codex.diagnostic!,
              checked_at: '2026-07-30T20:00:00Z',
              last_error: 'Codex failed before launching.',
              last_error_at: '2026-07-30T20:00:30Z',
            },
          },
        },
      },
      snapshots: {},
    })
    const user = userEvent.setup()
    render(<RuntimeHealthPanel />)

    expect(screen.getByText('Codex failed before launching.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Recheck CLIs' }))

    await waitFor(() => expect(screen.queryByText('Codex failed before launching.')).not.toBeInTheDocument())
  })

  it('does not display an older provider error after a newer successful probe', () => {
    useAppStore.setState({
      health: null,
      runtimeCatalog: {
        ...readyCatalog,
        backends: {
          ...readyCatalog.backends,
          codex: {
            ...readyCatalog.backends.codex,
            diagnostic: {
              ...readyCatalog.backends.codex.diagnostic!,
              checked_at: '2026-07-30T20:02:00Z',
              last_error: 'This failure is stale.',
              last_error_at: '2026-07-30T20:01:00Z',
            },
          },
        },
      },
    })

    render(<RuntimeHealthPanel />)

    expect(screen.queryByText('This failure is stale.')).not.toBeInTheDocument()
    expect(screen.getByText('Codex is installed and authenticated.')).toBeInTheDocument()
  })

  it('causally clears an equal-second provider error after a successful explicit recheck', async () => {
    const checkedAt = '2026-07-30T20:01:00Z'
    const equalSecondCatalog: RuntimeCatalog = {
      ...readyCatalog,
      generated_at: checkedAt,
      backends: {
        ...readyCatalog.backends,
        codex: {
          ...readyCatalog.backends.codex,
          diagnostic: {
            ...readyCatalog.backends.codex.diagnostic!,
            checked_at: checkedAt,
            last_error: 'Codex failed in the same timestamp second.',
            last_error_at: checkedAt,
          },
        },
      },
    }
    vi.mocked(window.agentsDock.runtime.catalog).mockResolvedValueOnce(equalSecondCatalog)
    useAppStore.setState({
      health: null,
      runtimeCatalog: equalSecondCatalog,
      error: 'Previous recheck failed',
    })
    const user = userEvent.setup()
    render(<RuntimeHealthPanel />)

    expect(screen.getByText('Codex failed in the same timestamp second.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Recheck CLIs' }))

    await waitFor(() => expect(screen.queryByText('Codex failed in the same timestamp second.')).not.toBeInTheDocument())
    expect(screen.getByText('Codex is installed and authenticated.')).toBeInTheDocument()
    expect(useAppStore.getState().runtimeCatalog?.backends.codex.diagnostic?.last_error).toBeNull()
    expect(useAppStore.getState().error).toBeNull()
  })
})
