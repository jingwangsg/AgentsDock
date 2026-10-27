import { Pressable, StyleSheet, View } from 'react-native'
import { ZoomIn, ZoomOut } from 'lucide-react-native'
import { isVideoFilled, type VideoContentFitMode } from '../../lib/video-fit'

/** Zoom out fits the whole video; Zoom in fills the viewer. Drawn by the app over both platforms' players. */
export function VideoZoomControls({ fit, onChange }: { fit: VideoContentFitMode; onChange: (fit: VideoContentFitMode) => void }) {
  const videoFilled = isVideoFilled(fit)
  return <View pointerEvents="box-none" testID="artifact-video-zoom-controls" style={styles.videoZoomControls}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Zoom video out"
      accessibilityHint="Fits the entire video inside the viewer"
      accessibilityState={{ disabled: !videoFilled }}
      testID="artifact-video-zoom-out"
      disabled={!videoFilled}
      onPress={() => onChange('contain')}
      style={({ pressed }) => [styles.videoZoomButton, { opacity: !videoFilled ? 0.34 : pressed ? 0.65 : 1 }]}
    >
      <ZoomOut size={19} color="white" />
    </Pressable>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Zoom video in"
      accessibilityHint="Fills the viewer and may crop the video edges"
      accessibilityState={{ disabled: videoFilled }}
      testID="artifact-video-zoom-in"
      disabled={videoFilled}
      onPress={() => onChange('cover')}
      style={({ pressed }) => [styles.videoZoomButton, { opacity: videoFilled ? 0.34 : pressed ? 0.65 : 1 }]}
    >
      <ZoomIn size={19} color="white" />
    </Pressable>
  </View>
}

const styles = StyleSheet.create({
  videoZoomControls: { position: 'absolute', top: 10, right: 10, zIndex: 3, height: 44, borderRadius: 22, flexDirection: 'row', alignItems: 'center', overflow: 'hidden', backgroundColor: '#000000c9' },
  videoZoomButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
})
