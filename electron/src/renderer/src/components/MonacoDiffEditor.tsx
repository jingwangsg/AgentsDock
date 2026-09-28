import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { t } from '@shared/i18n'
import type * as MonacoApi from 'monaco-editor/editor/editor.api'
import { useLocale } from '../lib/i18n'
import { languageIdForPath, type MonacoDiffModel } from '../lib/monaco-diff-model'

type Monaco = typeof MonacoApi

export function MonacoDiffEditor({ path, model, sideBySide, wordWrap, onUnavailable }: {
  path: string
  model: MonacoDiffModel
  sideBySide: boolean
  wordWrap: boolean
  onUnavailable: (message: string) => void
}) {
  useLocale()
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [monaco, setMonaco] = useState<Monaco | null>(null)
  const [editor, setEditor] = useState<MonacoApi.editor.IStandaloneDiffEditor | null>(null)

  useEffect(() => {
    let cancelled = false
    import('../lib/monaco').then(
      loaded => { if (!cancelled) setMonaco(loaded.monaco) },
      reason => { if (!cancelled) onUnavailable(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [onUnavailable])

  useEffect(() => {
    if (!monaco || !host) return
    const created = monaco.editor.createDiffEditor(host, {
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || undefined,
      // git already decided these rows differ; letting Monaco ignore whitespace
      // would show whitespace-only hunks as no change at all.
      ignoreTrimWhitespace: false
    })
    const applyTheme = () => monaco.editor.setTheme(document.documentElement.dataset.theme === 'light' ? 'agentsdock-light' : 'agentsdock-dark')
    const observer = new MutationObserver(applyTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    applyTheme()
    setEditor(created)
    return () => {
      observer.disconnect()
      created.dispose()
      setEditor(null)
    }
  }, [monaco, host])

  useEffect(() => {
    editor?.updateOptions({ renderSideBySide: sideBySide, diffWordWrap: wordWrap ? 'on' : 'off' })
  }, [editor, sideBySide, wordWrap])

  useEffect(() => {
    if (!monaco || !editor) return
    const language = languageIdForPath(path, monaco.languages.getLanguages())
    const original = monaco.editor.createModel(model.original, language)
    const modified = monaco.editor.createModel(model.modified, language)
    editor.setModel({ original, modified })
    const wholeLine = (line: number, options: MonacoApi.editor.IModelDecorationOptions): MonacoApi.editor.IModelDeltaDecoration =>
      ({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, ...options } })
    const sides = [[editor.getOriginalEditor(), model.originalLineNumbers], [editor.getModifiedEditor(), model.modifiedLineNumbers]] as const
    for (const [side, numbers] of sides) {
      side.updateOptions({ lineNumbers: line => String(numbers[line - 1] ?? '') })
      side.createDecorationsCollection(numbers.flatMap((number, index) => number === null
        ? [wholeLine(index + 1, { className: 'review-monaco-gap', inlineClassName: 'review-monaco-gap-text' })]
        : []))
    }
    editor.getModifiedEditor().createDecorationsCollection(model.conflicts.map(conflict => wholeLine(conflict.line, {
      className: `review-monaco-conflict ${conflict.side}`,
      inlineClassName: conflict.marker ? 'review-monaco-conflict-marker' : undefined
    })))
    return () => {
      // Models outlive editors in Monaco; without this they leak per viewed file.
      editor.setModel(null)
      original.dispose()
      modified.dispose()
    }
  }, [monaco, editor, path, model])

  return <div className="review-monaco">
    <div ref={setHost} className="review-monaco-host" />
    {!editor && <div className="review-state"><LoaderCircle className="spin" size={18} /><span>{t('review.editorLoading')}</span></div>}
  </div>
}
