import { createContext, forwardRef, useContext, type ComponentRef, type ReactNode } from 'react'
import {
  StyleSheet,
  Text as NativeText,
  TextInput as NativeTextInput,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
} from 'react-native'
import { APP_FONT_SCALE_DEFAULT, fonts, scaleAppFont } from '../lib/typography'
import { useAppStore } from '../store/useAppStore'

const DEFAULT_NATIVE_TEXT_SIZE = 14
const AppFontScaleContext = createContext(APP_FONT_SCALE_DEFAULT)
// null outside any Text: only the outermost Text sets the UI font, so a nested
// span keeps inheriting a parent's font (e.g. Lilex inside a code line).
const InheritedTextSizeContext = createContext<number | null>(null)
const uiFont: TextStyle = { fontFamily: fonts.ui }

export function AppTypographyProvider({ children }: { children: ReactNode }) {
  const fontScale = useAppStore(state => state.fontScale)
  return <AppFontScaleContext.Provider value={fontScale}>{children}</AppFontScaleContext.Provider>
}

function baseTextSize(style: StyleProp<TextStyle> | undefined, inheritedSize: number): number {
  const flattened = StyleSheet.flatten(style)
  return typeof flattened?.fontSize === 'number' ? flattened.fontSize : inheritedSize
}

function scaledStyle(style: StyleProp<TextStyle> | undefined, scale: number, fallbackSize: number): StyleProp<TextStyle> {
  if (scale === APP_FONT_SCALE_DEFAULT) return style
  const flattened = StyleSheet.flatten(style)
  const fontSize = typeof flattened?.fontSize === 'number' ? flattened.fontSize : fallbackSize
  const override: TextStyle = { fontSize: scaleAppFont(fontSize, scale) }
  if (typeof flattened?.lineHeight === 'number') override.lineHeight = scaleAppFont(flattened.lineHeight, scale)
  return [style, override]
}

export type Text = ComponentRef<typeof NativeText>
export const Text = forwardRef<Text, TextProps>(function AppText({ children, style, ...props }, ref) {
  const fontScale = useContext(AppFontScaleContext)
  const parentSize = useContext(InheritedTextSizeContext)
  const inheritedSize = parentSize ?? DEFAULT_NATIVE_TEXT_SIZE
  const currentSize = baseTextSize(style, inheritedSize)
  const fontStyle = parentSize === null ? [uiFont, style] : style
  return <InheritedTextSizeContext.Provider value={currentSize}>
    <NativeText ref={ref} style={scaledStyle(fontStyle, fontScale, inheritedSize)} {...props}>{children}</NativeText>
  </InheritedTextSizeContext.Provider>
})

export type TextInput = ComponentRef<typeof NativeTextInput>
export const TextInput = forwardRef<TextInput, TextInputProps>(function AppTextInput({ style, ...props }, ref) {
  const fontScale = useContext(AppFontScaleContext)
  return <NativeTextInput ref={ref} style={scaledStyle([uiFont, style], fontScale, DEFAULT_NATIVE_TEXT_SIZE)} {...props} />
})
