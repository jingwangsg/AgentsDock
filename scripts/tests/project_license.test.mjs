import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const json = (path) => JSON.parse(read(path))

test('project license is the unmodified Apache License 2.0 text', () => {
  // https://www.apache.org/licenses/LICENSE-2.0.txt
  assert.equal(
    createHash('sha256').update(read('LICENSE')).digest('hex'),
    'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
  )
  assert.match(read('NOTICE'), /Copyright 2026 Zhengyi Luo and contributors/)
  assert.match(read('README.md'), /\[Apache License 2\.0\]\(LICENSE\)/)
})

test('first-party package metadata declares Apache-2.0', () => {
  for (const path of ['electron/package.json', 'mobile-react/package.json', 'website/package.json']) {
    assert.equal(json(path).license, 'Apache-2.0', path)
  }
  assert.match(read('team-hub/pyproject.toml'), /^license = \{text = "Apache-2\.0"\}$/m)
})

test('Electron packages include project notices without replacing vendor licenses', () => {
  const resources = json('electron/package.json').build.extraResources
  for (const name of ['LICENSE', 'NOTICE']) {
    assert.ok(resources.some(resource =>
      resource.from === `../${name}` && resource.to === `licenses/AgentsDock-${name}`
    ), `${name} must be copied from the repository into the packaged resources`)
    assert.ok(read(name).length > 0)
  }
})

test('the iOS terminal font keeps its Android Open Source Project attribution', () => {
  assert.match(read('NOTICE'), /Droid Sans Mono[\s\S]*modified line metrics[\s\S]*The Android Open Source Project, licensed under the Apache License, Version 2\.0/)
  const terminalFont = read('mobile-react/src/terminal/terminalFont.ios.ts')
  assert.match(terminalFont, /Copyright \(c\) 2005-2008, The Android Open Source Project; Apache License 2\.0/)
  // The embedded font is the one the documented command produces.
  const embedded = Buffer.from(terminalFont.match(/base64,([A-Za-z0-9+/=]+)/)[1], 'base64')
  assert.ok(terminalFont.includes(`result sha256 ${createHash('sha256').update(embedded).digest('hex')}`))
})

test('the iOS Material fonts keep their notices and are the files their recorded commands made', () => {
  const notice = read('NOTICE')
  assert.match(notice, /Roboto Regular and Medium[\s\S]*?Copyright 2011 Google Inc\.,\s+licensed under the Apache License, Version 2\.0/)
  assert.match(notice, /subsets of the Android 15\s+Noto Sans Symbols font[\s\S]*?Copyright 2013 Google Inc\., licensed under the SIL Open Font License,\s+Version 1\.1/)
  assert.match(read('mobile-react/assets/fonts/roboto/LICENSE.txt'), /Licensed under the Apache License, Version 2\.0[\s\S]*END OF TERMS AND CONDITIONS/)
  assert.match(read('mobile-react/assets/fonts/noto-sans-symbols/OFL.txt'), /licensed under the SIL Open Font License, Version 1\.1[\s\S]*SIL OPEN FONT LICENSE Version 1\.1/)
  const provenance = read('mobile-react/src/components/material/materialTheme.ts')
  for (const font of ['roboto/Roboto-Regular.ttf', 'roboto/Roboto-Medium.ttf', 'noto-sans-symbols/NotoSansSymbols-Check.ttf']) {
    const sha256 = createHash('sha256').update(readFileSync(new URL(`mobile-react/assets/fonts/${font}`, root))).digest('hex')
    assert.ok(provenance.includes(sha256), `${font} (${sha256}) is not the result recorded in materialTheme.ts`)
  }
})

test('separately licensed mobile components retain their MIT notices', () => {
  assert.match(read('mobile-react/LICENSE'), /650 Industries, Inc\. \(aka Expo\)/)
  assert.match(read('mobile-react/LICENSE'), /Permission is hereby granted, free of charge/)
  for (const module of ['agentsdock-native-video', 'agentsdock-native-terminal', 'agentsdock-android-updater']) {
    assert.equal(json(`mobile-react/modules/${module}/package.json`).license, 'MIT')
    assert.ok(read('NOTICE').includes(module))
  }
})
