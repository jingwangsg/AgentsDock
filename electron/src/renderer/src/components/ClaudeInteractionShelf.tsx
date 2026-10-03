// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { AlertTriangle, LoaderCircle, RefreshCw } from 'lucide-react'
import { ProviderInteractionShelf } from './CodexInteractionShelf'
import { claudeBridge, useClaudeRuntime } from './ClaudeRuntimeContext'
import './CodexControls.css'

export function ClaudeInteractionShelf() {
  useLocale()
  const {
    supported,
    loading,
    refreshing,
    mutating,
    runtimeError,
    interactionError,
    runtime,
    session,
    refresh,
    run
  } = useClaudeRuntime()
  const interactions = runtime?.pending_interactions ?? []
  const summaryNeedsAction = Boolean(
    session?.claude_needs_user_action
    || (session?.claude_pending_interaction_count ?? 0) > 0
  )
  const showRecovery = Boolean(
    supported
    && session
    && summaryNeedsAction
    && interactions.length === 0
    && (loading || runtimeError)
  )

  if (showRecovery) {
    return (
      <section className="codex-interaction-shelf" aria-label={t('merge.claudeRecovery.heading')}>
        <header>
          <div>
            <span className="codex-attention-dot" aria-hidden="true" />
            <strong>{t('merge.claudeRecovery.heading')}</strong>
          </div>
        </header>
        <div className="codex-interaction-list">
          <div className="claude-interaction-recovery">
            {loading
              ? <LoaderCircle className="spin" size={16} aria-hidden="true" />
              : <AlertTriangle size={16} aria-hidden="true" />}
            <span>
              <strong>{loading
                ? t('merge.claudeRecovery.loading')
                : t('merge.claudeRecovery.failed')}</strong>
              <small>{loading
                ? t('merge.claudeRecovery.waiting')
                : runtimeError}</small>
            </span>
            <button
              type="button"
              className="quiet-button"
              aria-label={t('merge.claudeRecovery.reloadLabel')}
              disabled={loading || refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw className={refreshing ? 'spin' : ''} size={14} aria-hidden="true" />
              {t('merge.claudeRecovery.reload')}
            </button>
          </div>
        </div>
      </section>
    )
  }

  if (!supported || loading || !session || interactions.length === 0) return null

  return <ProviderInteractionShelf
    providerName="Claude"
    sessionId={session.id}
    interactions={interactions}
    error={interactionError}
    busy={mutating}
    onRespond={(interaction, response) => run(async () => {
      const bridge = claudeBridge()
      if (!bridge) throw new Error('This AgentsDock build does not expose Claude controls.')
      await bridge.resolveInteraction(session.id, interaction.id, response)
    })}
  />
}
