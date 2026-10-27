import { Platform, StyleSheet, View, type ViewProps } from 'react-native'
import { SafeAreaView, useSafeAreaInsets, type Edge } from 'react-native-safe-area-context'
import { fullscreenModalPadding } from '../lib/fullscreen-modal-layout'

/**
 * Root of a full-screen modal page. Android lays it out with SafeAreaView.
 * Inside an iOS full-screen Modal, SafeAreaView reads zero insets (the modal
 * has its own native root), so iOS pads with the app-level insets, added to the
 * style's own paddingTop as SafeAreaView does. iOS always pads the top so the
 * grabber and header clear the status bar and the Dynamic Island.
 */
export function ModalSafeArea({ edges, style, children, ...props }: ViewProps & { edges: Edge[] }) {
  const insets = useSafeAreaInsets()
  if (Platform.OS !== 'ios') return <SafeAreaView edges={edges} style={style} {...props}>{children}</SafeAreaView>
  const padding = fullscreenModalPadding(insets, Platform.OS)
  const ownTop = StyleSheet.flatten(style)?.paddingTop
  return <View style={[style, {
    paddingTop: padding.paddingTop + (typeof ownTop === 'number' ? ownTop : 0),
    ...edges.includes('right') ? { paddingRight: padding.paddingRight } : null,
    ...edges.includes('bottom') ? { paddingBottom: padding.paddingBottom } : null,
    ...edges.includes('left') ? { paddingLeft: padding.paddingLeft } : null,
  }]} {...props}>{children}</View>
}
