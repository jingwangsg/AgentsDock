import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('chat attachment images use the disk cache key without the server address', () => {
  const grid = read('src/components/MediaGrid.tsx')
  const composer = read('src/components/Composer.tsx')
  const artifact = read('src/components/file-viewer/ArtifactFileViewerModal.tsx')
  const preview = read('src/components/file-viewer/FilePreview.tsx')
  assert.match(grid, /<Image source=\{attachmentImageSource\(connection\.client, connection\.sessionId, file\.id\)\}/)
  assert.equal(composer.match(/attachmentImageSource\(client, sessionId, (?:file\.id|fileId)\)/g)?.length, 2)
  // The full-screen preview reads the thumbnail's cached copy.
  assert.match(artifact, /imageCacheKeys=\{kind === 'image' \? \{ \[artifactURL\]: attachmentCacheKey\(connection\.sessionId, file\.id\) \}/)
  assert.match(preview, /cacheKey: imageCacheKeys\?\.\[activePreviewURL\]/)
  for (const source of [grid, composer]) assert.doesNotMatch(source, /uri: (?:connection\.)?client\.fileURL\(/)
})
