import {
  requireAgentsDockNativeVideo,
  type AgentsDockNativeVideoHandle,
  type AgentsDockNativeVideoStatus,
} from 'agentsdock-native-video'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View, type NativeSyntheticEvent } from 'react-native'
import type { VideoContentFitMode } from '../../lib/video-fit'
import { VideoLoadingStatus, VideoLoadProblem } from './VideoStatusViews'
import { VideoZoomControls } from './VideoZoomControls'

const IOS_NATIVE_VIDEO_LOAD_TIMEOUT_MS = 15_000

export function ArtifactIOSSystemVideoPlayer({ sourceURI, registerPause, onDownload, onClose, onRetrySource }: {
  sourceURI: string
  registerPause: (pause: () => void) => () => void
  onDownload: () => void
  onClose: () => void
  onRetrySource: () => void
}) {
  const NativeVideo = useMemo(requireAgentsDockNativeVideo, [])
  const playerRef = useRef<AgentsDockNativeVideoHandle | null>(null)
  const [ready, setReady] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [videoFit, setVideoFit] = useState<VideoContentFitMode>('contain')

  const pause = useCallback(() => {
    void playerRef.current?.pause().catch(() => undefined)
  }, [])
  const close = useCallback(() => {
    pause()
    onClose()
  }, [onClose, pause])
  const retry = useCallback(() => {
    pause()
    setReady(false)
    setProblem(null)
    onRetrySource()
  }, [onRetrySource, pause])
  const handleStatus = useCallback((event: NativeSyntheticEvent<AgentsDockNativeVideoStatus>) => {
    const { status, message } = event.nativeEvent
    if (status === 'Error') {
      setReady(false)
      const detail = message?.trim()
      setProblem(detail ? `Video could not be played: ${detail}` : 'Video could not be played.')
      return
    }
    if (status === 'Ready' || status === 'Playing' || status === 'Paused') {
      setReady(true)
      setProblem(null)
    }
  }, [])

  useEffect(() => registerPause(pause), [pause, registerPause])
  useEffect(() => () => pause(), [pause])
  useEffect(() => {
    setReady(false)
    setProblem(null)
    setVideoFit('contain')
  }, [sourceURI])
  useEffect(() => {
    if (ready || problem) return
    const timeout = setTimeout(() => {
      setProblem('Video loading took too long. Retry, download it, or close the viewer.')
    }, IOS_NATIVE_VIDEO_LOAD_TIMEOUT_MS)
    return () => clearTimeout(timeout)
  }, [problem, ready, sourceURI])

  return <View testID="artifact-ios-system-video" style={styles.root}>
    <NativeVideo
      ref={playerRef}
      sourceURI={sourceURI}
      // Android opens the video paused on its first frame.
      autoplay={false}
      contentFit={videoFit}
      onStatus={handleStatus}
      // Android's player shows nothing of its own chrome until it is ready.
      style={[StyleSheet.absoluteFill, !ready && styles.hidden]}
    />
    {!ready && !problem ? <VideoLoadingStatus /> : null}
    {problem ? <VideoLoadProblem message={problem} onRetry={retry} onDownload={onDownload} onClose={close} /> : null}
    {ready ? <VideoZoomControls fit={videoFit} onChange={setVideoFit} /> : null}
  </View>
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: '#050506' },
  hidden: { opacity: 0 },
})
