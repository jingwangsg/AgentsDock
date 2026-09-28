import AsyncStorage from '@react-native-async-storage/async-storage'

// Device-wide like the sidebar flag: the review sheet looks the same on every profile.
export const REVIEW_SIDE_BY_SIDE_STORAGE_KEY = 'agentsdock.reviewSideBySide'
export const REVIEW_WORD_WRAP_STORAGE_KEY = 'agentsdock.reviewWordWrap'

export interface ReviewLayoutPreference {
  // null until the user picks a layout, so the pane can default by its width.
  sideBySide: boolean | null
  wordWrap: boolean
}

export async function readReviewLayout(): Promise<ReviewLayoutPreference> {
  try {
    const stored = new Map(await AsyncStorage.multiGet([REVIEW_SIDE_BY_SIDE_STORAGE_KEY, REVIEW_WORD_WRAP_STORAGE_KEY]))
    const sideBySide = stored.get(REVIEW_SIDE_BY_SIDE_STORAGE_KEY)
    return {
      sideBySide: sideBySide === 'true' ? true : sideBySide === 'false' ? false : null,
      wordWrap: stored.get(REVIEW_WORD_WRAP_STORAGE_KEY) === 'true',
    }
  } catch {
    return { sideBySide: null, wordWrap: false }
  }
}

export async function writeReviewLayout(patch: { sideBySide?: boolean; wordWrap?: boolean }): Promise<void> {
  const entries: Array<[string, string]> = []
  if (patch.sideBySide !== undefined) entries.push([REVIEW_SIDE_BY_SIDE_STORAGE_KEY, String(patch.sideBySide)])
  if (patch.wordWrap !== undefined) entries.push([REVIEW_WORD_WRAP_STORAGE_KEY, String(patch.wordWrap)])
  try {
    await AsyncStorage.multiSet(entries)
  } catch {
    // The in-memory choice remains usable when persistence is unavailable.
  }
}
