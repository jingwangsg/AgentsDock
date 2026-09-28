import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = fs.readFileSync(path.resolve('src/components/ServerProfiles.tsx'), 'utf8')
const appShell = fs.readFileSync(path.resolve('src/components/AppShell.tsx'), 'utf8')
const dialogs = fs.readFileSync(path.resolve('src/components/Dialogs.tsx'), 'utf8')
const firstLaunch = fs.readFileSync(path.resolve('src/lib/first-launch.ts'), 'utf8')
const store = fs.readFileSync(path.resolve('src/store/useAppStore.ts'), 'utf8')

test('first launch adopts a live 127.0.0.1:7850 hub, otherwise presents setup and hands off after dismissal', () => {
  assert.match(store, /if \(isServerSetupRequired\(activeProfile\) && await localHubAlive\(activeProfile\.serverURL\)\) \{/)
  assert.match(store, /if \(BUILT_IN_HUB_TOKEN && !await loadProfileToken\(activeProfile\.id, activeProfile\.credentialVersion\)\) \{/)
  assert.match(firstLaunch, /state\.initialized[\s\S]*?!state\.connected[\s\S]*?isServerSetupRequired\(state\)[\s\S]*?!state\.setupDismissed/)
  assert.match(store, /if \(NativeAppState\.currentState === 'active' && shouldAutoConnectServer\(get\(\)\)\) \{[\s\S]*?await get\(\)\.reconnect\(\)/)
  assert.match(store, /async reconnect\(\) \{\s*if \(NativeAppState\.currentState !== 'active' \|\| !shouldAutoConnectServer\(get\(\)\)\) return/)
  assert.match(appShell, /shouldPresentServerSetup\(\{ initialized, connected, serverConfigured, serverURL, setupDismissed \}\)/)
  assert.match(appShell, /setupNextMode\.current = 'edit-active'/)
  assert.match(appShell, /onDidDismiss=\{finishSetupDismissal\}/)
  assert.match(appShell, /if \(Platform\.OS !== 'ios'\) requestAnimationFrame\(finishSetupDismissal\)/)
  assert.doesNotMatch(appShell, /openServersAfterSetup/)
  assert.match(dialogs, /onDismiss=\{didDismiss\}/)
  assert.match(source, /initialServerProfileDraft\(initialMode, profiles, activeProfileId\)/)
})

test('server selector permanently exposes profile status, host, and unread count', () => {
  assert.match(source, /testID="server-profile-selector"/)
  assert.match(source, /<ServerConnectionDot/)
  assert.match(source, /profileHostSubtitle\(active\)/)
  assert.match(source, /<ServerUnreadBadge count=\{active\.cachedUnreadCount\}/)
  assert.match(source, /<MenuView[\s\S]*?onPressAction=/)
})

test('server switching tracks resolved and thrown failures without swallowing the error', () => {
  const switchCallback = appShell.match(/const switchServer = useCallback\(async \(profileId: string\) => \{[\s\S]*?\n  \}, \[switchServerProfile\]\)/)?.[0]
  assert.ok(switchCallback)
  assert.match(switchCallback, /const success = await switchServerProfile\(profileId\)[\s\S]*?trackEvent\('server_switched', \{ success \}\)[\s\S]*?return success/)
  assert.match(switchCallback, /catch \(error\) \{[\s\S]*?trackEvent\('server_switched', \{ success: false \}\)[\s\S]*?throw error/)
})

test('connection edits stay gated on a successful test of that exact connection', () => {
  assert.match(source, /if \(updateConnectionChanged && !tested\?\.server_identity\?\.trim\(\)\) \{/)
  assert.match(source, /did not report a stable server identity/)
  assert.match(source, /Already saved as/)
})

test('connection edits carry only the freshly tested identity', () => {
  assert.match(source, /updateConnectionChanged && !tested\?\.server_identity\?\.trim\(\)/)
  assert.match(source, /buildUpdateServerProfileInput\(editedProfile, draft, tested\?\.server_identity\)/)
  assert.match(source, /identityResetUnconfirmed/)
})

test('server removal and identity reset require native confirmation', () => {
  assert.match(source, /Alert\.alert\([\s\S]*?Remove server/)
  assert.match(source, /Alert\.alert\([\s\S]*?Allow identity reset/)
  assert.match(source, /attributes: \{ disabled: disabled \|\| active, destructive: !active \}/)
})

test('server management controls retain touch-safe minimum dimensions', () => {
  assert.match(source, /input: \{ minHeight: 44/)
  assert.match(source, /primaryButton: \{ minHeight: 44/)
  assert.match(source, /secondaryButton: \{ minHeight: 44/)
  assert.match(source, /moreButton: \{ width: 44, height: 44/)
})

test('remotes are reconciled from the hub registry; deploy only appears while the hub itself is active; the remote\'s own token is never exposed', () => {
  // AppShell gates the surface on the capability AND on the active URL being the
  // hub itself: a proxied remote also advertises remote_servers_v1.
  assert.match(appShell, /hubAvailable=\{Boolean\(health\?\.capabilities\?\.remote_servers_v1\?\.available\) && !hubProxyRemoteId\(serverURL\)\}/)
  assert.match(appShell, /onDeployRemote=\{\(input, onProgress\) => deployHubRemoteServer\(input, onProgress, profileGeneration\)\}/)
  assert.match(appShell, /onCancelDeploy=\{cancelHubDeploy\}/)
  // The rendered button is gated on the same prop, not a store read of its own.
  assert.match(source, /\{hubAvailable \? <SecondaryButton icon=\{UploadCloud\} label="Deploy over SSH"/)
  // The store mirrors the hub registry right after a successful connect and
  // again when a deploy job finishes, instead of a manual import/add flow.
  assert.match(store, /requestNotificationPermissionOnce\(\)\s*void reconcileHubRemoteServers\(scope, set, get\)/)
  assert.match(store, /if \(job\.done\) \{[\s\S]*?await reconcileHubRemoteServers\(scope, set, get\)/)
  // Removing a proxied profile unregisters it on the hub first, or the next
  // reconcile would recreate it.
  assert.match(store, /await scope\.client\.removeRemoteServer\(remoteId\)/)
  for (const file of [source, appShell, store]) {
    assert.doesNotMatch(file, /importHubRemoteServers|onImportFromHub|onCreateProfile|createServerProfile\(|Import from hub|label="Add server"|id: 'add'/)
  }
  // Opening the deploy editor closes the edit draft, so a deploy never reuses
  // it (which would put the hub's address in the deployed field).
  assert.match(source, /const openDeploy = \(\) => \{\s*if \(busy \|\| deployBusy\) return\s*setDraft\(null\)/)
  // Deploy sends only ssh_host/install_dir/name to the store action; it never
  // constructs a serverUrl or accessToken client-side (the hub's deploy job
  // reports the proxy path, and the reconcile reuses the hub's own token).
  assert.match(source, /onDeployRemote\(\s*\{ sshHost: deployDraft\.sshHost\.trim\(\), installDir: deployDraft\.installDir\.trim\(\) \|\| undefined, name: deployDraft\.name\.trim\(\) \|\| undefined \}/)
  assert.doesNotMatch(source, /deployDraft\.(token|accessToken)/)
})
