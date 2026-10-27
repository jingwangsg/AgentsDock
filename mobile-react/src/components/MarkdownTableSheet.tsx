// Page sheet for one expanded chat table; the caller renders the table itself.
import type { ReactNode } from 'react'
import { Modal, ScrollView, StyleSheet, View } from 'react-native'
import { usePalette } from '../theme'
import { Text } from './AppText'
import { CopyTextButton } from './CopyTextButton'
import { ModalSafeArea } from './ModalSafeArea'
import { SheetCloseButton } from './ui'

export function MarkdownTableSheet({ children, markdown, onClose }: { children: ReactNode; markdown: string; onClose: () => void }) {
  const colors = usePalette()
  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <ModalSafeArea style={[styles.sheet, { backgroundColor: colors.background }]} edges={['bottom']}>
        <View style={styles.grabber} />
        <View style={styles.top}>
          <Text style={[styles.title, { color: colors.text }]}>Table</Text>
          <CopyTextButton text={markdown} label="Copy as Markdown" testID="markdown-table-copy" touchSize={48} />
          <SheetCloseButton onPress={onClose} label="Close table" testID="markdown-table-close" />
        </View>
        {/* maximumZoomScale is UIScrollView pinch-to-zoom; Android has no zoom here and relies on the table's own horizontal scroll. */}
        <ScrollView maximumZoomScale={3} contentContainerStyle={styles.content}>{children}</ScrollView>
      </ModalSafeArea>
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
