import assert from 'node:assert/strict'

import { parentDirectory } from './working-directory-path'

// Same cases as the desktop suite: POSIX, relative, Windows drive and UNC roots.
for (const [path, expected] of [
  ['/', '/'],
  ['/srv/work/', '/srv'],
  ['relative', 'relative'],
  ['relative/child', 'relative'],
  ['C:\\', 'C:\\'],
  ['C:\\Users\\me', 'C:\\Users'],
  ['C:/', 'C:/'],
  ['C:/Users/me', 'C:/Users'],
  ['\\\\server\\share', '\\\\server\\share'],
  ['\\\\server\\share\\folder', '\\\\server\\share'],
]) {
  assert.equal(parentDirectory(path), expected, `parent of ${path}`)
}

console.log('working directory path regressions passed')
