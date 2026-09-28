import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

function source(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8')
}

const composer = source('src/components/Composer.tsx')
const sheet = source('src/components/ComposerRuntimeSheet.tsx')
const chip = source('src/lib/runtime-chip.ts')

test('the toolbar shows one Model · Reasoning chip right of the provider control', () => {
  assert.match(composer, /\{runtimeControl\}\s+\{runtimeChip\}\s+\{!welcome \? quickMessageControl : null\}/)
  assert.match(composer, /testID="chat-runtime-chip"[\s\S]*?accessibilityLabel="Model and reasoning"[\s\S]*?onPress=\{\(\) => openRuntimeSheet\('model'\)\}/)
  // Same typography as the provider name, plus the desktop chevron.
  assert.match(composer, /<Text style=\{\[styles\.backend, \{ color: colors\.text \}\]\} numberOfLines=\{1\}>\{runtimeChipLabel\(runtime, backend, model, effort\)\}<\/Text>\s+<ChevronDown size=\{13\} color=\{colors\.muted\} \/>/)
  assert.match(chip, /return `\$\{modelLabel\} · \$\{effortLabel\}`/)
  assert.match(chip, /if \(!selectedEffort\) return modelLabel/)
  assert.match(chip, /'Server model'/)
  // The provider control keeps backend switching and reload; model/effort left its native menu.
  assert.match(composer, /id: 'switch-backend'/)
  assert.match(composer, /id: 'reload-provider'/)
  assert.doesNotMatch(composer, /set-model|set-effort|choiceActions|ComposerOptionPicker|runtimeLabel/)
})

test('the chip opens a page sheet with Model and Reasoning sections like the desktop menu', () => {
  assert.match(sheet, /<Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose=\{onClose\}>/)
  assert.match(sheet, /<SheetCloseButton testID="composer-runtime-sheet-close" label="Close model and reasoning" onPress=\{onClose\} \/>/)
  assert.match(sheet, />Model<\/Text>/)
  assert.match(sheet, />Reasoning<\/Text>/)
  assert.match(sheet, /const hasEfforts = efforts\.some\(option => Boolean\(option\.value\)\)/)
  // Rows: label, muted description (or lock reason), check on the current value, locked rows disabled.
  assert.match(sheet, /const detail = locked \? option\.locked_reason\?\.trim\(\) : option\.description\?\.trim\(\)/)
  assert.match(sheet, /accessibilityState=\{\{ selected, disabled: locked \}\}/)
  assert.match(sheet, /\{selected \? <Check size=\{18\} color=\{colors\.blue\} \/> : null\}/)
  assert.match(sheet, /testID=\{`composer-runtime-model-\$\{option\.value \|\| 'default'\}`\}/)
  assert.match(sheet, /testID=\{`composer-runtime-effort-\$\{option\.value \|\| 'default'\}`\}/)
  // `/reasoning` scrolls its section into view.
  assert.match(sheet, /section === 'reasoning' \? event => scroll\.current\?\.scrollTo/)
})

test('selections persist through updateSession with the desktop effort reconciliation and close the sheet', () => {
  assert.match(composer, /onPickModel=\{value => \{\s+setRuntimeSheetSection\(null\)[\s\S]*?void updateSession\(sessionId, \{ model: value \|\| null, effort: runtimeEffortAfterModelChange\(runtime, backend, value \|\| null, effort\) \}, profileGeneration\)/)
  assert.match(composer, /onPickEffort=\{value => \{\s+setRuntimeSheetSection\(null\)[\s\S]*?void updateSession\(sessionId, \{ effort: value \|\| null \}, profileGeneration\)/)
  assert.match(composer, /efforts=\{backend === 'cursor' \? \[\] : runtimeEffortOptions\(runtime, backend, model, effort\)\}/)
  assert.match(composer, /case 'model': case 'reasoning': openRuntimeSheet\(command\.id\); break/)
  assert.match(composer, /const openRuntimeSheet = \(section: 'model' \| 'reasoning'\) => \{ setRuntimeSheetSection\(section\); requestAnimationFrame\(dismissAppKeyboard\) \}/)
})
