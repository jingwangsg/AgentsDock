import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import AsyncStorage from '@react-native-async-storage/async-storage'
import NetInfo from '@react-native-community/netinfo'
import * as SecureStore from 'expo-secure-store'
import * as Notifications from 'expo-notifications'
import { AppState as NativeAppState } from 'react-native'
import { AgentServerClientUnvalidatedError } from '../api/AgentServerClient'
import type { StoredProfileSettings } from '../types'

// A profile with a second address: the app proves the address (connect_proof_v1) before its token goes there, and
// falls back to the primary on a failed or silent proof. Every request is logged with whether it carried a credential.
const log: Array<{ server: string; path: string; credential: boolean }> = []
const credentialOf = (request: IncomingMessage) => Boolean(
  request.headers['x-zenithdock-token'] || request.headers['x-agentsdock-token'] || request.headers.authorization
  || request.headers.cookie || /[?&]token=/.test(request.url ?? '') || /agentsdock-token\./.test(String(request.headers['sec-websocket-protocol'] ?? '')),
)
const proofFor = (token: string, identity: string, nonce: string) => createHmac('sha256', token).update(`agentsdock-connect-proof-v1\n${nonce}\n${identity}`).digest('hex')

function server(name: string, answer: (request: IncomingMessage, url: URL, reply: (status: number, value: unknown) => void) => void): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    log.push({ server: name, path: url.pathname, credential: credentialOf(request) })
    answer(request, url, (status, value) => {
      const body = JSON.stringify(value)
      response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) })
      response.end(body)
    })
  })
}

// A remote of the hub, reached through its proxy: its tunnel is down (502) until a step brings it up.
let remoteDown = true
// The chat list never answers while set: a request still on its way when the app leaves the foreground.
let sessionsHang = false
// The AgentsServer this profile names, answering at both of its addresses (and, with another token, a different one).
const agentsServer = (name: string, token = 'token-a', identity = 'server-a') => server(name, (request, url, reply) => {
  if (url.pathname === '/api/connect-proof') return reply(200, { proof: proofFor(token, identity, url.searchParams.get('nonce') ?? '') })
  if (request.headers['x-zenithdock-token'] !== token && request.headers['x-agentsdock-token'] !== token) return reply(401, { detail: 'unauthorized' })
  if (url.pathname.startsWith('/api/remote/r1/')) {
    if (remoteDown) return reply(502, { detail: 'remote_unreachable' })
    if (url.pathname === '/api/remote/r1/api/health') return reply(200, { ok: true, server_identity: 'server-r1', server_instance_id: 'r1-1', api_contract_version: 8, active: [] })
    url.pathname = url.pathname.slice('/api/remote/r1'.length)
  }
  if (url.pathname === '/api/health') {
    return reply(200, { ok: true, server_identity: identity, server_instance_id: `${identity}-1`, api_contract_version: 8, active: [], capabilities: { connect_proof_v1: { available: true, version: 1 } } })
  }
  if (url.pathname === '/api/sessions') return sessionsHang ? undefined : reply(200, { sessions: [] })
  if (url.pathname === '/api/runtime/catalog') return reply(200, { backends: {} })
  if (url.pathname === '/api/jobs') return reply(200, { jobs: [] })
  reply(404, { detail: 'not found' })
})
const primary = agentsServer('primary')
const second = agentsServer('second')
const replacement = agentsServer('replacement', 'token-c', 'server-c')
// Someone else's device at the same LAN address on another network; another server holding the same token; an
// AgentsServer from before connect_proof_v1; an address that accepts and never answers.
const foreign = server('foreign', (_request, url, reply) => url.pathname === '/api/connect-proof'
  ? reply(200, { proof: proofFor('token-foreign', 'server-foreign', url.searchParams.get('nonce') ?? '') })
  : reply(401, { detail: 'unauthorized' }))
