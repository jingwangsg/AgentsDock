import assert from 'node:assert/strict'

import { photoAssetsToUploads } from '../lib/uploads'
import { AgentServerClient, AgentServerClientDisposedError, ServerError } from './AgentServerClient'

type Progress = { lengthComputable: boolean; loaded: number; total: number }

/** React Native's XMLHttpRequest, as far as upload() drives it; the test fires the events. */
class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = []
  method = ''
  url = ''
  headers: Record<string, string> = {}
  timeout = 0
  body: unknown
  aborted = false
  status = 0
  responseText = ''
  upload: { onprogress: ((event: Progress) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null

  constructor() { FakeXMLHttpRequest.instances.push(this) }
  open(method: string, url: string): void { this.method = method; this.url = url }
  setRequestHeader(key: string, value: string): void { this.headers[key] = value }
  send(body: unknown): void { this.body = body }
  abort(): void { this.aborted = true; this.onabort?.() }

  progress(loaded: number, total: number): void { this.upload.onprogress?.({ lengthComputable: true, loaded, total }) }
  respond(status: number, body: string): void { this.status = status; this.responseText = body; this.onload?.() }
}

class RawFormData {
  readonly parts: Array<[string, unknown]> = []
  append(name: string, value: unknown): void { this.parts.push([name, value]) }
}

const originalXHR = globalThis.XMLHttpRequest
const originalFormData = globalThis.FormData
globalThis.XMLHttpRequest = FakeXMLHttpRequest as unknown as typeof XMLHttpRequest
globalThis.FormData = RawFormData as unknown as typeof FormData

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const nextRequest = () => {
  const request = FakeXMLHttpRequest.instances.shift()
  assert(request, 'no upload request was sent')
  return request
}
const ok = JSON.stringify({ file: { id: 'uploaded-file', filename: 'photo-1234-1.png' } })
const client = (options: ConstructorParameters<typeof AgentServerClient>[2] = {}) =>
  new AgentServerClient('https://upload.example', 'upload-token', options)

try {
  const [photo] = photoAssetsToUploads([{ uri: 'file:///picker/render', mimeType: 'image/png' }], 1234)
  assert(photo)

  // The file goes as a `uri` part under the picker's display name, with the token, to the
  // chat's endpoint; the native idle timer is pushed out to the ceiling.
  {
    const uploads = client()
    const pending = uploads.upload('session /?', photo)
    const request = nextRequest()
    assert.equal(request.method, 'POST')
    assert.equal(request.url, 'https://upload.example/api/sessions/session%20%2F%3F/files')
    assert.deepEqual(request.headers, { 'X-ZenithDock-Token': 'upload-token' })
    assert.equal(request.timeout, 8 * 60 * 60_000)
    assert(request.body instanceof RawFormData)
    assert.deepEqual(request.body.parts, [['file', { uri: 'file:///picker/render', name: 'photo-1234-1.png', type: 'image/png' }]])
    request.progress(512, 1024)
    request.progress(1024, 1024)
    request.respond(200, ok)
    assert.equal((await pending).filename, 'photo-1234-1.png')
    assert.equal(request.aborted, false)
    uploads.dispose()
  }

  // A non-2xx answer is the server's rejection, with its detail.
  {
    const uploads = client()
    const pending = uploads.upload('session', photo)
    const request = nextRequest()
    request.progress(1024, 1024)
    request.respond(413, JSON.stringify({ detail: { message: 'File too large' } }))
    await assert.rejects(pending, (error: unknown) => error instanceof ServerError && error.status === 413 && error.message === 'File too large')
    uploads.dispose()
  }

  // No byte taken within the stall window: the request is aborted and the failure names the stall.
  {
    const uploads = client({ uploadStallTimeoutMs: 30 })
    const pending = uploads.upload('session', photo)
    const request = nextRequest()
    await assert.rejects(pending, (error: Error) => error.name === 'TimeoutError' && error.message === 'The upload stalled.')
    assert.equal(request.aborted, true)
    uploads.dispose()
  }

  // Progress keeps resetting the stall window; the deadline is not a function of size.
  {
    const uploads = client({ uploadStallTimeoutMs: 300 })
    const pending = uploads.upload('session', photo)
    const request = nextRequest()
    for (let sent = 1; sent <= 16; sent += 1) {
      await sleep(25)
      request.progress(sent * 50, 1000)
    }
    request.progress(1000, 1000)
    request.respond(200, ok)
    assert.equal((await pending).filename, 'photo-1234-1.png')
    uploads.dispose()
  }

  // After the last byte the longer response window applies; a silent server ends it.
  {
    const uploads = client({ uploadStallTimeoutMs: 1000, uploadResponseTimeoutMs: 30 })
    const pending = uploads.upload('session', photo)
    const request = nextRequest()
    request.progress(1000, 1000)
    await assert.rejects(pending, (error: Error) => error.name === 'TimeoutError' && error.message === 'The server did not answer the upload.')
    assert.equal(request.aborted, true)
    uploads.dispose()
  }

  // The ceiling still ends an upload that keeps trickling, and is what the platform is told too.
  {
    const uploads = client({ uploadStallTimeoutMs: 1000, uploadTimeoutMs: 30 })
    const pending = uploads.upload('session', photo)
    const request = nextRequest()
    assert.equal(request.timeout, 30)
    await assert.rejects(pending, (error: Error) => error.name === 'TimeoutError' && error.message === 'The upload took too long.')
    assert.equal(request.aborted, true)
    uploads.dispose()
  }

  // The platform's own deadline (Android applies the timeout to the whole call) reads the same.
  {
    const uploads = client()
    const pending = uploads.upload('session', photo)
    const request = nextRequest()
    request.ontimeout?.()
    await assert.rejects(pending, (error: Error) => error.name === 'TimeoutError' && error.message === 'The upload took too long.')
    uploads.dispose()
  }

  // Disposing the client mid-upload aborts the request and reports the scope change, not a stall.
  {
    const uploads = client()
    const pending = uploads.upload('session', photo)
    const request = nextRequest()
    uploads.dispose()
    await assert.rejects(pending, AgentServerClientDisposedError)
    assert.equal(request.aborted, true)
  }

  // A transport failure surfaces the platform's message.
  {
    const uploads = client()
    const pending = uploads.upload('session', photo)
    const request = nextRequest()
    request.responseText = 'Network request failed'
    request.onerror?.()
    await assert.rejects(pending, /Network request failed/)
    uploads.dispose()
  }

  // A source whose bytes cannot be read fails before any request, with the readable hint.
  {
    const uploads = client()
    await assert.rejects(uploads.upload('session', { uri: 'file:///picker/IMG_0042.HEIC#unreadable', name: 'Vacation.heic', type: 'image/heic' }), /Couldn’t read “Vacation\.heic”/)
    assert.equal(FakeXMLHttpRequest.instances.length, 0)
    uploads.dispose()
  }
} finally {
  globalThis.XMLHttpRequest = originalXHR
  globalThis.FormData = originalFormData
}

console.log('native upload request regressions passed')
