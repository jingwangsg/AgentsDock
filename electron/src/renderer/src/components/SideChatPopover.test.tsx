import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { setLocale } from '@shared/i18n'
import type { Backend, Health, Session } from '@shared/types'
import { SideChatController } from '../lib/side-chat'
import { useAppStore } from '../store/app-store'
import { SideChatPopover } from './SideChatPopover'

const scope = { profileId: 'server-a', profileGeneration: 7 }
const health = (backends: Backend[]): Health => ({ ok: true, capabilities: { side_questions: {
  available: true, version: 2, native_context: true, sync: true, backends, max_question_chars: 8000 } } })

function button(backend: Backend, serverHealth: Health | null) {
  useAppStore.setState({ health: serverHealth })
  render(<SideChatPopover session={{ id: 'chat-a', title: 'Research', backend } as Session} scope={scope}
    controller={new SideChatController()} open={false} focusVersion={0} onOpenChange={() => undefined} />)
  const found = screen.queryByRole('button', { name: 'Side chat' })
  cleanup()
  return found !== null
}

beforeEach(() => {
  setLocale('en')
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: {} as unknown as AgentsDockAPI })
})
afterEach(() => { cleanup(); useAppStore.setState({ health: null }) })

describe('Side chat button', () => {
  it('follows the backends the server lists', () => {
    expect(button('cursor', health(['codex', 'claude', 'cursor']))).toBe(true)
    // An older server, and a server without a usable Cursor CLI, do not list it.
    expect(button('cursor', health(['codex', 'claude']))).toBe(false)
    expect(button('cursor', null)).toBe(false)
    expect(button('opencode', health(['codex', 'claude', 'cursor']))).toBe(false)
  })

  it('stays on Codex and Claude chats where the panel explains what is missing', () => {
    for (const backend of ['codex', 'claude'] as const) {
      expect(button(backend, health(['codex', 'claude']))).toBe(true)
      expect(button(backend, null)).toBe(true)
      expect(button(backend, { ok: true })).toBe(true)
    }
  })
})
