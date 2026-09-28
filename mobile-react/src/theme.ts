import { createContext, useContext } from 'react'
import { useColorScheme } from 'react-native'

// Zed One Dark / One Light, the same tokens as electron/src/renderer/src/zed-skin.css.
// Layering follows the desktop skin: screens are Zed's panel.background
// (`background` here, --surface there); cards, the composer and code blocks
// are its editor.background (`surface` here, --bg there).
export const dark = {
  background: '#2f343e',
  surface: '#282c33',
  raised: '#363c46',
  selected: '#454a56',
  border: '#464b57',
  borderSoft: '#363c46',
  borderFocused: '#47679e',
  text: '#dce0e5',
  muted: '#a9afbc',
  faint: '#7c8290',
  blue: '#74ade8',
  textOnAccent: '#1b1f26',
  green: '#a1c181',
  greenSurface: '#303b32',
  red: '#d07277',
  dangerSurface: '#43333a',
  orange: '#dec184',
  yellow: '#dec184',
  amberSurface: '#3f3a2f',
  user: '#282c33',
  queued: '#3f3a2f',
} as const

export const light = {
  background: '#ebebec',
  surface: '#fafafa',
  raised: '#dfdfe0',
  selected: '#cacaca',
  border: '#c9c9ca',
  borderSoft: '#dfdfe0',
  borderFocused: '#7d82e8',
  text: '#242529',
  muted: '#58585a',
  faint: '#8b8b8d',
  blue: '#5c78e2',
  textOnAccent: '#ffffff',
  green: '#669f59',
  greenSurface: '#e4efe0',
  red: '#d36151',
  dangerSurface: '#f8e4e0',
  orange: '#a48819',
  yellow: '#a48819',
  amberSurface: '#f5efd9',
  user: '#fafafa',
  queued: '#f5efd9',
} as const

export type Palette = { [K in keyof typeof dark]: string }
// App.tsx provides the scheme resolved from the Settings appearance. Reading it
// from context rather than useColorScheme() alone matters: the native
// appearanceChanged event behind useColorScheme() lands up to a second after
// Appearance.setColorScheme(), so launch and every switch would render the old
// scheme until then. Without a provider, follow the platform.
const ColorSchemeContext = createContext<'light' | 'dark' | null>(null)
export const ColorSchemeProvider = ColorSchemeContext.Provider
export function useAppColorScheme(): 'light' | 'dark' {
  const resolved = useContext(ColorSchemeContext)
  const platform = useColorScheme()
  return resolved ?? (platform === 'light' ? 'light' : 'dark')
}
export function usePalette(): Palette { return useAppColorScheme() === 'light' ? light : dark }

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const
export const radius = { compact: 4, control: 4, popover: 6, dialog: 8 } as const
