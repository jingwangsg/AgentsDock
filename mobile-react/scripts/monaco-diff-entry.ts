// Only the editor core and the basic-languages tokenizers: no TypeScript/JSON/
// CSS/HTML language services, same as electron/src/renderer/src/lib/monaco.ts.
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/basic-languages/monaco.contribution'
import { languageIdForPath, type MonacoDiffModel } from '../src/lib/monaco-diff-model'

// Host protocol. Host -> page: {type:'load', path, original, modified,
// originalLineNumbers, modifiedLineNumbers, conflicts, sideBySide, wordWrap,
// theme, fontSize} replaces the documents; {type:'options', sideBySide?,
// wordWrap?, theme?} restyles the current ones. Page -> host: {type:'ready'}
// once the editor exists, {type:'error', message} for any failure. The newest
// load wins outright, so no sequence numbers are needed.
interface LoadMessage extends MonacoDiffModel {
  type: 'load'
  path: string
  sideBySide: boolean
  wordWrap: boolean
  theme: 'dark' | 'light'
  fontSize: number
}

interface OptionsMessage {
  type: 'options'
  sideBySide?: boolean
  wordWrap?: boolean
  theme?: 'dark' | 'light'
}

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void }
    MonacoEnvironment?: { getWorker: (moduleId: string, label: string) => Worker }
  }
}

function post(message: { type: 'ready' } | { type: 'error'; message: string }): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify(message))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

window.addEventListener('error', event => post({ type: 'error', message: describe(event.error ?? event.message) }))

// A page loaded from an HTML string has no URL to spawn a worker from, and a
// worker that fails asynchronously leaves Monaco waiting forever for its first
// reply. Throwing here makes EditorWorkerClient fall back synchronously to its
// documented in-process worker (SynchronousWorkerClient), so diffs compute on
// the main thread.
window.MonacoEnvironment = {
  getWorker: () => { throw new Error('Web workers are unavailable inside the review WebView; Monaco computes diffs on the main thread.') },
}

// Transparent backgrounds let the host's palette colour show through; the
// rest stays the built-in vs / vs-dark palette, as on desktop.
for (const [name, base] of [['agentsdock-light', 'vs'], ['agentsdock-dark', 'vs-dark']] as const) {
  monaco.editor.defineTheme(name, {
    base,
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#00000000', 'editorGutter.background': '#00000000' },
  })
}

const host = document.getElementById('editor')
if (!host) throw new Error('Diff editor host is unavailable.')

let editor: monaco.editor.IStandaloneDiffEditor | null = null
let models: { original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null = null

function applyTheme(theme: 'dark' | 'light'): void {
  monaco.editor.setTheme(theme === 'light' ? 'agentsdock-light' : 'agentsdock-dark')
  document.body.dataset.theme = theme
}

function load(message: LoadMessage): void {
  if (!editor) throw new Error('Diff editor is not initialised.')
  // Models outlive editors in Monaco; without this every viewed file leaks two.
  editor.setModel(null)
  models?.original.dispose()
  models?.modified.dispose()
  const language = languageIdForPath(message.path, monaco.languages.getLanguages())
  models = {
    original: monaco.editor.createModel(message.original, language),
    modified: monaco.editor.createModel(message.modified, language),
  }
  applyTheme(message.theme)
  editor.updateOptions({ renderSideBySide: message.sideBySide, diffWordWrap: message.wordWrap ? 'on' : 'off', fontSize: message.fontSize })
  editor.setModel(models)
  const wholeLine = (line: number, options: monaco.editor.IModelDecorationOptions): monaco.editor.IModelDeltaDecoration =>
    ({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, ...options } })
  const sides = [[editor.getOriginalEditor(), message.originalLineNumbers], [editor.getModifiedEditor(), message.modifiedLineNumbers]] as const
  for (const [side, numbers] of sides) {
    // Real file line numbers in the gutter; placeholder rows show a blank.
    side.updateOptions({ lineNumbers: line => String(numbers[line - 1] ?? '') })
    side.createDecorationsCollection(numbers.flatMap((number, index) => number === null
      ? [wholeLine(index + 1, { className: 'review-monaco-gap', inlineClassName: 'review-monaco-gap-text' })]
      : []))
  }
  editor.getModifiedEditor().createDecorationsCollection(message.conflicts.map(conflict => wholeLine(conflict.line, {
    className: `review-monaco-conflict ${conflict.side}`,
    inlineClassName: conflict.marker ? 'review-monaco-conflict-marker' : undefined,
  })))
}

function receive(event: MessageEvent): void {
  let message: LoadMessage | OptionsMessage
  try { message = JSON.parse(event.data) } catch { return }
  try {
    if (message.type === 'load') load(message)
    else if (message.type === 'options' && editor) {
      if (message.theme) applyTheme(message.theme)
      editor.updateOptions({
        ...(message.sideBySide === undefined ? {} : { renderSideBySide: message.sideBySide }),
        ...(message.wordWrap === undefined ? {} : { diffWordWrap: message.wordWrap ? 'on' : 'off' }),
      })
    }
  } catch (error) {
    post({ type: 'error', message: describe(error) })
  }
}

try {
  editor = monaco.editor.createDiffEditor(host, {
    readOnly: true,
    // Keeps the hidden textarea readonly too, so tapping the diff never raises the soft keyboard.
    domReadOnly: true,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 12,
    // Monaco's platform default resolves to Courier on iOS; Menlo ships on every iOS, Roboto Mono / Droid Sans Mono on Android.
    fontFamily: 'Menlo, "Roboto Mono", "Droid Sans Mono", monospace',
    // git already decided these rows differ; letting Monaco ignore whitespace
    // would show whitespace-only hunks as no change at all.
    ignoreTrimWhitespace: false,
  })
  window.addEventListener('message', receive)
  document.addEventListener('message', receive as EventListener)
  post({ type: 'ready' })
} catch (error) {
  post({ type: 'error', message: describe(error) })
}
