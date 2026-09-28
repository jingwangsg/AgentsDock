import AsyncStorage from '@react-native-async-storage/async-storage'
import { SIDEBAR_COLLAPSED_STORAGE_KEY, readSidebarCollapsed, writeSidebarCollapsed } from './sidebar-preference'

function assertEqual(actual: boolean, expected: boolean, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, received ${actual}`)
}

assertEqual(await readSidebarCollapsed(), false, 'fresh install starts expanded')
await writeSidebarCollapsed(true)
assertEqual(await readSidebarCollapsed(), true, 'collapsed choice survives a re-read')
await writeSidebarCollapsed(false)
assertEqual(await readSidebarCollapsed(), false, 'expanded choice survives a re-read')
await AsyncStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, 'garbage')
assertEqual(await readSidebarCollapsed(), false, 'unrecognized stored value falls back to expanded')

console.log('sidebar preference persistence passed')
