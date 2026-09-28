import * as Popover from '@radix-ui/react-popover'
import { Gauge, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { t } from '@shared/i18n'
import { providerUsageRemaining } from '@shared/provider-usage'
import type { Session } from '@shared/types'
import { useLocale } from '../lib/i18n'
import { ProviderUsageBody, formatUsagePercent, useProviderUsage } from './ProviderUsagePanel'
import './ProviderUsageIndicator.css'

export function ProviderUsageIndicator({ session }: { session: Session }) {
  useLocale()
  const view = useProviderUsage(session)
  const { backend, usage, connected, scopeKey } = view
  const [open, setOpen] = useState(false)
  const titleId = useId()

  useEffect(() => {
    setOpen(false)
  }, [scopeKey])

  if (!view.supported || !backend || !usage || usage.status !== 'available'
    || (!usage.windows.length && !usage.credits)) return null
  const remaining = providerUsageRemaining(usage)
  const label = usage.windows.some(window => window.status === 'rejected') ? t('providerUsage.limitReached')
    : remaining === null ? t('providerUsage.title') : t('providerUsage.remaining', { percent: formatUsagePercent(remaining) })
  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next && connected) view.refresh() }}>
    <Popover.Trigger asChild>
      <button type="button" className="provider-usage-indicator" aria-label={`${t('providerUsage.title')}: ${label}`}
        title={`${t('providerUsage.title')}: ${label}`}>
        <Gauge size={14} /><span>{label}</span>
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="provider-usage-popover" side="top" align="start" sideOffset={8} collisionPadding={12} aria-labelledby={titleId}>
        <header>
          <h3 id={titleId}>{t('providerUsage.accountTitle', { provider: backend === 'codex' ? 'Codex' : 'Claude' })}</h3>
          <Popover.Close asChild><button type="button" className="icon-button" aria-label={t('providerUsage.close')}><X size={15} /></button></Popover.Close>
        </header>
        <ProviderUsageBody view={view} backend={backend} />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}
