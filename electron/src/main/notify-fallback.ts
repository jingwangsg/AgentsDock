import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'

/**
 * macOS shows UNUserNotificationCenter banners only for apps signed with an
 * identity. The local ad-hoc build reports Electron's `show` event yet never
 * registers with Notification Center, so nothing appears. `osascript` posts a
 * banner regardless of the caller's signature (attributed to Script Editor).
 */
export function appleScriptNotification(title: string, body: string): string {
  const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`
  return `display notification ${quote(body)} with title ${quote(title)}`
}

/** `/Applications/AgentsDock.app` for `/Applications/AgentsDock.app/Contents/MacOS/AgentsDock`. */
export function macAppBundlePath(executablePath: string): string {
  return resolve(dirname(executablePath), '..', '..')
}

let adhocSigned = false
let probed = false

/** Probe once at startup so the notification path stays synchronous. */
export function primeMacSignatureProbe(executablePath: string): void {
  if (probed || process.platform !== 'darwin') return
  probed = true
  execFile('/usr/bin/codesign', ['-dv', macAppBundlePath(executablePath)], { timeout: 5000 }, (_error, _stdout, stderr) => {
    adhocSigned = /^Signature=adhoc$/m.test(String(stderr))
  })
}

export function macAppIsAdhocSigned(): boolean {
  return adhocSigned
}

export function postAppleScriptNotification(title: string, body: string, onDone: (error: Error | null) => void): void {
  execFile('/usr/bin/osascript', ['-e', appleScriptNotification(title, body)], { timeout: 10000 }, error => onDone(error ?? null))
}
