import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const view = await readFile(resolve('src/components/BrowserView.tsx'), 'utf8')

test('a browser tab loads its page through its own server, never from the shared web view cache', () => {
  // Android web views share one HTTP cache keyed by URL, which showed one server's page in another server's
  // tab at the same address. incognito would also stop that, but it deletes the app's cookies and site logins.
  assert.match(view, /cacheEnabled=\{false\}/)
  assert.doesNotMatch(view, /incognito/)
})
