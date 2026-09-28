import assert from 'node:assert/strict'
import {
  DEFAULT_EDITOR_APPEARANCE,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  clampEditorFontSize,
  nextEditorTheme,
  normalizeEditorAppearance,
  resolveEditorTheme,
} from './editorAppearance'

assert.deepEqual(normalizeEditorAppearance(null), DEFAULT_EDITOR_APPEARANCE)
assert.deepEqual(normalizeEditorAppearance({ theme: 'github-light', fontSize: 16.4 }), {
  theme: 'github-light',
  fontSize: 16,
})
assert.deepEqual(normalizeEditorAppearance({ theme: 'unknown', fontSize: Number.NaN }), DEFAULT_EDITOR_APPEARANCE)
assert.equal(clampEditorFontSize(-100), EDITOR_FONT_SIZE_MIN)
assert.equal(clampEditorFontSize(100), EDITOR_FONT_SIZE_MAX)
assert.equal(nextEditorTheme('vscode-dark'), 'github-dark')
assert.equal(nextEditorTheme('github-light'), 'app')
assert.equal(nextEditorTheme('app'), 'zed-one-dark')

// The default follows the app appearance with Zed's One themes, like the
// desktop editor's "Match app"; an explicit choice ignores the app.
assert.equal(DEFAULT_EDITOR_APPEARANCE.theme, 'app')
assert.deepEqual(normalizeEditorAppearance({ theme: 'app', fontSize: 13 }), { theme: 'app', fontSize: 13 })
assert.equal(resolveEditorTheme('app', 'dark'), 'zed-one-dark')
assert.equal(resolveEditorTheme('app', 'light'), 'zed-one-light')
assert.equal(resolveEditorTheme('dracula', 'light'), 'dracula')

console.log('editor appearance tests passed')
