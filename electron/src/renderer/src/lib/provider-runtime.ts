/** Helpers shared by the Claude and Codex runtime contexts. */

/** Strips the Electron IPC prefix so the renderer shows the main-process message as written. */
export function errorMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause))
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

export function numberField(value: unknown, key: string): number {
  if (!value || typeof value !== 'object') return 0
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'number' ? candidate : 0
}

export function booleanField(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false
  return (value as Record<string, unknown>)[key] === true
}
