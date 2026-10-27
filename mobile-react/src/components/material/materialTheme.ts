// iOS only: imported from the iOS files in this folder. No .ios suffix because tsc (no moduleSuffixes) could not resolve the import then.
// Android must not import it: its require()s would put the Roboto and Noto fonts in the Android bundle.
import { useEffect, useState } from 'react'
import * as Font from 'expo-font'
import { useAppColorScheme } from '../../theme'

// iOS draws the controls Android draws with Material widgets. Every value below was read
// from Android build 78 on the emulator (dp there = pt here). Menus and date/time dialogs
// are Compose Material 3 (dynamic colors of the stock wallpaper), alerts and switches are
// AppCompat; both follow the app's light/dark setting.
const palettes = {
  light: {
    // AppCompat's colorAccent: spinners and alert buttons.
    accent: '#008577',
    menu: { container: '#efedf4', text: '#1b1b21', disabledText: 'rgba(27,27,33,0.38)', destructive: '#b3261e', divider: '#c7c5d0', pressed: 'rgba(27,27,33,0.1)' },
    alert: { card: '#ffffff', text: '#212121', button: '#008577', pressed: 'rgba(0,0,0,0.12)', scrim: 'rgba(0,0,0,0.6)' },
    switch: { thumbOn: '#008275', thumbOff: '#ececec', thumbDisabled: '#bdbdbd', trackOn: 'rgba(0,133,119,0.3)', trackOff: 'rgba(0,0,0,0.3)', trackDisabled: 'rgba(0,0,0,0.1)' },
    picker: { container: '#e9e7ef', text: '#1b1b21', muted: '#46464f', divider: '#c7c5d0', button: '#525a92', onAccent: '#ffffff', onAccentContainer: '#0b154b', fieldContainer: '#e4e1e9', outline: '#767680', periodSelected: '#ffd7f1', onPeriodSelected: '#2d1228', pressed: 'rgba(27,27,33,0.1)' },
  },
  dark: {
    accent: '#80cbc4',
    menu: { container: '#1f1f25', text: '#e4e1e9', disabledText: 'rgba(228,225,233,0.38)', destructive: '#f2b8b5', divider: '#46464f', pressed: 'rgba(228,225,233,0.1)' },
    alert: { card: '#424242', text: '#ffffff', button: '#80cbc4', pressed: 'rgba(255,255,255,0.2)', scrim: 'rgba(0,0,0,0.6)' },
    switch: { thumbOn: '#7dc7c0', thumbOff: '#b9b9b9', thumbDisabled: '#5f5f5f', trackOn: 'rgba(128,203,196,0.3)', trackOff: 'rgba(255,255,255,0.3)', trackDisabled: 'rgba(255,255,255,0.1)' },
    picker: { container: '#29292f', text: '#e4e1e9', muted: '#c7c5d0', divider: '#46464f', button: '#bbc3ff', onAccent: '#232c61', onAccentContainer: '#dee0ff', fieldContainer: '#34343a', outline: '#90909a', periodSelected: '#5d3c54', onPeriodSelected: '#ffd7f1', pressed: 'rgba(228,225,233,0.1)' },
  },
} as const

export function useMaterialPalette(): typeof palettes.light | typeof palettes.dark { return palettes[useAppColorScheme()] }

// Android draws these controls in Roboto (system font) and the menu check mark in Noto
// Sans Symbols. The fonts load once at startup; until then text falls back to the system font.
// The controls use React Native's Text, not AppText: Android's native dialogs and menus follow the
// system font size, not the in-app text size.
// Sources: Android 15's fonts (AOSP android15-release; the copies first used came from the emulator's
// /system/fonts and have the same size), cut with fontTools 4.67.0. Licenses: next to each font and in NOTICE.
// - roboto/: external/roboto-fonts Roboto-Regular.ttf, the roboto-classic v3.005 variable font, Apache 2.0,
//   sha256 9ca9debb09459bf4e3e7f826f5cd0f35f253902b85684921fce2ba3f28dd0f50. For w = 400 (Regular) and 500 (Medium):
//     fonttools varLib.instancer -q --update-name-table Roboto-Regular.ttf wght=$w wdth=100 ital=0 -o Roboto-$w.ttf
//     pyftsubset Roboto-$w.ttf --unicodes="U+0000-024F,U+02B0-036F,U+0370-03FF,U+0400-04FF,U+1E00-1EFF,U+2000-206F,U+20A0-20CF,U+2100-214F,U+2190-21FF,U+2200-22FF,U+FEFF,U+FFFD" --layout-features='*' --no-hinting --desubroutinize --output-file=Roboto-$w-sub.ttf
//   Results: Regular sha256 1ccf00dbcd248bbca29939aedb66d24ee22d94de8bc1de9f75adfcd95b3dc79d, Medium sha256
//   282b9e568a5b36ad1b891c586f5ac5d80c6f260aa7c9fa2a056bd42015c34b59; a rerun differs only in head.modified.
// - noto-sans-symbols/: external/noto-fonts notosanssymbols/NotoSansSymbols-Regular-Subsetted.ttf, OFL 1.1,
//   sha256 e47300d639a32c08610384baf325f021859da84a7ca129599af5130212dfea43:
//     pyftsubset NotoSansSymbols-Regular-Subsetted.ttf --unicodes=U+2713 --no-hinting --output-file=NotoSansSymbols-Check.ttf
//   Result: sha256 96fe9e68abbd89e1a92255e91e9685625aaf8e8a9397b3315655088ec2678647 (a rerun is byte-identical).
const fontSources = {
  'Roboto-Regular': require('../../../assets/fonts/roboto/Roboto-Regular.ttf'),
  'Roboto-Medium': require('../../../assets/fonts/roboto/Roboto-Medium.ttf'),
  'NotoSansSymbols-Check': require('../../../assets/fonts/noto-sans-symbols/NotoSansSymbols-Check.ttf'),
}
type MaterialFont = keyof typeof fontSources
let fontsLoaded = false
let fontsReady: Promise<void> | null = null
/** Started by the overlay host at launch, so the first menu or dialog already has them. */
export function loadMaterialFonts(): Promise<void> {
  fontsReady ??= Font.loadAsync(fontSources).then(() => { fontsLoaded = true }, () => undefined)
  return fontsReady
}

/** The family to style with, or undefined (system font) until the bundled font has loaded. */
export function useMaterialFont(name: MaterialFont): string | undefined {
  const [loaded, setLoaded] = useState(fontsLoaded)
  useEffect(() => {
    if (loaded) return
    let current = true
    void loadMaterialFonts().then(() => { if (current) setLoaded(fontsLoaded) })
    return () => { current = false }
  }, [loaded])
  return loaded ? name : undefined
}
