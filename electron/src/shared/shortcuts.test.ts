import { describe, expect, it } from 'vitest'
import { catalogs, localeOptions } from './locales'
import { APP_SHORTCUT_GROUPS, APP_SHORTCUTS, isToggleSidebarChord, shortcutAccelerator, shortcutDisplay, shortcutKeycaps, shortcutTranslationKey } from './shortcuts'

describe('app shortcut catalog', () => {
  it('recognizes the sidebar chord per platform and never Ctrl+B, the tmux prefix', () => {
    const chord = (patch: Partial<Parameters<typeof isToggleSidebarChord>[0]>) => ({ key: 'b', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...patch })
    expect(isToggleSidebarChord(chord({ metaKey: true }), 'mac')).toBe(true)
    expect(isToggleSidebarChord(chord({ key: 'B', metaKey: true }), 'mac')).toBe(true)
    expect(isToggleSidebarChord(chord({ metaKey: true, shiftKey: true }), 'mac')).toBe(false)
    expect(isToggleSidebarChord(chord({ metaKey: true, ctrlKey: true }), 'mac')).toBe(false)
    expect(isToggleSidebarChord(chord({ ctrlKey: true }), 'mac')).toBe(false)
    expect(isToggleSidebarChord(chord({ ctrlKey: true }), 'other')).toBe(false)
    expect(isToggleSidebarChord(chord({ key: '/', ctrlKey: true }), 'other')).toBe(true)
    expect(isToggleSidebarChord(chord({ key: '/', ctrlKey: true, altKey: true }), 'other')).toBe(false)
    expect(isToggleSidebarChord(chord({ key: '/', metaKey: true }), 'other')).toBe(false)
  })

  it('keeps native accelerators and visible Mac labels together', () => {
    expect(shortcutAccelerator('newChat')).toBe('CmdOrCtrl+N')
    expect(shortcutDisplay('newChat', 'mac')).toBe('⌘N')
    expect(shortcutAccelerator('openWorkspaceFile')).toBe('CmdOrCtrl+O')
    expect(shortcutDisplay('openWorkspaceFile', 'mac')).toBe('⌘O')
    expect(APP_SHORTCUTS.findChat.label).toBe('Switch chat')
    expect(shortcutAccelerator('findChat')).toBe('CmdOrCtrl+P')
    expect(shortcutAccelerator('renameChat')).toBe('CmdOrCtrl+R')
    expect(shortcutDisplay('renameChat', 'mac')).toBe('⌘R')
    expect(shortcutAccelerator('attachFiles')).toBe('CmdOrCtrl+Shift+O')
    expect(shortcutDisplay('attachFiles', 'mac')).toBe('⇧⌘O')
    expect(shortcutAccelerator('nextWorkspaceTab')).toBe('Control+Tab')
    expect(shortcutDisplay('previousWorkspaceTab', 'mac')).toBe('⌃⇧⇥')
    expect(shortcutDisplay('focusLeftChatPane', 'mac')).toBe('⌥⌘←')
    expect(shortcutDisplay('focusRightChatPane', 'other')).toBe('Ctrl+Alt+→')
    expect(shortcutAccelerator('nextServer')).toBe('Alt+Shift+]')
    expect(shortcutDisplay('previousServer', 'mac')).toBe('⇧⌥[')
  })

  it('has unique native accelerators', () => {
    const accelerators = Object.values(APP_SHORTCUTS).flatMap(shortcut => 'accelerator' in shortcut ? [shortcut.accelerator] : [])
    expect(new Set(accelerators).size).toBe(accelerators.length)
  })

  it('rejects display-only shortcuts as native accelerators', () => {
    expect(() => shortcutAccelerator('focusLeftChatPane')).toThrow('not registered')
    expect(() => shortcutAccelerator('stopTurn')).toThrow('not registered')
    expect(() => shortcutAccelerator('switchServerByNumber')).toThrow('not registered')
  })

  it('splits display chords into individual website-style keycaps', () => {
    expect(shortcutKeycaps('attachFiles', 'mac')).toEqual(['⇧', '⌘', 'O'])
    expect(shortcutKeycaps('attachFiles', 'other')).toEqual(['Ctrl', 'Shift', 'O'])
    expect(shortcutKeycaps('sendMessage', 'mac')).toEqual(['↩'])
    expect(shortcutKeycaps('settings', 'other')).toEqual(['Ctrl', ','])
    expect(shortcutKeycaps('stopTurn', 'mac')).toEqual(['⎋'])
    expect(shortcutKeycaps('switchServerByNumber', 'mac')).toEqual(['⇧', '⌥', '1…9'])
    expect(shortcutKeycaps('switchServerByNumber', 'other')).toEqual(['Alt', 'Shift', '1…9'])
  })

  it('groups every registered shortcut exactly once for settings', () => {
    const grouped = APP_SHORTCUT_GROUPS.flatMap(group => group.shortcuts)
    expect([...grouped].sort()).toEqual(Object.keys(APP_SHORTCUTS).sort())
    expect(new Set(grouped).size).toBe(grouped.length)
    expect(shortcutTranslationKey('toggleSidebar')).toBe('shortcuts.action.toggleSidebar')
  })

  it('localizes every settings group and shortcut in every catalog', () => {
    for (const { value: locale } of localeOptions) {
      for (const group of APP_SHORTCUT_GROUPS) {
        expect(catalogs[locale][`shortcuts.group.${group.id}`]).toBeTruthy()
        for (const shortcut of group.shortcuts) {
          expect(catalogs[locale][shortcutTranslationKey(shortcut)]).toBeTruthy()
        }
      }
    }

    for (const shortcut of Object.keys(APP_SHORTCUTS) as Array<keyof typeof APP_SHORTCUTS>) {
      expect(catalogs.en[shortcutTranslationKey(shortcut)]).toBe(APP_SHORTCUTS[shortcut].label)
    }
  })
})
