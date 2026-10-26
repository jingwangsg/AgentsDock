import { useEffect, useRef } from 'react'
import { Animated, Pressable, StyleSheet, type SwitchProps } from 'react-native'
import { useMaterialPalette } from './materialTheme'

// SwitchCompat as React Native lays it out on Android build 78: a 46.5 × 27 pt view, a
// 23.3 × 13.4 pt track and a 20 pt thumb whose center moves between x 13.5 and 33 in 250 ms.
// Colors are the AppCompat accent and switch defaults (no colors are passed in this app).
const WIDTH = 46.5
const HEIGHT = 27
const THUMB = 20
const THUMB_OFF_X = 13.5 - THUMB / 2
const THUMB_ON_X = 33 - THUMB / 2

export function Switch({ value = false, onValueChange, disabled, style, testID, accessibilityLabel, ...props }: SwitchProps) {
  const palette = useMaterialPalette().switch
  const position = useRef(new Animated.Value(value ? 1 : 0)).current
  useEffect(() => {
    Animated.timing(position, { toValue: value ? 1 : 0, duration: 250, useNativeDriver: false }).start()
  }, [position, value])
  const thumbColor = disabled ? palette.thumbDisabled : position.interpolate({ inputRange: [0, 1], outputRange: [palette.thumbOff, palette.thumbOn] })
  const trackColor = disabled ? palette.trackDisabled : position.interpolate({ inputRange: [0, 1], outputRange: [palette.trackOff, palette.trackOn] })
  return <Pressable
    {...props}
    testID={testID}
    accessibilityRole="switch"
    accessibilityLabel={accessibilityLabel}
    accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
    disabled={disabled}
    onPress={() => onValueChange?.(!value)}
    style={[styles.root, style]}
  >
    <Animated.View style={[styles.track, { backgroundColor: trackColor }]} />
    <Animated.View style={[styles.thumb, {
      backgroundColor: thumbColor,
      transform: [{ translateX: position.interpolate({ inputRange: [0, 1], outputRange: [THUMB_OFF_X, THUMB_ON_X] }) }],
    }]} />
  </Pressable>
}

const styles = StyleSheet.create({
  root: { width: WIDTH, height: HEIGHT },
  track: { position: 'absolute', left: 11.6, top: (HEIGHT - 13.4) / 2, width: 23.3, height: 13.4, borderRadius: 6.7 },
  // The AppCompat thumb image carries its own soft shadow.
  thumb: { position: 'absolute', left: 0, top: (HEIGHT - THUMB) / 2, width: THUMB, height: THUMB, borderRadius: THUMB / 2, boxShadow: '0px 1px 2px 0px rgba(0,0,0,0.3)' },
})
