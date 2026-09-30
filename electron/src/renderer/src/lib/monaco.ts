// Reached only through import() from the Changes pane, so Monaco, its CSS and
// the per-language tokenizer chunks behind basic-languages stay out of the
// main bundle. Only tokenizers are loaded: no TypeScript/JSON/CSS/HTML services.
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/basic-languages/monaco.contribution'
// load-bearing: editor.api does not bring codicon.css; without it the diff
// gutter's +/- markers (and every other codicon) render as tofu boxes.
import 'monaco-editor/features/codicon/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { COLOR_THEMES } from './color-themes.data'

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

// Each app color theme adds its own syntax colors over the same transparent backgrounds.
for (const { id, mode, editor } of COLOR_THEMES) {
  const rule = (token: string, color: string) => ({ token, foreground: color.slice(1, 7) })
  monaco.editor.defineTheme(`agentsdock-${id}`, {
    base: mode === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [rule('', editor.foreground), rule('keyword', editor.keyword), rule('string', editor.string), rule('number', editor.number),
      rule('comment', editor.comment), rule('type', editor.type), rule('variable', editor.variable), rule('delimiter', editor.punctuation),
      rule('operator', editor.operator), rule('tag', editor.keyword), rule('attribute.name', editor.property), rule('invalid', editor.invalid)],
    colors: { 'editor.background': '#00000000', 'editorGutter.background': '#00000000', 'editor.foreground': editor.foreground }
  })
}

export { monaco }
