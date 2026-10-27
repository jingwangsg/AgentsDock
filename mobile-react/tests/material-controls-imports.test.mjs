import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

// iOS shows Android's controls only because call sites import them from src/components/material/
// (Alert from src/lib/alert). Importing the platform control directly compiles and runs, but shows
// the UIKit/SwiftUI control on iOS.
const PLATFORM_CONTROLS = {
  'react-native': ['Alert', 'ActionSheetIOS', 'ActivityIndicator', 'Switch', 'RefreshControl'],
  '@expo/ui': ['MenuView', 'DateTimePicker'],
}
const SHIM_FILE = /^src\/components\/material\/|^src\/lib\/alert(?:\.ios)?\.ts$/
// Android-only files never reach iOS (today: AnalyticsSettings.android.tsx, which keeps RN's Switch).
const ANDROID_ONLY_FILE = /\.android\.tsx?$/

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(file)
    return /\.tsx?$/.test(entry.name) ? [file] : []
  })
}

function packageOf(specifier) {
  if (specifier === 'react-native') return 'react-native'
  if (specifier === '@expo/ui' || specifier.startsWith('@expo/ui/')) return '@expo/ui'
  return null
}

/** Value names a file takes from react-native or @expo/ui, through import, export-from or require. */
function platformControlUses(source) {
  const uses = []
  const statement = /\b(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
  for (const [, , typeOnly, clause, specifier] of source.matchAll(statement)) {
    const pkg = packageOf(specifier)
    if (!pkg || typeOnly) continue
    const named = clause.match(/\{([^}]*)\}/)?.[1] ?? ''
    for (const part of named.split(',').map(value => value.trim()).filter(Boolean)) {
      if (!part.startsWith('type ')) uses.push([pkg, part.split(/\s+as\s+/)[0]])
    }
    const namespace = clause.match(/\*\s+as\s+(\w+)/)?.[1]
    if (namespace) {
      for (const [, name] of source.matchAll(new RegExp(`\\b${namespace}\\.(\\w+)`, 'g'))) uses.push([pkg, name])
    }
    // The community menu and date-picker modules export nothing but those controls.
    if (/^@expo\/ui\/community\/(?:menu|datetime-picker)$/.test(specifier) && named === '' && !namespace) uses.push([pkg, specifier])
  }
  for (const [, destructured, specifier, member] of source.matchAll(/(?:\{([^}]*)\}\s*=\s*)?require\(\s*['"]([^'"]+)['"]\s*\)(?:\.(\w+))?/g)) {
    const pkg = packageOf(specifier)
    if (!pkg) continue
    if (member) uses.push([pkg, member])
    for (const part of (destructured ?? '').split(',').map(value => value.trim()).filter(Boolean)) uses.push([pkg, part.split(':')[0].trim()])
  }
  return uses.filter(([pkg, name]) => PLATFORM_CONTROLS[pkg].includes(name) || name.startsWith('@expo/ui/'))
}

test('platform controls come from material/ or lib/alert, so iOS draws the Android ones', () => {
  const files = sourceFiles(path.resolve('src')).map(file => path.relative(process.cwd(), file))
  assert.ok(files.includes('src/components/Sidebar.tsx'), 'run from mobile-react/')
  const offenders = files
    .filter(file => !SHIM_FILE.test(file) && !ANDROID_ONLY_FILE.test(file))
    .flatMap(file => platformControlUses(fs.readFileSync(file, 'utf8')).map(([pkg, name]) => `${file}: ${name} from ${pkg}`))
  assert.deepEqual(offenders, [], 'import these from src/components/material/ (Alert from src/lib/alert)')
})

test('the import scan finds every form of a direct platform-control import', () => {
  const found = source => platformControlUses(source).map(([, name]) => name)
  assert.deepEqual(found("import { Alert, Platform } from 'react-native'"), ['Alert'])
  assert.deepEqual(found("import {\n  Modal,\n  Switch as Toggle,\n  View,\n} from 'react-native'"), ['Switch'])
  assert.deepEqual(found("import RN, { RefreshControl } from 'react-native'"), ['RefreshControl'])
  assert.deepEqual(found("export { ActivityIndicator } from 'react-native'"), ['ActivityIndicator'])
  assert.deepEqual(found("import * as RN from 'react-native'\nRN.ActionSheetIOS.showActionSheetWithOptions()"), ['ActionSheetIOS'])
  assert.deepEqual(found("const { Alert } = require('react-native')"), ['Alert'])
  assert.deepEqual(found("import { MenuView } from '@expo/ui/community/menu'"), ['MenuView'])
  assert.deepEqual(found("import { DateTimePicker } from '@expo/ui/community/datetime-picker'"), ['DateTimePicker'])
  assert.deepEqual(found("import Picker from '@expo/ui/community/datetime-picker'"), ['@expo/ui/community/datetime-picker'])
  assert.deepEqual(found("import { DateTimePicker } from '@expo/ui/swift-ui'"), ['DateTimePicker'])
  // Types carry no control, and the shims themselves are allowed.
  assert.deepEqual(found("import type { AlertButton } from 'react-native'\nimport { type SwitchProps, View } from 'react-native'"), [])
  assert.deepEqual(found("import type { MenuAction } from '@expo/ui/community/menu'"), [])
  assert.deepEqual(found("import { Alert } from '../lib/alert'\nimport { Switch } from './material/Switch'"), [])
})
