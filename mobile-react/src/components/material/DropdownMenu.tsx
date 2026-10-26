import { useEffect, useRef, useState } from 'react'
import { Animated, Easing, Keyboard, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { MenuAction } from '@expo/ui/community/menu'
import { showMaterialOverlay } from './MaterialOverlay'
import { useMaterialFont, useMaterialPalette } from './materialTheme'
import { dropdownMenuPosition, type Rect, type Size } from '../../lib/material-layout'

/** Compose's calculateTransformOrigin: the menu grows out of the edge it shares with the anchor. */
function transformOrigin(anchor: Rect, menu: Rect): [number, number, number] {
  const pivot = (anchorStart: number, anchorEnd: number, menuStart: number, menuSize: number) => {
    const menuEnd = menuStart + menuSize
    if (menuStart >= anchorEnd) return 0
    if (menuEnd <= anchorStart) return 1
    if (menuSize === 0) return 0
    return ((Math.max(anchorStart, menuStart) + Math.min(anchorEnd, menuEnd)) / 2 - menuStart) / menuSize
  }
  const x = pivot(anchor.x, anchor.x + anchor.width, menu.x, menu.width)
  const y = pivot(anchor.y, anchor.y + anchor.height, menu.y, menu.height)
  return [x * menu.width, y * menu.height, 0]
}

type MenuRequest = {
  /** Reports the anchor's frame in window coordinates. */
  measureAnchor: (callback: (anchor: Rect) => void) => void
  actions: MenuAction[]
  onAction: (id: string) => void
  onClose?: () => void
}

/** Opens an Android-style dropdown anchored to the view `measureAnchor` reports. */
export function showDropdownMenu(request: MenuRequest): void {
  showMaterialOverlay(dismiss => <DropdownMenuLayer {...request} dismiss={dismiss} />)
}

// A Compose popup follows its anchor. A sidebar row is still scaling back from its long-press
// lift when the menu opens, so the anchor is measured again for this long.
const FOLLOW_ANCHOR_MS = 600

function DropdownMenuLayer({ measureAnchor, actions, onAction, onClose, dismiss }: MenuRequest & { dismiss: () => void }) {
  const [anchor, setAnchor] = useState<Rect | null>(null)
  const [submenu, setSubmenu] = useState<{ anchor: Rect; actions: MenuAction[] } | null>(null)
  useEffect(() => {
    const until = Date.now() + FOLLOW_ANCHOR_MS
    let frame = 0
    const measure = () => {
      measureAnchor(next => setAnchor(current => current && sameRect(current, next) ? current : next))
      if (Date.now() < until) frame = requestAnimationFrame(measure)
    }
    measure()
    return () => cancelAnimationFrame(frame)
  }, [measureAnchor])
  const closeAll = () => { dismiss(); onClose?.() }
  const choose = (id: string) => { closeAll(); onAction(id) }
  if (!anchor) return null
  return <>
    {/* A tap outside dismisses only the topmost menu and is consumed, as Compose popups do. */}
    <Pressable accessible={false} style={StyleSheet.absoluteFill} onPress={closeAll} />
    <MenuSurface anchor={anchor} actions={actions} onChoose={choose} onOpenSubmenu={(itemAnchor, subactions) => setSubmenu({ anchor: itemAnchor, actions: subactions })} />
    {submenu ? <>
      <Pressable accessible={false} style={StyleSheet.absoluteFill} onPress={() => setSubmenu(null)} />
      <MenuSurface anchor={submenu.anchor} actions={submenu.actions} onChoose={choose} onOpenSubmenu={() => undefined} />
    </> : null}
  </>
}

function sameRect(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5
}

function MenuSurface({ anchor, actions, onChoose, onOpenSubmenu }: {
  anchor: Rect
  actions: MenuAction[]
  onChoose: (id: string) => void
  onOpenSubmenu: (anchor: Rect, actions: MenuAction[]) => void
}) {
  const palette = useMaterialPalette().menu
  const screen = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const [size, setSize] = useState<Size | null>(null)
  const scale = useRef(new Animated.Value(0.8)).current
  const opacity = useRef(new Animated.Value(0)).current
  const keyboardHeight = Keyboard.isVisible() ? Keyboard.metrics()?.height ?? 0 : 0
  const window = { width: screen.width, height: screen.height - insets.top - Math.max(insets.bottom, keyboardHeight) }
  const position = size ? dropdownMenuPosition(anchor, window, size) : null
  useEffect(() => {
    if (!position) return
    Animated.parallel([
      Animated.timing(scale, { toValue: 1, duration: 150, easing: Easing.bezier(0.2, 0, 0, 1), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 100, easing: Easing.linear, useNativeDriver: true }),
    ]).start()
  }, [Boolean(position)]) // eslint-disable-line react-hooks/exhaustive-deps
  const rows = flattenActions(actions)
  return <Animated.View
    accessibilityViewIsModal
    onLayout={event => { if (!size) setSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height }) }}
    style={[styles.surface, {
      left: position?.x ?? 0,
      top: position?.y ?? 0,
      maxHeight: window.height,
      backgroundColor: palette.container,
      opacity: position ? opacity : 0,
      transform: [{ scale: position ? scale : 1 }],
      transformOrigin: position && size ? transformOrigin(anchor, { ...position, ...size }) : undefined,
    }]}
  >
    <ScrollView bounces={false} showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
      {rows.map((row, index) => row === 'divider'
        ? <View key={`divider-${index}`} style={[styles.divider, { backgroundColor: palette.divider }]} />
        : <MenuItem key={row.id ?? row.title} action={row} menuOrigin={position} onChoose={onChoose} onOpenSubmenu={onOpenSubmenu} />)}
    </ScrollView>
  </Animated.View>
}