const sameToken = server('same-token', (_request, url, reply) => reply(200, { proof: proofFor('token-a', 'server-other', url.searchParams.get('nonce') ?? '') }))
const older = server('older', (_request, _url, reply) => reply(404, { detail: 'Not Found' }))
const silent = server('silent', () => undefined)

async function listen(value: Server): Promise<string> {
  await new Promise<void>(resolve => value.listen(0, '127.0.0.1', resolve))
  const address = value.address()
  assert(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

// Until no request has arrived for 200 ms: a reconnect's later requests belong to the step that started it.
async function settle(): Promise<void> {
  for (let seen = -1; seen !== log.length;) {
    seen = log.length
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

const servers = [primary, second, foreign, sameToken, older, silent, replacement]
const originalSetInterval = globalThis.setInterval
try {
  const [primaryURL, secondURL, foreignURL, sameTokenURL, olderURL, silentURL, replacementURL] = await Promise.all(servers.map(listen))
  ;(globalThis as { expo?: { uuidv4: () => string } }).expo = { uuidv4: randomUUID }
  await AsyncStorage.clear()
  ;(SecureStore as typeof SecureStore & { __resetSecureStore(): void }).__resetSecureStore()
  ;(Notifications as typeof Notifications & { __resetNotifications(): void }).__resetNotifications()
  const timestamp = '2026-11-03T06:00:00.000Z'
  const settings: StoredProfileSettings = {
    schemaVersion: 2,
    activeProfileId: 'mac',
    profiles: [
      { id: 'mac', name: 'Mac', serverURL: primaryURL, secondServerURL: secondURL, serverIdentity: 'server-a', connectProof: true, serverConfigured: true, credentialVersion: 1, createdAt: timestamp, updatedAt: timestamp },
      { id: 'r1', name: 'gpu box', serverURL: `${primaryURL}/api/remote/r1`, serverIdentity: null, serverConfigured: true, credentialVersion: 1, createdAt: timestamp, updatedAt: timestamp },
    ],
    fontScale: 1,
    appearance: 'dark',
  }
  await AsyncStorage.setItem('agentsdock.react.settings.v2', JSON.stringify(settings))
  const cache = await import('../storage/cache')
  await SecureStore.setItemAsync(cache.profileTokenKey('mac', 1), 'token-a')
  await SecureStore.setItemAsync(cache.profileTokenKey('r1', 1), 'token-a')
  // No periodic refresh: every logged request comes from the step that caused it.
  globalThis.setInterval = (() => 1) as unknown as typeof setInterval
  const store = await import('./useAppStore')
  const { useAppStore } = store
  const network = NetInfo as typeof NetInfo & { __emit(state: { type: string; isConnected: boolean; details: { ipAddress: string } }): void }
  const appState = NativeAppState as typeof NativeAppState & { __emitAppState(state: string): void }
  const after = (mark: number, name: string) => log.slice(mark).filter(entry => entry.server === name)

  // A cold start: the profile saved that its server advertises the proof. The first connection goes to the primary;
  // once NetInfo reports the network, the second address proves to be the same server with a nonce alone, and the
  // connection moves there.
  await useAppStore.getState().initialize()
  network.__emit({ type: 'wifi', isConnected: true, details: { ipAddress: '192.168.0.105' } })
  await waitFor(() => useAppStore.getState().secondAddressInUse !== null && useAppStore.getState().connected, 'the proven second address was not taken')
  assert.equal(store.client.baseURL, secondURL)
  assert.deepEqual(useAppStore.getState().secondAddressInUse, { profileId: 'mac', address: secondURL })
  const atSecond = after(0, 'second')
  assert.deepEqual(atSecond[0], { server: 'second', path: '/api/connect-proof', credential: false }, 'the first thing the second address sees is the proof, with no credential')
  assert.ok(atSecond.slice(1).some(entry => entry.path === '/api/health' && entry.credential), 'after the proof the connection runs there with its token')

  // A remote of the hub goes through the hub's proven second address too. Its hub answering 502 (the remote's tunnel
  // is down) came through that address, which stays.
  await settle()
  let mark = log.length
  assert.equal(await useAppStore.getState().switchServerProfile('r1'), true)
  await waitFor(() => after(mark, 'second').some(entry => entry.path === '/api/remote/r1/api/health'), 'the remote was not reached through the second address')
  await settle()
  assert.equal(store.client.baseURL, `${secondURL}/api/remote/r1`)
  assert.equal(after(mark, 'primary').length, 0, 'a remote that is down does not send the connection back to the primary')
  assert.equal(await useAppStore.getState().switchServerProfile('mac'), true)
  await waitFor(() => store.client.baseURL === secondURL && useAppStore.getState().connected, 'the hub did not come back at its second address')

  // A network change: nothing more goes to the second address until it proves itself again on the new network.
  await settle()
  mark = log.length
  network.__emit({ type: 'wifi', isConnected: true, details: { ipAddress: '10.20.0.7' } })
  await waitFor(() => after(mark, 'second').some(entry => entry.path === '/api/health'), 'the second address was not proved again after a network change')
  assert.deepEqual(after(mark, 'second')[0], { server: 'second', path: '/api/connect-proof', credential: false })
  await settle()
  assert.equal(log.slice(mark).filter(entry => entry.path === '/api/runtime/catalog').length, 0, 'moving between the addresses of one server process keeps its catalog')

  // On another network the same address is someone else's device: it gets one nonce, never the token, and the
  // primary takes the connection.
  mark = log.length
  await useAppStore.getState().updateServerProfile('mac', { secondServerURL: foreignURL })
  await waitFor(() => after(mark, 'foreign').length > 0 && store.client.baseURL === primaryURL && useAppStore.getState().connected, 'a failed proof did not fall back to the primary')
  assert.deepEqual(after(mark, 'foreign'), [{ server: 'foreign', path: '/api/connect-proof', credential: false }])
  assert.equal(useAppStore.getState().secondAddressInUse, null)
  network.__emit({ type: 'cellular', isConnected: true, details: { ipAddress: '100.103.188.26' } })
  await waitFor(() => after(mark, 'foreign').length === 2, 'a network change did not re-check the second address')
  assert.ok(after(mark, 'foreign').every(entry => entry.path === '/api/connect-proof' && !entry.credential), 'the foreign device never sees a credential')

  // Another server that holds the same token but is not the pinned identity, an AgentsServer without the route,
  // and an address that never answers: all stay on the primary and see no credential.
  for (const [name, address] of [['same-token', sameTokenURL], ['older', olderURL], ['silent', silentURL]] as const) {
    mark = log.length
    await useAppStore.getState().updateServerProfile('mac', { secondServerURL: address })
    await waitFor(() => after(mark, name).length > 0, `${name} was not probed`)
    // The silent one holds the proof until its 2.5 s timeout.
    await new Promise(resolve => setTimeout(resolve, name === 'silent' ? 2_700 : 100))
    assert.equal(store.client.baseURL, primaryURL, `${name}: the primary keeps the connection`)
    assert.deepEqual(after(mark, name), [{ server: name, path: '/api/connect-proof', credential: false }])
  }

  // Coming back to the foreground proves the second address again before the connection is used there.
  await useAppStore.getState().updateServerProfile('mac', { secondServerURL: secondURL })
  await waitFor(() => store.client.baseURL === secondURL && useAppStore.getState().connected, 'the second address was not taken again')
  await settle()
  // Leaving the foreground aborts a request still on its way there: back in the foreground, the phone may be on
  // another network, where that address is someone else's device.
  sessionsHang = true
  const inFlight = store.client.sessions()
  await waitFor(() => log.at(-1)?.path === '/api/sessions', 'the request did not reach the second address')
  appState.__emitAppState('background')
  await assert.rejects(inFlight, AgentServerClientUnvalidatedError)
  sessionsHang = false
  mark = log.length
  appState.__emitAppState('active')
  assert.equal(useAppStore.getState().connected, false, 'nothing waits on the connection until the proof')
  // A component that asks at once (a runtime panel refreshing on foreground) is refused before anything is sent.
  await assert.rejects(store.client.sessions(), AgentServerClientUnvalidatedError)
  assert.equal(after(mark, 'second').length, 0)
  await waitFor(() => after(mark, 'second').some(entry => entry.path === '/api/health'), 'the foreground did not reconnect at the second address')
  assert.deepEqual(after(mark, 'second')[0], { server: 'second', path: '/api/connect-proof', credential: false })

  // Pointing the profile at another server with its own token voids the second address's proof and what the profile
  // learned about the proof: the old address, still the previous server, never sees the new token. Pointing it back
  // learns the capability from the primary's health again, and the second address proves itself.
  await settle()
  mark = log.length
  await useAppStore.getState().updateServerProfile('mac', { serverURL: replacementURL, accessToken: 'token-c', resetServerIdentity: true })
  await waitFor(() => store.client.baseURL === replacementURL && useAppStore.getState().connected, 'the replacement server was not connected')
  await settle()
  assert.ok(after(mark, 'second').every(entry => !entry.credential), 'the old second address got no credential')
  await useAppStore.getState().updateServerProfile('mac', { serverURL: primaryURL, accessToken: 'token-a', resetServerIdentity: true })
  await waitFor(() => store.client.baseURL === secondURL && useAppStore.getState().connected, 'the original server and its second address did not come back')

  // A token saved again is a new credential: the connection restarts at the primary, and the second address proves
  // itself under it before the token goes there.
  await settle()
  mark = log.length
  await useAppStore.getState().updateServerProfile('mac', { accessToken: 'token-a' })
  await waitFor(() => store.client.baseURL === secondURL && after(mark, 'second').some(entry => entry.path === '/api/health'), 'a new token did not prove the second address again')
  assert.deepEqual(after(mark, 'second')[0], { server: 'second', path: '/api/connect-proof', credential: false })

  // The second address stops answering (the phone left the LAN): its next request fails, and the primary takes over
  // before any retry; the proof that follows fails too.
  second.closeAllConnections?.()
  await new Promise<void>(resolve => second.close(() => resolve()))
  mark = log.length
  await useAppStore.getState().refreshSessions()
  await waitFor(() => store.client.baseURL === primaryURL && useAppStore.getState().connected, 'a lost second address did not hand the connection to the primary')
  assert.ok(after(mark, 'primary').some(entry => entry.path === '/api/health' && entry.credential))

  // The second address answers again and the primary goes down: a failing primary tries the second address again,
  // although it lost the connection before on this network.
  await new Promise<void>(resolve => second.listen(Number(new URL(secondURL).port), '127.0.0.1', resolve))
  primary.closeAllConnections?.()
  await new Promise<void>(resolve => primary.close(() => resolve()))
  mark = log.length
  await useAppStore.getState().reconnect()
  await waitFor(() => store.client.baseURL === secondURL && useAppStore.getState().connected, 'a failing primary did not try the second address again')
  assert.deepEqual(after(mark, 'second')[0], { server: 'second', path: '/api/connect-proof', credential: false })

  // A remote connected through its hub's second address loses the hub profile: the address check closes, and the
  // next refresh moves the remote off that address.
  remoteDown = false
  assert.equal(await useAppStore.getState().switchServerProfile('r1'), true)
  await waitFor(() => store.client.baseURL === `${secondURL}/api/remote/r1` && useAppStore.getState().connected, 'the remote did not connect through the second address')
  await useAppStore.getState().removeServerProfile('mac')
  assert.equal(store.client.isAddressOpen, false)
  await useAppStore.getState().refreshSessions()
  await waitFor(() => store.client.baseURL === `${primaryURL}/api/remote/r1`, 'the remote stayed on the closed second address')
} finally {
  globalThis.setInterval = originalSetInterval
  for (const value of servers) {
    value.closeAllConnections?.()
    if (value.listening) await new Promise<void>(resolve => value.close(() => resolve()))
  }
}

console.log('second address store regressions passed')
