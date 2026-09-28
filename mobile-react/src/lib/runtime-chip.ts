import { runtimeEffortOptions } from './runtime-catalog'
import type { RuntimeCatalog } from '../types'

/**
 * Toolbar chip text, mirroring the desktop runtime chip: the model label, then
 * ` · ` and the effort label when the backend has one. Unset picks fall back to
 * the catalog defaults; without a catalog the raw session values are shown.
 */
export function runtimeChipLabel(catalog: RuntimeCatalog | null | undefined, backend: string, model: string | null | undefined, effort: string | null | undefined): string {
  const backendCatalog = catalog?.backends?.[backend]
  const selectedModel = model?.trim() || backendCatalog?.default_model?.trim() || ''
  const modelLabel = (selectedModel && backendCatalog?.models.find(option => option.value === selectedModel)?.label?.trim()) || selectedModel || 'Server model'
  if (backend === 'cursor') return modelLabel
  const selectedEffort = effort?.trim() || backendCatalog?.default_effort?.trim() || ''
  if (!selectedEffort) return modelLabel
  const effortLabel = runtimeEffortOptions(catalog, backend, model, effort).find(option => option.value === selectedEffort)?.label?.trim() || selectedEffort
  return `${modelLabel} · ${effortLabel}`
}
