import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const view = await readFile(resolve('src/components/BrowserView.tsx'), 'utf8')

test('a browser tab loads its page through its own server, never from the shared web view cache', () => {
  // Two servers' tabs at one address share the cache entry; cookies and logins stay, as on the desktop.
  assert.match(view, /cacheEnabled=\{false\}/)
  assert.doesNotMatch(view, /incognito/)
})
