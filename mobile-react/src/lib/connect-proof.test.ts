import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { addressProvesServer, hmacSha256Hex } from './connect-proof'

// RFC 4231 case 2; a key longer than the block, against Node's HMAC; then lengths around SHA-256's padding boundaries.
assert.equal(hmacSha256Hex('Jefe', 'what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
assert.equal(
  hmacSha256Hex('\xaa'.repeat(131), 'Test Using Larger Than Block-Size Key - Hash Key First'),
  createHmac('sha256', Buffer.from(new TextEncoder().encode('\xaa'.repeat(131)))).update('Test Using Larger Than Block-Size Key - Hash Key First').digest('hex'),
)
for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
  const message = 'm'.repeat(length)
  assert.equal(hmacSha256Hex('k3y-é', message), createHmac('sha256', 'k3y-é').update(message).digest('hex'), `message of ${length} bytes`)
}

// The nonce comes from the Expo runtime's native UUIDv4; this test uses Node's.
;(globalThis as { expo?: { uuidv4: () => string } }).expo = { uuidv4: randomUUID }
const token = 'hub-token-0123456789abcdef0123456789abcdef'
const identity = 'c18f6435f5ee15b0483471f5'
// The server's side, as agent_server.connect_proof computes it.
const serverProof = (nonce: string, key = token, serverIdentity = identity) => createHmac('sha256', key).update(`agentsdock-connect-proof-v1\n${nonce}\n${serverIdentity}`).digest('hex')
const requests: Array<{ url: string; init?: RequestInit }> = []
// A response names the URL it came from: here, the address asked unless a test says otherwise.
const from = (response: Response, url: string) => Object.defineProperty(response, 'url', { value: url })
const answering = (answer: (nonce: string) => Response | Promise<Response>): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
  requests.push({ url: String(input), init })
  return from(await answer(new URL(String(input)).searchParams.get('nonce') ?? ''), String(input))
}) as typeof fetch
const json = (value: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(value)
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length), ...headers } })
}

// The same server at its second address: the proof matches.
assert.equal(await addressProvesServer('192.168.0.101:7850', token, identity, answering(nonce => json({ proof: serverProof(nonce) }))), true)
const request = requests.at(-1)!
assert.match(request.url, /^http:\/\/192\.168\.0\.101:7850\/api\/connect-proof\?nonce=[0-9a-f]{64}$/, 'only the nonce goes to the address')
assert.equal(request.init?.credentials, 'omit')
assert.equal(request.init?.headers, undefined, 'no token header of any kind')
assert.ok(!request.url.includes(token))
const nonces = new Set(requests.map(value => new URL(value.url).searchParams.get('nonce')))
await addressProvesServer('192.168.0.101:7850', token, identity, answering(nonce => json({ proof: serverProof(nonce) })))
assert.equal(new Set(requests.map(value => new URL(value.url).searchParams.get('nonce'))).size, nonces.size + 1, 'every proof has a fresh nonce')

// Another device, another server, or a replayed answer: never a match.
assert.equal(await addressProvesServer('192.168.0.101:7850', token, identity, answering(nonce => json({ proof: serverProof(nonce, 'another-servers-token') }))), false)
assert.equal(await addressProvesServer('192.168.0.101:7850', token, identity, answering(nonce => json({ proof: serverProof(nonce, token, 'another-identity') }))), false)
const replayed = serverProof('0'.repeat(64))
assert.equal(await addressProvesServer('192.168.0.101:7850', token, identity, answering(() => json({ proof: replayed }))), false)
assert.equal(await addressProvesServer('192.168.0.101:7850', token, identity, answering(nonce => json({ proof: serverProof(nonce).toUpperCase() }))), false)
assert.equal(await addressProvesServer('192.168.0.101:7850', token, identity, answering(nonce => json({ proof: serverProof(nonce) + '00' }))), false)
// A redirect, even to the real server's own answer: the address could forward the nonce there and pass the reply on.
assert.equal(await addressProvesServer('192.168.0.101:7850', token, identity, answering(() => new Response(null, { status: 302, headers: { Location: 'http://100.81.112.90:7850/api/connect-proof' } }))), false)
assert.equal(requests.at(-1)!.init?.redirect, 'error')
assert.equal(await addressProvesServer('192.168.0.101:7850', token, identity, (async (input: RequestInfo | URL) => {
  const nonce = new URL(String(input)).searchParams.get('nonce') ?? ''
  return Object.defineProperty(from(json({ proof: serverProof(nonce) }), String(input)), 'redirected', { value: true })
}) as typeof fetch), false, 'an answer that came through a redirect is refused even when it verifies')
// React Native's own fetch follows a redirect silently; only the final URL tells.
assert.equal(await addressProvesServer('192.168.0.101:7850', token, identity, (async (input: RequestInfo | URL) => {
  const nonce = new URL(String(input)).searchParams.get('nonce') ?? ''
  return from(json({ proof: serverProof(nonce) }), `http://100.81.112.90:7850/api/connect-proof?nonce=${nonce}`)
}) as typeof fetch), false, 'an answer from another URL is refused even when it verifies')
// An older server (no route), an error, junk, an oversized or unsized body, a refused or silent address.
assert.equal(await addressProvesServer('192.168.0.101:7850', token, identity, answering(() => new Response('{"detail":"Not Found"}', { status: 404 }))), false)
assert.equal(await addressProvesServer('192.168.0.101:7850', token, identity, answering(() => new Response('not json', { status: 200, headers: { 'Content-Length': '8' } }))), false)
assert.equal(await addressProvesServer('192.168.0.101:7850', token, identity, answering(nonce => json({ proof: serverProof(nonce), pad: 'x'.repeat(2_000) }))), false)
assert.equal(await addressProvesServer('192.168.0.101:7850', token, identity, answering(nonce => new Response(JSON.stringify({ proof: serverProof(nonce) }), { status: 200 }))), false)
assert.equal(await addressProvesServer('192.168.0.101:7850', token, identity, (async () => { throw new TypeError('Network request failed') }) as typeof fetch), false)
const started = Date.now()
const silent = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
})) as typeof fetch
assert.equal(await addressProvesServer('192.168.0.101:7850', token, identity, silent, 50), false)
assert.ok(Date.now() - started < 1_000, 'a silent address times out')

console.log('connect proof regressions passed')
