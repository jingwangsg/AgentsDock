import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native'
import { Download, RefreshCw, X } from 'lucide-react-native'
import { Text } from '../AppText'

// What the app draws while a video opens and when it fails, shared by the
// Android stream player and the iOS staged download and player.

export function VideoLoadingStatus({ percent }: { percent?: number | null }) {
  return <View
    accessible
    accessibilityRole="progressbar"
    accessibilityLabel="Loading video"
    accessibilityValue={percent == null ? undefined : { min: 0, max: 100, now: percent }}
    pointerEvents="none"
    style={styles.videoStatus}
  >
    <ActivityIndicator color="white" />
    <Text style={styles.videoLoadingText}>Loading video…</Text>
  </View>
}

export function VideoLoadProblem({ message, onRetry, onDownload, onClose }: {
  message: string
  onRetry: () => void
  onDownload: () => void
  onClose: () => void
}) {
  return <View accessibilityRole="alert" testID="artifact-video-problem" style={styles.videoProblem}>
    <Text style={styles.videoProblemTitle}>Video could not be opened</Text>
    <Text style={styles.videoProblemBody} numberOfLines={4}>{message}</Text>
    <View style={styles.videoProblemActions}>
      <Pressable accessibilityRole="button" accessibilityLabel="Retry opening video" testID="artifact-video-retry" onPress={onRetry} style={({ pressed }) => [styles.videoProblemButton, { opacity: pressed ? 0.68 : 1 }]}><RefreshCw size={16} color="white" /><Text style={styles.videoProblemButtonText}>Retry</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Download video" testID="artifact-video-download" onPress={onDownload} style={({ pressed }) => [styles.videoProblemButton, { opacity: pressed ? 0.68 : 1 }]}><Download size={16} color="white" /><Text style={styles.videoProblemButtonText}>Download</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Close video viewer" testID="artifact-video-problem-close" onPress={onClose} style={({ pressed }) => [styles.videoProblemButton, { opacity: pressed ? 0.68 : 1 }]}><X size={16} color="white" /><Text style={styles.videoProblemButtonText}>Close</Text></Pressable>
    </View>
  </View>
}

const styles = StyleSheet.create({
  videoStatus: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', gap: 9 },
  videoLoadingText: { color: '#d6d8dc', fontSize: 12, lineHeight: 17, fontWeight: '700' },
  videoProblem: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 4, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 7, backgroundColor: '#050506e8' },
  videoProblemTitle: { color: 'white', fontSize: 16, fontWeight: '800', textAlign: 'center' },
  videoProblemBody: { color: '#b7bbc2', fontSize: 12, textAlign: 'center' },
  videoProblemActions: { marginTop: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8 },
  videoProblemButton: { minWidth: 96, minHeight: 44, borderRadius: 10, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: '#23262b' },
  videoProblemButtonText: { color: 'white', fontSize: 12, lineHeight: 16, fontWeight: '800' },
})
