import { t } from '@shared/i18n'
import * as Switch from '@radix-ui/react-switch'
import { useState, type ReactNode } from 'react'
import { useLocale } from '../lib/i18n'
import {
  DEFAULT_TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN, TERMINAL_SCROLLBACK_OPTIONS,
  updateTerminalSettings, useTerminalSettings, type TerminalCursorStyle, type TerminalSettings as Settings
} from '../lib/terminal-settings'
import { currentShortcutPlatform } from './ShortcutTooltip'

const FONT_SIZES = Array.from({ length: TERMINAL_FONT_SIZE_MAX - TERMINAL_FONT_SIZE_MIN + 1 }, (_, index) => TERMINAL_FONT_SIZE_MIN + index)

/** Settings → Terminal. Every change applies to open terminal tabs at once. */
export function TerminalSettings() {
  useLocale()
  const settings = useTerminalSettings()
  const mac = currentShortcutPlatform() === 'mac'
  // Typed text applies on Enter or blur; until then the field shows the stored value.
  const [fontFamily, setFontFamily] = useState<string | null>(null)
  const commitFontFamily = () => {
    if (fontFamily !== null && fontFamily.trim() !== settings.fontFamily) updateTerminalSettings({ fontFamily })
    setFontFamily(null)
  }

  return <section className="app-settings-section" aria-labelledby="app-settings-terminal-title">
    <header><h2 id="app-settings-terminal-title">{t('settings.terminal')}</h2></header>
    <p className="app-settings-section-help">{t('settings.terminalHelp', mac
      ? { zoomIn: '⌘+', zoomOut: '⌘−', zoomReset: '⌘0' }
      : { zoomIn: 'Ctrl+=', zoomOut: 'Ctrl+−', zoomReset: 'Ctrl+0' })}</p>
    <div className="app-settings-list">
      <label className="app-settings-row">
        <div className="app-settings-row-copy"><strong>{t('settings.terminalFontFamily')}</strong><span id="terminal-font-family-help">{t('settings.terminalFontFamilyHelp')}</span></div>
        <input
          className="app-settings-select terminal-settings-font"
          aria-label={t('settings.terminalFontFamily')}
          aria-describedby="terminal-font-family-help"
          placeholder={DEFAULT_TERMINAL_FONT_FAMILY}
          spellCheck={false}
          value={fontFamily ?? settings.fontFamily}
          onChange={event => setFontFamily(event.target.value)}
          onBlur={commitFontFamily}
          onKeyDown={event => { if (event.key === 'Enter') commitFontFamily() }}
        />
      </label>
      <label className="app-settings-row">
        <strong className="app-settings-row-title">{t('settings.terminalFontSize')}</strong>
        <select className="app-settings-select" aria-label={t('settings.terminalFontSize')} value={settings.fontSize} onChange={event => updateTerminalSettings({ fontSize: Number(event.target.value) })}>
          {FONT_SIZES.map(size => <option key={size} value={size}>{size} px</option>)}
        </select>
      </label>
      <label className="app-settings-row">
        <strong className="app-settings-row-title">{t('settings.terminalCursorStyle')}</strong>
        <select className="app-settings-select" aria-label={t('settings.terminalCursorStyle')} value={settings.cursorStyle} onChange={event => updateTerminalSettings({ cursorStyle: event.target.value as TerminalCursorStyle })}>
          <option value="bar">{t('settings.terminalCursorBar')}</option>
          <option value="block">{t('settings.terminalCursorBlock')}</option>
          <option value="underline">{t('settings.terminalCursorUnderline')}</option>
        </select>
      </label>
      <SwitchRow settingKey="cursorBlink" settings={settings} label={t('settings.terminalCursorBlink')} />
      {mac && <SwitchRow settingKey="optionAsMeta" settings={settings} label={t('settings.terminalOptionAsMeta')} help={t('settings.terminalOptionAsMetaHelp')} />}
      <SwitchRow settingKey="copyOnSelect" settings={settings} label={t('settings.terminalCopyOnSelect')} help={t('settings.terminalCopyOnSelectHelp')} />
      <label className="app-settings-row">
        <strong className="app-settings-row-title">{t('settings.terminalScrollback')}</strong>
        <select className="app-settings-select" aria-label={t('settings.terminalScrollback')} value={settings.scrollback} onChange={event => updateTerminalSettings({ scrollback: Number(event.target.value) })}>
          {TERMINAL_SCROLLBACK_OPTIONS.map(lines => <option key={lines} value={lines}>{t('settings.terminalScrollbackLines', { count: lines.toLocaleString() })}</option>)}
        </select>
      </label>
      <SwitchRow settingKey="screenReader" settings={settings} label={t('settings.terminalScreenReader')} help={t('settings.terminalScreenReaderHelp')} />
    </div>
  </section>
}

function SwitchRow({ settingKey, settings, label, help }: {
  settingKey: 'cursorBlink' | 'optionAsMeta' | 'copyOnSelect' | 'screenReader'
  settings: Settings
  label: string
  help?: ReactNode
}) {
  const helpId = `terminal-${settingKey}-help`
  return <label className="app-settings-row">
    <div className="app-settings-row-copy"><strong>{label}</strong>{help && <span id={helpId}>{help}</span>}</div>
    <Switch.Root className="settings-switch" aria-label={label} aria-describedby={help ? helpId : undefined} checked={settings[settingKey]} onCheckedChange={checked => updateTerminalSettings({ [settingKey]: checked })}><Switch.Thumb className="settings-switch-thumb" /></Switch.Root>
  </label>
}
