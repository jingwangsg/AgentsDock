import type { Health } from '../types'
import { checkpointRestoreAvailable, sessionRewindAvailable } from './session-rewind'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const health = (patch: Record<string, unknown> = {}): Health => ({
  ok: true,
  capabilities: {
    session_rewind_v1: { available: true, version: 1, supported_backends: ['claude', 'codex'], checkpoint_restore: true, ...patch },
  },
})

assert(sessionRewindAvailable(health(), 'claude'), 'an advertised v1 capability enables rewind for a supported backend')
assert(checkpointRestoreAvailable(health(), 'codex'), 'checkpoint restore follows the capability flag')
assert(!sessionRewindAvailable(health(), 'cursor'), 'unsupported backends cannot rewind')
assert(!sessionRewindAvailable(health(), undefined), 'an unknown backend cannot rewind')
assert(!sessionRewindAvailable(health({ available: false }), 'claude'), 'an unavailable capability disables rewind')
assert(!sessionRewindAvailable(health({ version: 2 }), 'claude'), 'only version 1 is understood')
assert(!sessionRewindAvailable({ ...health(), ok: false }, 'claude'), 'an unhealthy server disables rewind')
assert(!sessionRewindAvailable(null, 'claude'), 'missing health disables rewind')
assert(!sessionRewindAvailable({ ok: true }, 'claude'), 'a server without the capability disables rewind')
assert(!checkpointRestoreAvailable(health({ checkpoint_restore: false }), 'claude'), 'restore needs its own flag')
assert(!checkpointRestoreAvailable(health({ checkpoint_restore: undefined }), 'claude'), 'restore is opt-in')

console.log('session rewind capability helpers passed')
