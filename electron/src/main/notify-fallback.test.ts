import { describe, expect, it } from 'vitest'
import { appleScriptNotification, macAppBundlePath } from './notify-fallback'

describe('notify-fallback', () => {
  it('quotes AppleScript strings and flattens newlines', () => {
    expect(appleScriptNotification('Chat "A"', 'Response\nfinished \\ done')).toBe(
      'display notification "Response finished \\\\ done" with title "Chat \\"A\\""'
    )
  })

  it('resolves the .app bundle from the executable path', () => {
    expect(macAppBundlePath('/Applications/AgentsDock.app/Contents/MacOS/AgentsDock')).toBe('/Applications/AgentsDock.app')
  })
})
