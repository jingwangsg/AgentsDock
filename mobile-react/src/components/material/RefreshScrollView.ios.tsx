import { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { Easing, cancelAnimation, runOnJS, useAnimatedProps, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import Svg, { Path } from 'react-native-svg'
import { arcPath, indeterminateArc } from './materialArc'
import type { RefreshScrollViewProps } from './RefreshScrollView'

const AnimatedPath = Animated.createAnimatedComponent(Path)

// androidx SwipeRefreshLayout with React Native's default colors, as Android build 78 draws it:
// a 40 pt #fafafa circle drops from above the list following half the finger's travel after an
// 8 pt slop, eases out past 64 pt, and refreshes when let go beyond 64 pt, then spins 24 pt below
// the top until refreshing ends and it scales away. The list itself does not move or bounce.
const CIRCLE = 40
const TARGET = 64
const SLOP = 8
const CENTER = CIRCLE / 2
const RING = 7.5
const STROKE = 2.5

export function RefreshScrollView({ refreshing, onRefresh, tintColor: _tintColor, style, children, ...props }: RefreshScrollViewProps) {
  const scrollY = useSharedValue(0)
  const pull = useSharedValue(refreshing ? TARGET : 0)
  const pulling = useSharedValue(false)
  const spinning = useSharedValue(refreshing)
  const scale = useSharedValue(1)
  const trim = useSharedValue(0)
  const rotation = useSharedValue(0)

  useEffect(() => {
    if (refreshing) {
      // Refreshing that starts without a pull (or after one) shows the spinning circle in place.
      if (!spinning.value) {
        spinning.value = true
        pull.value = TARGET
        scale.value = 0
        scale.value = withTiming(1, { duration: 150 })
      }
      trim.value = withRepeat(withTiming(1, { duration: 1333, easing: Easing.linear }), -1)
      rotation.value = withRepeat(withTiming(720, { duration: 4444, easing: Easing.linear }), -1)
      return
    }
    if (!spinning.value) return
    scale.value = withTiming(0, { duration: 150 }, finished => {
      if (!finished) return
      spinning.value = false
      pull.value = 0
      scale.value = 1
    })
    cancelAnimation(trim)
    cancelAnimation(rotation)
  }, [pull, refreshing, rotation, scale, spinning, trim])

  const onScroll = useAnimatedScrollHandler(event => { scrollY.value = event.contentOffset.y })
  const pan = Gesture.Pan()
    .activeOffsetY(SLOP)
    .onStart(() => { pulling.value = scrollY.value <= 0 && !spinning.value })
    .onUpdate(event => { if (pulling.value) pull.value = Math.max(0, (event.translationY - SLOP) / 2) })
    .onFinalize(() => {
      if (!pulling.value) return
      pulling.value = false
      if (pull.value > TARGET) {
        spinning.value = true
        pull.value = withTiming(TARGET, { duration: 200 })
        runOnJS(onRefresh)()
      } else {
        pull.value = withTiming(0, { duration: 200 })
      }
    })
  const gesture = Gesture.Simultaneous(Gesture.Native(), pan)

  // SwipeRefreshLayout.moveSpinner: position, arc length, rotation and arrow size for a pull.
  const circleStyle = useAnimatedStyle(() => {
    const dragPercent = Math.min(1, pull.value / TARGET)
    const tension = Math.max(0, Math.min(pull.value - TARGET, TARGET * 2) / TARGET)
    const tensionPercent = (tension / 4 - (tension / 4) ** 2) * 2
    return {
      opacity: pull.value > 0 || spinning.value ? 1 : 0,
      transform: [{ translateY: -CIRCLE + TARGET * dragPercent + TARGET * tensionPercent * 2 }, { scale: scale.value }],
    }
  })
  const pullTurns = () => {
    'worklet'
    const dragPercent = Math.min(1, pull.value / TARGET)
    const adjusted = Math.max(dragPercent - 0.4, 0) * 5 / 3
    const tension = Math.max(0, Math.min(pull.value - TARGET, TARGET * 2) / TARGET)
    const tensionPercent = (tension / 4 - (tension / 4) ** 2) * 2
    // Turns from 12 o'clock; Android's progress rotation counts from 3 o'clock.
    const start = (-0.25 + 0.4 * adjusted + tensionPercent * 2) * 0.5 + 0.25
    return { start, end: start + Math.min(0.8, adjusted * 0.8), arrow: Math.min(1, adjusted) }
  }
  const arcProps = useAnimatedProps(() => {
    if (spinning.value) return { d: indeterminateArc(trim.value, rotation.value, CENTER, CENTER, RING), strokeOpacity: 1 }
    const turns = pullTurns()
    return { d: arcPath(CENTER, CENTER, RING, turns.start, turns.end), strokeOpacity: pull.value < TARGET ? 0.3 : 1 }
  })
  // CircularProgressDrawable.drawTriangle: a 10 × 5 pt arrowhead (times the arrow scale) at the
  // arc's end, its base across the ring and its tip pointing clockwise.
  const arrowProps = useAnimatedProps(() => {
    if (spinning.value) return { d: '', fillOpacity: 0 }
    const turns = pullTurns()
    const width = 10 * turns.arrow
    const height = 5 * turns.arrow
    const angle = (turns.end - 0.25) * 2 * Math.PI
    const point = (x: number, y: number) => `${CENTER + x * Math.cos(angle) - y * Math.sin(angle)} ${CENTER + x * Math.sin(angle) + y * Math.cos(angle)}`
    return {
      d: `M ${point(RING - width / 2, STROKE / 2)} L ${point(RING + width / 2, STROKE / 2)} L ${point(RING, STROKE / 2 + height)} Z`,
      fillOpacity: pull.value < TARGET ? 0.3 : 1,
    }
  })

  return <View style={[style, styles.clip]}>
    <GestureDetector gesture={gesture}>
      <Animated.ScrollView {...props} style={styles.fill} bounces={false} onScroll={onScroll} scrollEventThrottle={16}>{children}</Animated.ScrollView>
    </GestureDetector>
    <Animated.View pointerEvents="none" style={[styles.circle, circleStyle]}>
      <Svg width={CIRCLE} height={CIRCLE}>
        <AnimatedPath animatedProps={arcProps} stroke="#000000" strokeWidth={STROKE} strokeLinecap="square" fill="none" />
        <AnimatedPath animatedProps={arrowProps} fill="#000000" />
      </Svg>
    </Animated.View>
  </View>
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  fill: { flex: 1 },
  circle: {
    position: 'absolute',
    top: 0,
    left: '50%',
    marginLeft: -CIRCLE / 2,
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    backgroundColor: '#fafafa',
    // CircleImageView's 4 dp elevation.
    boxShadow: '0px 2px 4px 0px rgba(0,0,0,0.3)',
  },
})
