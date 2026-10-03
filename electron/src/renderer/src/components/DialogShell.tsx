// Localized display strings use semantic catalog keys.
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { t, useLocale } from '../lib/i18n'
import { useTransientClose } from '../lib/transient-close'
import { useAppStore } from '../store/app-store'

export function DialogShell({ open, onOpenChange, onEscapeKeyDown, title, description, children, className = '', closeDisabled = false, initialFocusRef }: {
  open: boolean; onOpenChange: (open: boolean) => void; onEscapeKeyDown?: (event: globalThis.KeyboardEvent) => void; title: string; description?: string; children: ReactNode; className?: string; closeDisabled?: boolean; initialFocusRef?: { current: HTMLElement | null }
}) {
  useLocale()
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  useTransientClose(open, () => onOpenChange(false))
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className={`form-dialog ${className}`} aria-busy={Boolean(switchingProfileId)} onEscapeKeyDown={onEscapeKeyDown} onOpenAutoFocus={event => {
    if (!initialFocusRef?.current) return
    event.preventDefault()
    initialFocusRef.current.focus()
  }}><header><div><Dialog.Title>{title}</Dialog.Title>{description && <Dialog.Description>{description}</Dialog.Description>}</div><button type="button" className="icon-button" aria-label={t("ui.Dialogs.Shell.close_31a8910", { "name": String(title) })} disabled={closeDisabled} title={closeDisabled ? t("ui.Dialogs.Shell.wait_for_setup_to_finish_before_closing_848c88c") : undefined} onClick={() => onOpenChange(false)}><X size={16} /></button></header><div className="form-dialog-body" inert={switchingProfileId ? true : undefined}>{children}</div></Dialog.Content></Dialog.Portal></Dialog.Root>
}
