import { useEffect } from 'react'
import { StyleSheet, View, type ActivityIndicatorProps } from 'react-native'
import Animated, { Easing, cancelAnimation, useAnimatedProps, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import Svg, { Path } from 'react-native-svg'
import { indeterminateArc } from './materialArc'
import { useMaterialPalette } from './materialTheme'

const AnimatedPath = Animated.createAnimatedComponent(Path)

// Android's indeterminate ProgressBar (AOSP vector_drawable_progress_bar_medium and its
// animators): a 48-unit viewport with a radius-19 circle stroked 4 wide with square caps,
// trimmed by fast-out-slow-in curves over 1333 ms while the group turns 720° every 4444 ms.
// React Native sizes it 20 (small), 36 (large) or the given number of points.
const TRIM_MS = 1333
const ROTATION_MS = 4444
const RADIUS = 19
const STROKE = 4

export function ActivityIndicator({ animating = true, color, size = 'small', hidesWhenStopped = true, style, ...props }: ActivityIndicatorProps) {
  const accent = useMaterialPalette().switch.accent
  const dimension = size === 'small' ? 20 : size === 'large' ? 36 : size
  const trim = useSharedValue(0)
  const rotation = useSharedValue(0)
  useEffect(() => {
    if (!animating) return
    trim.value = withRepeat(withTiming(1, { duration: TRIM_MS, easing: Easing.linear }), -1)
    rotation.value = withRepeat(withTiming(720, { duration: ROTATION_MS, easing: Easing.linear }), -1)
    return () => {
      cancelAnimation(trim)
      cancelAnimation(rotation)
      trim.value = 0
      rotation.value = 0
    }
  }, [animating, rotation, trim])
  const animatedProps = useAnimatedProps(() => ({ d: indeterminateArc(trim.value, rotation.value, 24, 24, RADIUS) }))
  return <View accessibilityRole="progressbar" {...props} style={[styles.container, style]}>
    {animating || !hidesWhenStopped
      ? <Svg width={dimension} height={dimension} viewBox="0 0 48 48">
          <AnimatedPath animatedProps={animatedProps} stroke={color ?? accent} strokeWidth={STROKE} strokeLinecap="square" fill="none" />
        </Svg>
      : <View style={{ width: dimension, height: dimension }} />}
  </View>
}

const styles = StyleSheet.create({ container: { alignItems: 'center', justifyContent: 'center' } })
