import type { RuntimeCatalog, Session } from '../types'
import { runtimeSummary } from './format'
import { runtimeChipLabel } from './runtime-chip'

function assertEqual(actual: string, expected: string, message: string): void {
  if (actual !== expected) throw new Error(`${message}\n  actual:   ${actual}\n  expected: ${expected}`)
}

const catalog: RuntimeCatalog = {
  backends: {
    claude: {
      default_model: 'claude-opus-5-5',
      default_effort: 'high',
      models: [{ value: 'claude-opus-5-5', label: 'Opus 5.5', description: 'Most capable' }, { value: 'claude-sonnet-5', label: 'Sonnet 5' }],
      efforts: [{ value: 'high', label: 'High' }, { value: 'xhigh', label: 'XHigh' }],
    },
    codex: {
      default_model: 'gpt-5.4',
      models: [{ value: 'gpt-5.4', label: 'GPT-5.4' }, { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini' }],
      efforts: [],
      model_efforts: { 'gpt-5.4': [{ value: 'medium', label: 'Medium' }, { value: 'xhigh', label: 'Extra high', description: 'Slowest' }] },
    },
    cursor: { models: [{ value: 'auto', label: 'Auto' }], efforts: [] },
  },
}

// Model and effort both resolve to their catalog labels.
assertEqual(runtimeChipLabel(catalog, 'claude', 'claude-opus-5-5', 'xhigh'), 'Opus 5.5 · XHigh', 'chosen model and effort use catalog labels')
// Model-scoped efforts (Codex) are looked up the same way.
assertEqual(runtimeChipLabel(catalog, 'codex', 'gpt-5.4', 'xhigh'), 'GPT-5.4 · Extra high', 'model-scoped effort labels apply')
// Unset picks show the catalog defaults, like desktop.
assertEqual(runtimeChipLabel(catalog, 'claude', null, null), 'Opus 5.5 · High', 'unset picks fall back to the default model and effort')
// Model only: backends without an effort (Cursor, or no chosen/default effort).
assertEqual(runtimeChipLabel(catalog, 'cursor', 'auto', 'high'), 'Auto', 'cursor never shows an effort')
assertEqual(runtimeChipLabel(catalog, 'codex', 'gpt-5.4-mini', null), 'GPT-5.4 mini', 'no chosen or default effort shows only the model')
// Values the catalog does not know are shown raw.
assertEqual(runtimeChipLabel(catalog, 'claude', 'claude-next', 'ultra'), 'claude-next · ultra', 'unknown values pass through')
// Missing catalog keeps the previous mobile fallback text.
assertEqual(runtimeChipLabel(null, 'codex', 'gpt-5', 'high'), 'gpt-5 · high', 'without a catalog the raw session values are shown')
assertEqual(runtimeChipLabel(null, 'claude', null, null), 'Server model', 'without a catalog or picks the chip reads Server model')
assertEqual(runtimeChipLabel(undefined, 'claude', '  ', 'low'), 'Server model · low', 'blank model with an effort keeps the fallback model text')
// The chat list and header show the same resolved label after the backend, not "Server model".
assertEqual(runtimeSummary({ backend: 'codex', model: null, effort: null } as Session, catalog), 'Codex · GPT-5.4', 'an unset chat model shows the server default by name')
console.log('runtime-chip tests passed')
