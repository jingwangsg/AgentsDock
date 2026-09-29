import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MIN_ELECTRON_MAIN_ENTRY_BYTES,
  verifyElectronCompileOutput,
  verifyMonacoCodiconFont
} from '../verify_electron_compile_output.mjs'

function createProject(t, { main = './out/main/index.js', size = MIN_ELECTRON_MAIN_ENTRY_BYTES } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'agentsdock-electron-output-'))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  writeFileSync(join(project, 'package.json'), JSON.stringify({ main }))
  if (main === './out/main/index.js') {
    mkdirSync(join(project, 'out', 'main'), { recursive: true })
    writeFileSync(join(project, 'out', 'main', 'index.js'), Buffer.alloc(size, 1))
  }
  return project
}

test('accepts a regular compiled main entry at the minimum size', t => {
  const project = createProject(t)
  const result = verifyElectronCompileOutput(project)
  assert.equal(result.size, MIN_ELECTRON_MAIN_ENTRY_BYTES)
})

test('rejects a zero-byte compiled main entry before packaging', t => {
  const project = createProject(t, { size: 0 })
  assert.throws(
    () => verifyElectronCompileOutput(project),
    /is too small: 0 bytes/
  )
})

test('rejects a truncated compiled main entry before packaging', t => {
  const project = createProject(t, { size: MIN_ELECTRON_MAIN_ENTRY_BYTES - 1 })
  assert.throws(
    () => verifyElectronCompileOutput(project),
    new RegExp(`expected at least ${MIN_ELECTRON_MAIN_ENTRY_BYTES}`)
  )
})

test('rejects a main entry outside the Electron project', t => {
  const project = createProject(t, { main: '../outside.mjs' })
  assert.throws(
    () => verifyElectronCompileOutput(project),
    /escapes its project directory/
  )
})

function createRendererAssets(t, files) {
  const project = mkdtempSync(join(tmpdir(), 'agentsdock-electron-assets-'))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const assets = join(project, 'out', 'renderer', 'assets')
  mkdirSync(assets, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(assets, name), content)
  return project
}

test('accepts a Monaco stylesheet whose codicon font was emitted', t => {
  const project = createRendererAssets(t, {
    'monaco-abc.css': '.monaco-editor{}@font-face{font-family:codicon;font-display:block;src:url(./codicon-x1.ttf) format("truetype")}',
    'codicon-x1.ttf': 'font'
  })
  assert.deepEqual(verifyMonacoCodiconFont(project), { stylesheet: 'monaco-abc.css', font: './codicon-x1.ttf' })
})

test('rejects a Monaco build that shipped codicon classes without the font', t => {
  const project = createRendererAssets(t, {
    'monaco-abc.css': '.monaco-editor{}.codicon-diff-insert:before{content:"\\ea60"}'
  })
  assert.throws(() => verifyMonacoCodiconFont(project), /No built stylesheet declares the Monaco codicon font/)
})

test('rejects a codicon font-face whose font file is missing', t => {
  const project = createRendererAssets(t, {
    'monaco-abc.css': '@font-face{font-family:"codicon";src:url(./codicon-x1.ttf) format("truetype")}'
  })
  assert.throws(() => verifyMonacoCodiconFont(project), /codicon-x1\.ttf referenced by monaco-abc\.css is missing/)
})
