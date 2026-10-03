import type { JsonValue } from '../types'

/** The value as a JSON object, or null for any other JSON value. */
export function objectValue(value: unknown): Record<string, JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null
}

/** The first of `keys` whose value is a JSON object. */
export function firstObject(record: Record<string, JsonValue>, keys: readonly string[]): Record<string, JsonValue> | null {
  for (const key of keys) {
    const candidate = objectValue(record[key])
    if (candidate) return candidate
  }
  return null
}
