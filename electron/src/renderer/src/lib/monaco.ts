// Reached only through import() from the Changes pane, so Monaco, its CSS and
// the per-language tokenizer chunks behind basic-languages stay out of the
// main bundle. Only tokenizers are loaded: no TypeScript/JSON/CSS/HTML services.
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/basic-languages/monaco.contribution'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

// Transparent backgrounds let the pane surface show through; everything else
// stays the built-in vs / vs-dark palette.
for (const [name, base] of [['agentsdock-light', 'vs'], ['agentsdock-dark', 'vs-dark']] as const) {
  monaco.editor.defineTheme(name, {
    base,
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#00000000', 'editorGutter.background': '#00000000' }
  })
}

export { monaco }
