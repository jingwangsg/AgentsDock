import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  CODE_EDITOR_DEFAULT_FONT_SIZE,
  CODE_EDITOR_FONT_SIZE_MAX,
  CODE_EDITOR_FONT_SIZE_MIN,
  CODE_EDITOR_THEMES,
  clampCodeEditorFontSize,
  isCodeEditorThemeId,
  type CodeEditorThemeId,
} from './codeEditorTheme'

export const EDITOR_FONT_SIZE_MIN = CODE_EDITOR_FONT_SIZE_MIN
export const EDITOR_FONT_SIZE_MAX = CODE_EDITOR_FONT_SIZE_MAX
export const EDITOR_APPEARANCE_STORAGE_KEY = 'agentsdock.editorAppearance'

export type EditorThemeId = CodeEditorThemeId
// 'app' follows the app appearance, like the desktop editor's "Match app".
export type EditorThemePreference = 'app' | EditorThemeId

export interface EditorAppearance {
  theme: EditorThemePreference
  fontSize: number
}

export const EDITOR_THEME_OPTIONS: ReadonlyArray<{ id: EditorThemePreference; label: string }> = [
  { id: 'app', label: 'Match app' },
  ...CODE_EDITOR_THEMES.map(({ id, label }) => ({ id, label })),
]

export const DEFAULT_EDITOR_APPEARANCE: Readonly<EditorAppearance> = {
  theme: 'app',
  fontSize: CODE_EDITOR_DEFAULT_FONT_SIZE,
}

export function isEditorThemeId(value: unknown): value is EditorThemeId {
  return isCodeEditorThemeId(value)
}

export function resolveEditorTheme(theme: EditorThemePreference, appScheme: 'light' | 'dark'): EditorThemeId {
  if (theme !== 'app') return theme
  return appScheme === 'light' ? 'zed-one-light' : 'zed-one-dark'
}

export function clampEditorFontSize(value: unknown): number {
  return clampCodeEditorFontSize(value)
}

export function normalizeEditorAppearance(value: unknown): EditorAppearance {
  if (!value || typeof value !== 'object') return { ...DEFAULT_EDITOR_APPEARANCE }
  const candidate = value as Partial<EditorAppearance>
  return {
    theme: candidate.theme === 'app' || isEditorThemeId(candidate.theme) ? candidate.theme : DEFAULT_EDITOR_APPEARANCE.theme,
    fontSize: clampEditorFontSize(candidate.fontSize),
  }
}

export function nextEditorTheme(theme: EditorThemePreference): EditorThemePreference {
  const index = EDITOR_THEME_OPTIONS.findIndex(option => option.id === theme)
  return EDITOR_THEME_OPTIONS[(index + 1 + EDITOR_THEME_OPTIONS.length) % EDITOR_THEME_OPTIONS.length].id
}

export async function readEditorAppearance(): Promise<EditorAppearance> {
  try {
    const stored = await AsyncStorage.getItem(EDITOR_APPEARANCE_STORAGE_KEY)
    return stored ? normalizeEditorAppearance(JSON.parse(stored)) : { ...DEFAULT_EDITOR_APPEARANCE }
  } catch {
    return { ...DEFAULT_EDITOR_APPEARANCE }
  }
}

export async function writeEditorAppearance(value: unknown): Promise<EditorAppearance> {
  const appearance = normalizeEditorAppearance(value)
  try {
    await AsyncStorage.setItem(EDITOR_APPEARANCE_STORAGE_KEY, JSON.stringify(appearance))
  } catch {
    // The in-memory choice remains usable when persistence is unavailable.
  }
  return appearance
}
