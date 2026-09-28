import AsyncStorage from '@react-native-async-storage/async-storage'

// One device-wide flag rather than Electron's per-profile key: the mobile
// shell shows a single workspace, so the last choice is always the one in view.
export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'agentsdock.sidebarCollapsed'

export async function readSidebarCollapsed(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)) === 'true'
  } catch {
    return false
  }
}

export async function writeSidebarCollapsed(collapsed: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed))
  } catch {
    // The in-memory choice remains usable when persistence is unavailable.
  }
}
