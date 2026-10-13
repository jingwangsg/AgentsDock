import { describe, expect, it } from 'vitest'
import { steerRewindAvailable } from './session-rewind'
import type { Health, SessionRewindCapability } from './types'

const health = (rewind: Partial<SessionRewindCapability>): Health => ({
  ok: true,
  capabilities: { session_rewind_v1: { available: true, version: 1, supported_backends: ['claude', 'codex'], ...rewind } }
}) as Health

describe('steerRewindAvailable', () => {
  it('needs a server that lists the chat backend in steer_backends', () => {
    expect(steerRewindAvailable(health({ steer_backends: ['claude'] }), 'claude')).toBe(true)
    expect(steerRewindAvailable(health({ steer_backends: ['claude'] }), 'codex')).toBe(false)
    // A server from before steer rewinds still offers ordinary rewinds.
    expect(steerRewindAvailable(health({}), 'claude')).toBe(false)
    expect(steerRewindAvailable(health({ available: false, steer_backends: ['claude'] }), 'claude')).toBe(false)
  })
})
