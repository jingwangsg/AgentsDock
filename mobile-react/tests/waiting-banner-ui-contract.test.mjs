import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const read = file => fs.readFileSync(path.resolve(file), 'utf8')

test('the shell shows a waiting-for-you banner above the content that opens the named chat', () => {
  const shell = read('src/components/AppShell.tsx')
  assert.match(shell, /<WaitingForYouBanner onScreenSessionId=/)
  assert.match(shell, /selectSession\(sessionId\)[\s\S]{0,120}openMobileChat\(\)/)
  const banner = read('src/components/WaitingForYouBanner.tsx')
  // The open chat shows its own interaction shelf; the banner names the others.
  assert.match(banner, /session\.id !== onScreenSessionId/)
  assert.match(banner, /sessionNeedsProviderInteraction\(session\)/)
  assert.match(banner, /is waiting for you in/)
  assert.match(banner, /chats are waiting for you/)
  assert.match(banner, /testID="waiting-banner-open"/)
  assert.match(banner, /testID="waiting-banner-dismiss"/)
})

test('a chat whose agent starts waiting posts one local notification unless it is the open chat', () => {
  const store = read('src/store/useAppStore.ts')
  const subscriber = store.slice(store.indexOf('// One local notification when a chat'), store.indexOf('function saveCurrentWorkspace'))
  assert.match(subscriber, /useAppStore\.subscribe\(\(state, previous\)/)
  assert.match(subscriber, /wasWaiting\.get\(session\.id\) !== false/)
  assert.match(subscriber, /NativeAppState\.currentState === 'active' && state\.selectedSessionId === session\.id/)
  assert.match(subscriber, /is waiting for you/)
  assert.match(subscriber, /data: \{ profileId: scope\.profileId, serverIdentity: scope\.namespace, sessionId: session\.id \}/)
})
