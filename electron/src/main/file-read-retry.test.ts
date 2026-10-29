// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// The retries wait seconds in the app; here each wait is only recorded.
const waits = vi.hoisted(() => [] as number[])
vi.mock('node:timers/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:timers/promises')>(),
  setTimeout: async (delay: number) => { waits.push(delay) }
}))
vi.mock('./logger', () => ({ appLog: vi.fn() }))

import { readFileWithRetry } from './file-read-retry'

type Answer = (request: IncomingMessage, response: ServerResponse) => void
const servers: Array<() => void> = []

// The shared setup stubs fetch to keep analytics off the network; these reads use the real one.
beforeEach(() => vi.unstubAllGlobals())
afterEach(() => {
  waits.length = 0
  while (servers.length) servers.pop()?.()
})

function hubAnswer(status: number, body: unknown, contentType = 'application/json'): Answer {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': contentType })
    response.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
}

const tunnelFailure = (code: string, status = 502) => hubAnswer(status, { detail: { code, remote_id: '044be05ef472', message: 'ReadError' } })
const file: Answer = (_request, response) => { response.end('file bytes') }

/** A hub on loopback that gives `answers` in turn and the file after them. */
async function hub(...answers: Answer[]) {
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    ;(answers.shift() ?? file)(request, response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(() => server.close())
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`
  return {
    read: () => readFileWithRetry(() => fetch(url), async response => `${response.status} ${await response.text()}`),
    requests: () => requests,
    stop: () => new Promise<void>(resolve => server.close(() => resolve()))
  }
}

describe('file reads after a dropped hub tunnel', () => {
  it.each([
    ['remote_proxy_error', 502],
    ['remote_unreachable', 502],
    ['remote_timeout', 504]
  ])('sends again after the hub answers %s (%i)', async (code, status) => {
    const server = await hub(tunnelFailure(code, status))

    await expect(server.read()).resolves.toBe('200 file bytes')

    expect(server.requests()).toBe(2)
    expect(waits).toEqual([2_000])
  })

  it.each([
    ['the remote is not registered', 404, hubAnswer(404, { detail: { code: 'remote_not_found', remote_id: 'gone' } })],
    ['authorization fails', 401, hubAnswer(401, { detail: 'unauthorized' })],
    ['a 503 carries no hub tunnel code', 503, hubAnswer(503, { detail: 'state is not ready' })],
    ['a proxy answers with a page', 502, hubAnswer(502, '<html>Bad Gateway</html>', 'text/html')],
    ['the status is not a gateway failure', 500, hubAnswer(500, { detail: { code: 'remote_proxy_error' } })]
  ])('returns the answer without retrying when %s', async (_case, status, answer) => {
    const server = await hub(answer)

    await expect(server.read()).resolves.toMatch(new RegExp(`^${status} `))

    expect(server.requests()).toBe(1)
    expect(waits).toEqual([])
  })

  it('sends again after the connection closes before the answer and while the body arrives', async () => {
    const server = await hub(
      request => request.socket.destroy(),
      (request, response) => {
        response.writeHead(200, { 'content-length': '100' })
        response.write('partial', () => request.socket.resetAndDestroy())
      },
      (request, response) => {
        response.writeHead(200, { 'content-length': '100', connection: 'close' })
        response.write('partial', () => request.socket.end())
      }
    )

    await expect(server.read()).resolves.toBe('200 file bytes')

    expect(server.requests()).toBe(4)
    expect(waits).toEqual([2_000, 4_000, 8_000])
  })

  it('does not send again when no server listens', async () => {
    const server = await hub()
    await server.stop()

    await expect(server.read()).rejects.toMatchObject({ cause: { code: 'ECONNREFUSED' } })

    expect(waits).toEqual([])
  })

  it('returns the last tunnel failure after retries 2, 4 and 8 s apart', async () => {
    const failure = tunnelFailure('remote_proxy_error')
    const server = await hub(failure, failure, failure, failure)

    await expect(server.read()).resolves.toMatch(/^502 \{"detail":\{"code":"remote_proxy_error"/)

    expect(server.requests()).toBe(4)
    expect(waits).toEqual([2_000, 4_000, 8_000])
  })
})
