import type { Backend, Health } from '../types'

export function sessionRewindAvailable(health: Health | null | undefined, backend: Backend | undefined): boolean {
  const capability = health?.capabilities?.session_rewind_v1
  return health?.ok === true
    && capability?.available === true
    && capability.version === 1
    && backend !== undefined
    && Array.isArray(capability.supported_backends)
    && capability.supported_backends.includes(backend)
}

export function checkpointRestoreAvailable(health: Health | null | undefined, backend: Backend | undefined): boolean {
  return sessionRewindAvailable(health, backend) && health?.capabilities?.session_rewind_v1?.checkpoint_restore === true
}