/** @expo/ui's Android MenuView: hidden items drop out; an inline group is wrapped in dividers. */
function flattenActions(actions: MenuAction[]): Array<MenuAction | 'divider'> {
  return actions.flatMap(action => {
    if (action.attributes?.hidden) return []
    if (action.displayInline && action.subactions?.length) return ['divider' as const, ...flattenActions(action.subactions), 'divider' as const]
    return [action]
  })
}

function MenuItem({ action, menuOrigin, onChoose, onOpenSubmenu }: {
  action: MenuAction
  menuOrigin: { x: number; y: number } | null
  onChoose: (id: string) => void
  onOpenSubmenu: (anchor: Rect, actions: MenuAction[]) => void
}) {
  const palette = useMaterialPalette().menu
  const regular = useMaterialFont('Roboto-Regular')
  const check = useMaterialFont('NotoSansSymbols-Check')
  const frame = useRef<{ y: number; width: number; height: number } | null>(null)
  const disabled = Boolean(action.attributes?.disabled)
  const color = action.titleColor ?? (action.attributes?.destructive ? palette.destructive : disabled ? palette.disabledText : palette.text)
  const hasSubmenu = Boolean(action.subactions?.length)
  const checked = !hasSubmenu && action.state === 'on'
  return <Pressable
    accessibilityRole="menuitem"
    accessibilityLabel={action.title}
    accessibilityState={{ disabled, checked: checked || undefined }}
    disabled={disabled}
    onLayout={event => { frame.current = event.nativeEvent.layout }}
    onPress={() => {
      if (!hasSubmenu) { onChoose(action.id ?? action.title); return }
      const item = frame.current
      if (!item || !menuOrigin) return
      // Compose anchors a submenu to its trigger item, in window coordinates.
      onOpenSubmenu({ x: menuOrigin.x, y: menuOrigin.y + item.y, width: item.width, height: item.height }, action.subactions!)
    }}
    style={({ pressed }) => [styles.item, pressed && { backgroundColor: palette.pressed }]}
  >
    <Text style={[styles.itemText, { color, fontFamily: regular }, checked && styles.itemTextWithTrailing]}>{action.title}</Text>
    {checked ? <View style={styles.trailing}><Text style={[styles.itemText, { color, fontFamily: check }]}>✓</Text></View> : null}
  </Pressable>
}

// Compose Material 3 DropdownMenu as Android build 78 draws it through @expo/ui's MenuView:
// 48 pt rows, 12 pt side padding, 8 pt vertical padding, 112–280 pt wide, 4 pt corners, 1 pt
// dividers, Roboto 14, no icons (Android ignores SF Symbol names).
const styles = StyleSheet.create({
  surface: {
    position: 'absolute',
    borderRadius: 4,
    // Material elevation level 2 (3 dp), as the Compose Surface draws it.
    boxShadow: '0px 1px 2px 0px rgba(0,0,0,0.3), 0px 2px 6px 2px rgba(0,0,0,0.15)',
  },
  content: { paddingVertical: 8 },
  divider: { height: 1 },
  item: { minHeight: 48, minWidth: 112, maxWidth: 280, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center' },
  // Calibrated on screenshots: Android draws this text 0.12 pt narrower per glyph and 0.67 pt lower.
  itemText: { fontSize: 14, letterSpacing: -0.12, paddingTop: 1.33, flexShrink: 1 },
  itemTextWithTrailing: { flexGrow: 1, paddingRight: 12 },
  trailing: { minWidth: 24 },
})
