// Page sheet for one expanded chat table; the caller renders the table itself.
import type { ReactNode } from 'react'
import { Modal, Platform, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { usePalette } from '../theme'
import { Text } from './AppText'
import { SheetCloseButton } from './ui'

export function MarkdownTableSheet({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const colors = usePalette()
  return (
    <Modal visible animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} allowSwipeDismissal onRequestClose={onClose}>
      <SafeAreaView style={[styles.sheet, { backgroundColor: colors.background }]} edges={['bottom']}>
        <View style={styles.grabber} />
        <View style={styles.top}>
          <Text style={[styles.title, { color: colors.text }]}>Table</Text>
          <SheetCloseButton onPress={onClose} label="Close table" testID="markdown-table-close" />
        </View>
        {/* maximumZoomScale is UIScrollView pinch-to-zoom; Android has no zoom here and relies on the table's own horizontal scroll. */}
        <ScrollView maximumZoomScale={3} contentContainerStyle={styles.content}>{children}</ScrollView>
      </SafeAreaView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  grabber: { alignSelf: 'center', width: 36, height: 5, marginTop: 7, borderRadius: 3, backgroundColor: '#8a8a8a88' },
  top: { minHeight: 64, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4, flexDirection: 'row', alignItems: 'center' },
  title: { flex: 1, fontSize: 16, fontWeight: '800' },
  content: { paddingHorizontal: 14, paddingBottom: 24 },
})
