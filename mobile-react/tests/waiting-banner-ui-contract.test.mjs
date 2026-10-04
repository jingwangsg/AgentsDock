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
  assert.match(subscriber, /NativeAppState\.currentState === 'active' && state\.onScreenSessionId === session\.id/)
  // AppShell owns the one definition of "on screen" the banner and both notifications share.
  assert.match(read('src/components/AppShell.tsx'), /useAppStore\.setState\(\{ onScreenSessionId \}\)/)
  assert.match(subscriber, /is waiting for you/)
  assert.match(subscriber, /data: \{ profileId: scope\.profileId, serverIdentity: scope\.namespace, sessionId: session\.id \}/)
})

test('pushed chat rows reach the list, the running set and the turn-end notification within a second', () => {
  const client = read('src/api/AgentServerClient.ts')
  assert.match(client, /sessionSummaryStream\(handlers/)
  assert.match(client, /\/api\/session-summaries\/events/)
  assert.match(client, /sessionSummaryEvents = health\.capabilities\?\.session_summary_events_v1\?\.available === true/)
  const store = read('src/store/useAppStore.ts')
  assert.match(store, /function applyPushedSessionSummary\(scope: ConnectionScope, incoming: Session\)/)
  // Rows merge like polled rows and keep the running set in step so the poll does not notify twice.
  assert.match(store, /sessionMutations\.reconcileIncoming\(value, incoming, sessionRead\)/)
  assert.match(store, /activeSessionIds\.delete\(incoming\.id\)/)
  assert.match(store, /incoming\.id !== get\(\)\.onScreenSessionId[\s\S]{0,200}notifyOnce\(scope, after, `poll:/)
  // The stream follows the foreground connection: started with the refresh timer, stopped on background.
  assert.match(store, /startForegroundRefreshTimer\(get, set\)\n    startSessionSummaryStream\(\)/)
  assert.match(store, /stopSelectedStream\(\)\n      stopSessionSummaryStream\(\)/)
})
