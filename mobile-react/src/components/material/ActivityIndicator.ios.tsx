import { useEffect } from 'react'
import { StyleSheet, View, type ActivityIndicatorProps } from 'react-native'
import Animated, { Easing, cancelAnimation, useAnimatedProps, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import Svg, { Path } from 'react-native-svg'
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

/** cubic-bezier(0.4, 0, 0.2, 1), the curve both trim interpolators are built from. */
function fastOutSlowIn(x: number): number {
  'worklet'
  if (x <= 0) return 0
  if (x >= 1) return 1
  let t = x
  for (let i = 0; i < 8; i += 1) {
    const u = 1 - t
    const bx = 3 * u * u * t * 0.4 + 3 * u * t * t * 0.2 + t * t * t
    const dx = 3 * u * u * 0.4 + 6 * u * t * (0.2 - 0.4) + 3 * t * t * (1 - 0.2)
    if (Math.abs(bx - x) < 1e-5 || dx === 0) break
    t = Math.min(1, Math.max(0, t - (bx - x) / dx))
  }
  const u = 1 - t
  return 3 * u * t * t + t * t * t
}

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
  const animatedProps = useAnimatedProps(() => {
    const p = trim.value
    const start = (p < 0.5 ? 0 : fastOutSlowIn((p - 0.5) * 2)) * 0.75 + 0.25 * p
    const end = (p < 0.5 ? fastOutSlowIn(p * 2) : 1) * 0.75 + 0.25 * p
    // Android draws nothing for an empty trim; a square-capped empty arc would leave a dot.
    if (end - start < 0.001) return { d: 'M 24 24' }
    const angle = (fraction: number) => ((rotation.value + fraction * 360 - 90) * Math.PI) / 180
    const x0 = 24 + RADIUS * Math.cos(angle(start))
    const y0 = 24 + RADIUS * Math.sin(angle(start))
    const x1 = 24 + RADIUS * Math.cos(angle(end))
    const y1 = 24 + RADIUS * Math.sin(angle(end))
    return { d: `M ${x0} ${y0} A ${RADIUS} ${RADIUS} 0 ${end - start > 0.5 ? 1 : 0} 1 ${x1} ${y1}` }
  })
  return <View accessibilityRole="progressbar" {...props} style={[styles.container, style]}>
    {animating || !hidesWhenStopped
      ? <Svg width={dimension} height={dimension} viewBox="0 0 48 48">
          <AnimatedPath animatedProps={animatedProps} stroke={color ?? accent} strokeWidth={STROKE} strokeLinecap="square" fill="none" />
        </Svg>
      : <View style={{ width: dimension, height: dimension }} />}
  </View>
}

const styles = StyleSheet.create({ container: { alignItems: 'center', justifyContent: 'center' } })
