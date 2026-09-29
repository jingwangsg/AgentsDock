import { describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AgentServerClient } from './server-client'

const fakeToken = 'sk-ant-oat01-synthetic_token-not-a-credential'

async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>, run: (url: string) => Promise<void>) {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); void handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`) }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}

describe('native Claude token transport', () => {
  it('puts the token in the body of the native admin route only', async () => {
    const calls: Array<{ method?: string; url?: string; headers: IncomingMessage['headers']; body: string }> = []
    await withServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      calls.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
      res.end(JSON.stringify({ oauth_token_configured: true }))
    }, async url => {
      const client = new AgentServerClient(`${url}/mounted`, 'synthetic-admin-token')
      try { await client.setClaudeToken(fakeToken) }
      finally { client.dispose() }
    })
    expect(calls.map(call => [call.method, call.url])).toEqual([['PUT', '/mounted/api/admin/claude/token']])
    expect(JSON.parse(calls[0].body)).toEqual({ token: fakeToken })
    expect(calls[0].headers['x-agentsdock-token']).toBe('synthetic-admin-token')
    for (const header of ['origin', 'cookie', 'authorization']) expect(calls[0].headers[header]).toBeUndefined()
  })

  it.each([[400, 'INVALID'], [413, 'INVALID'], [401, 'FAILED'], [500, 'FAILED']])(
    'maps HTTP %s to CLAUDE_TOKEN_%s without echoing the server body', async (status, code) => {
      await withServer((_req, res) => { res.statusCode = Number(status); res.end(JSON.stringify({ detail: fakeToken })) }, async url => {
        const client = new AgentServerClient(url, 'synthetic-token')
        try {
          const error = await client.setClaudeToken(fakeToken).then(() => null, (reason: unknown) => reason as Error)
          expect(error?.message).toBe(`CLAUDE_TOKEN_${code}`)
        } finally { client.dispose() }
      })
    }
  )
})
