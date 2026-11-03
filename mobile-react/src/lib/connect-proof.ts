// A server's second address (its LAN address beside the Tailscale one) is used only once it proves to be that same
// server. The app sends a fresh nonce and nothing else; the server answers HMAC-SHA256, keyed by its access token, of
// the nonce and its identity (agent_server.connect_proof). Only a server that holds this profile's token and has the
// identity pinned for the profile can answer, so the token never reaches an address that has not proved it.
import { normalizeServerURL } from './format'

const PROOF_TIMEOUT_MS = 2_500
// The answer is {"proof": "<64 hex>"}; anything much larger is not the server.
const PROOF_MAX_BYTES = 1_024

/** Whether `address` answers the connect proof for `identity` under `token`. Every failure (refused, timed out, no such route, wrong answer) is false. */
export async function addressProvesServer(
  address: string,
  token: string,
  identity: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = PROOF_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // 244 random bits: two UUIDv4 from Expo's native generator (SecureRandom on Android, the system CSPRNG on iOS).
    const uuidv4 = (globalThis as { expo?: { uuidv4?: () => string } }).expo?.uuidv4
    if (!uuidv4) return false
    const nonce = `${uuidv4()}${uuidv4()}`.replace(/-/g, '').toLowerCase()
    // load-bearing: no token header, no cookie; the nonce is all this address learns. A redirect is refused: the
    // address could forward the nonce to the real server and pass on its answer. React Native's own fetch follows
    // redirects regardless and reports neither `redirected` nor an error, only the final `url`.
    const url = `${normalizeServerURL(address)}/api/connect-proof?nonce=${nonce}`
    const response = await fetchImpl(url, { credentials: 'omit', redirect: 'error', signal: controller.signal })
    const length = response.headers.get('content-length')
    if (!response.ok || response.redirected || response.url !== url || length === null || !(Number(length) <= PROOF_MAX_BYTES)) return false
    const { proof } = await response.json() as { proof?: unknown }
    return typeof proof === 'string' && constantTimeEqual(proof, hmacSha256Hex(token, `agentsdock-connect-proof-v1\n${nonce}\n${identity}`))
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** No early exit at the first differing character: the comparison's time says nothing about the expected proof. */
function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length
  for (let index = 0; index < right.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

/** HMAC-SHA256 (RFC 2104) of the UTF-8 `message` under the UTF-8 `key`, in lowercase hex. Hermes has no Web Crypto. */
export function hmacSha256Hex(key: string, message: string): string {
  let keyBytes: Uint8Array = new TextEncoder().encode(key)
  if (keyBytes.length > 64) keyBytes = sha256(keyBytes)
  const inner = new Uint8Array(64)
  const outer = new Uint8Array(64)
  for (let index = 0; index < 64; index += 1) {
    inner[index] = (keyBytes[index] ?? 0) ^ 0x36
    outer[index] = (keyBytes[index] ?? 0) ^ 0x5c
  }
  const digest = sha256(concat(outer, sha256(concat(inner, new TextEncoder().encode(message)))))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length)
  joined.set(left)
  joined.set(right, left.length)
  return joined
}

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** SHA-256 (FIPS 180-4) of `bytes`. */
function sha256(bytes: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000))
  view.setUint32(padded.length - 4, (bytes.length << 3) >>> 0)
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const words = new Uint32Array(64)
  const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits))
  for (let block = 0; block < padded.length; block += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(block + index * 4)
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotate(words[index - 15], 7) ^ rotate(words[index - 15], 18) ^ (words[index - 15] >>> 3)
      const s1 = rotate(words[index - 2], 17) ^ rotate(words[index - 2], 19) ^ (words[index - 2] >>> 10)
      words[index] = words[index - 16] + s0 + words[index - 7] + s1
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let index = 0; index < 64; index += 1) {
      const t1 = h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + ROUND_CONSTANTS[index] + words[index]
      const t2 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    hash[0] += a
    hash[1] += b
    hash[2] += c
    hash[3] += d
    hash[4] += e
    hash[5] += f
    hash[6] += g
    hash[7] += h
  }
  const digest = new Uint8Array(32)
  const out = new DataView(digest.buffer)
  hash.forEach((value, index) => out.setUint32(index * 4, value))
  return digest
}
