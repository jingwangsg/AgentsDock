// iOS only: imported from lib/alert.ios.ts. No .ios suffix because tsc (no moduleSuffixes) could not resolve the import then.
import { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type AlertButton, type AlertOptions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { showMaterialOverlay, useKeyboardHeight } from './MaterialOverlay'
import { useMaterialFont, useMaterialPalette } from './materialTheme'
import { alertButtonLayout } from '../../lib/material-layout'

/**
 * React Native's Android Alert as build 78 draws it (an AppCompat AlertDialog with RN's own
 * title view), drawn by the app on iOS. Unlike Android it never drops buttons after the third.
 */
export function showAlertDialog(title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions): void {
  showMaterialOverlay(close => <AlertDialog title={title} message={message} buttons={buttons ?? [{ text: 'OK' }]} options={options} close={close} />)
}

type ButtonRole = 'neutral' | 'negative' | 'positive'

/** AppCompat's windowMinWidthMinor/Major for the normal, large and xlarge screen buckets. */
function cardWidth(width: number, height: number): number {
  const minor = Math.min(width, height)
  const major = Math.max(width, height)
  const [portrait, landscape] = major >= 960 && minor >= 720 ? [0.72, 0.45] : major >= 640 && minor >= 480 ? [0.8, 0.55] : [0.95, 0.65]
  // The window background is inset 16 pt on each side.
  return (width <= height ? portrait : landscape) * width - 32
}

function AlertDialog({ title, message, buttons, options, close }: { title: string; message?: string; buttons: AlertButton[]; options?: AlertOptions; close: () => void }) {
  const palette = useMaterialPalette().alert
  const regular = useMaterialFont('Roboto-Regular')
  const medium = useMaterialFont('Roboto-Medium')
  const screen = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardHeight()
  const bottom = Math.max(insets.bottom, keyboard)
  const width = cardWidth(screen.width, screen.height)
  const layout = alertButtonLayout(buttons)
  const roles = (['neutral', 'negative', 'positive'] as const).filter(role => layout.row?.[role])
  const [buttonWidths, setButtonWidths] = useState<Partial<Record<ButtonRole, number>>>({})
  const measured = roles.every(role => buttonWidths[role] !== undefined)
  // ButtonBarLayout stacks the buttons when they do not fit on one row (24 pt of side padding).
  const stacked = !layout.row || (measured && roles.reduce((sum, role) => sum + buttonWidths[role]!, 24) > width)
  const ready = !layout.row || measured
  const opacity = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (ready) Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start()
  }, [opacity, ready])
  const press = (button: AlertButton) => { close(); button.onPress?.() }
  const renderButton = (button: AlertButton, key: string | number, onWidth?: (width: number) => void) => <Pressable
    key={key}
    accessibilityRole="button"
    accessibilityLabel={button.text}
    onLayout={onWidth ? event => onWidth(event.nativeEvent.layout.width) : undefined}
    onPress={() => press(button)}
    style={({ pressed }) => [styles.button, pressed && { backgroundColor: palette.pressed }]}
  ><Text style={[styles.buttonText, { color: palette.button, fontFamily: medium }]}>{(button.text ?? '').toUpperCase()}</Text></Pressable>
  const rowButton = (role: ButtonRole) => {
    const button = layout.row?.[role]
    return button ? renderButton(button, role, value => setButtonWidths(current => ({ ...current, [role]: value }))) : null
  }
  return <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
    <Pressable
      accessible={false}
      style={[StyleSheet.absoluteFill, { backgroundColor: palette.scrim }]}
      onPress={() => {
        if (!options?.cancelable) return
        close()
        options.onDismiss?.()
      }}
    />
    {/* Centered between the system bars, like the Android dialog window. */}
    <View pointerEvents="box-none" style={[styles.center, { top: insets.top, bottom }]}>
      <View accessibilityViewIsModal style={[styles.card, { width, maxHeight: screen.height - insets.top - bottom - 32, backgroundColor: palette.card }]}>
        <Text accessibilityRole="header" numberOfLines={2} style={[styles.title, { color: palette.text, fontFamily: medium }]}>{title}</Text>
        <ScrollView keyboardShouldPersistTaps="always" style={styles.content} contentContainerStyle={styles.contentInner} bounces={false}>
          <Text style={[styles.message, { color: palette.text, fontFamily: regular }]}>{message ?? ''}</Text>
        </ScrollView>
        {stacked
          ? <View style={styles.buttonsStacked}>{layout.stacked.map((button, index) => renderButton(button, index))}</View>
          : <View style={styles.buttonsRow}>
              {/* AppCompat's button bar: neutral, a flexible space, negative, positive. */}
              {rowButton('neutral')}
              <View style={styles.spacer} />
              {rowButton('negative')}
              {rowButton('positive')}
            </View>}
      </View>
    </View>
  </Animated.View>
}

// Android sizes are in dp. Roboto's font padding (Android's includeFontPadding) is added as
// padding; the remaining fractions were calibrated against Android screenshots so text,
// buttons and the card edge land on the same rows.
const styles = StyleSheet.create({
  center: { position: 'absolute', left: 0, right: 0, alignItems: 'center', justifyContent: 'center' },
  card: {
    borderRadius: 2,
    overflow: 'hidden',
    boxShadow: '0px 9px 46px 8px rgba(0,0,0,0.12), 0px 24px 38px 3px rgba(0,0,0,0.14), 0px 11px 15px -7px rgba(0,0,0,0.2)',
  },
  // RN's alert_title_layout: 18 pt top padding, 24 pt sides; TextAppearance.AppCompat.Title.
  title: { paddingTop: 18 + 2.57, paddingBottom: 0.54, paddingHorizontal: 24, fontSize: 20, lineHeight: 23.24 },
  // AppCompat's contentPanel (min 48 pt) after the 8 pt titleDividerNoCustom space.
  content: { flexGrow: 0, flexShrink: 1, marginTop: 8 },
  contentInner: { minHeight: 48 },
  message: { paddingTop: 2.72, paddingBottom: 0.43, paddingHorizontal: 24, fontSize: 16, lineHeight: 18.67 },
  buttonsRow: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12, paddingTop: 5, paddingBottom: 4 },
  buttonsStacked: { alignItems: 'flex-end', paddingHorizontal: 12, paddingTop: 5, paddingBottom: 4 },
  spacer: { flex: 1 },
  button: { minWidth: 64, height: 54, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 14 },
})
