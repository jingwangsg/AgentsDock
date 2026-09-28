import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'

// The WebView evaluates the CodeMirror entry as one IIFE, and esbuild turns its
// top-level const/class declarations into `var`. Anything the boot code reads
// before its declaration is `undefined`, which CodeMirror reports as
// "Cannot read properties of undefined (reading 'extension')" and the app falls
// back to the plain-text editor. Run the same bundle and stop at the first DOM
// call: reaching it proves the initial editor state configured.
test('the CodeMirror entry configures its initial state before touching the DOM', async () => {
  const result = await build({
    entryPoints: [resolve('scripts/code-editor-entry.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['safari16.4'],
    logLevel: 'silent',
  })
  const domReached = new Error('EditorView reached the DOM')
  const element = { style: {} }
  const document = {
    documentElement: element,
    getElementById: () => element,
    createElement: () => { throw domReached },
    addEventListener() {},
  }
  const window = { document, navigator: { userAgent: '', vendor: '', platform: '' }, addEventListener() {} }
  const context = vm.createContext({ ...window, window, self: window, queueMicrotask, setTimeout, clearTimeout })

  assert.throws(() => vm.runInContext(result.outputFiles[0].text, context), error => error === domReached)
})
