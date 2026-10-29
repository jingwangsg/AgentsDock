import * as FileSystem from 'expo-file-system/legacy'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AppState as NativeAppState,
  Platform,
  StyleSheet,
  View,
} from 'react-native'
import type { AgentServerClient } from '../../api/AgentServerClient'
import {
  artifactVideoStageCacheKey,
  artifactVideoStageProgress,
  completedArtifactVideoDownload,
  IOS_VIDEO_STAGE_PLAYER_DELAY_MS,
  IOS_VIDEO_STAGE_STALL_MS,
  reusableArtifactVideoCache,
} from '../../lib/artifact-video-staging'
import { FileReadStatusError, isTunnelFailure, readFileWithRetry } from '../../lib/file-read-retry'
import type { MobileFileViewerLayout } from '../../lib/file-viewer'
import type { AgentFile } from '../../types'
import { ArtifactIOSSystemVideoPlayer } from './ArtifactIOSSystemVideoPlayer'
import { ArtifactPlatformVideoPlayer, type ArtifactPlatformVideoSource } from './ArtifactPlatformVideoPlayer'
import { VideoLoadingStatus, VideoLoadProblem } from './VideoStatusViews'

interface ArtifactVideoConnection {
  readonly client: AgentServerClient
  readonly cacheNamespace: string
  readonly key: string
  readonly sessionId: string
}

type VideoStageTask = ReturnType<typeof FileSystem.createDownloadResumable>

const VIDEO_STAGE_STORAGE_RESERVE_BYTES = 64 * 1024 * 1024

export function ArtifactVideoPlayer({ file, layout, connection, registerPause, onDownload, onClose }: {
  file: AgentFile
  layout: MobileFileViewerLayout
  connection: ArtifactVideoConnection
  registerPause: (pause: () => void) => () => void
  onDownload: () => void
  onClose: () => void
}) {
  const remoteSource = useMemo<ArtifactPlatformVideoSource>(() => ({
    uri: connection.client.fileURL(connection.sessionId, file.id),
    headers: connection.client.authHeaders(),
    contentType: 'progressive',
  }), [connection, file.id])

  if (Platform.OS !== 'ios') {
    return <ArtifactPlatformVideoPlayer
      source={remoteSource}
      layout={layout}
      registerPause={registerPause}
      onDownload={onDownload}
      onClose={onClose}
    />
  }

  return <StagedIOSArtifactVideo
    file={file}
    connection={connection}
    remoteSource={remoteSource}
    registerPause={registerPause}
    onDownload={onDownload}
    onClose={onClose}
  />
}

function StagedIOSArtifactVideo({ file, connection, remoteSource, registerPause, onDownload, onClose }: {
  file: AgentFile
  connection: ArtifactVideoConnection
  remoteSource: ArtifactPlatformVideoSource
  registerPause: (pause: () => void) => () => void
  onDownload: () => void
  onClose: () => void
}) {
  const [appActive, setAppActive] = useState(NativeAppState.currentState === 'active')
  const [stageAttempt, setStageAttempt] = useState(0)
  const [localURI, setLocalURI] = useState<string | null>(null)
  const [mountPlayer, setMountPlayer] = useState(false)
  const [stageProblem, setStageProblem] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const taskRef = useRef<VideoStageTask | null>(null)
  const generationRef = useRef(0)
  const expectedBytes = Number.isSafeInteger(file.size) && (file.size ?? 0) > 0 ? Number(file.size) : null
  const cacheDestination = useMemo(() => {
    if (!FileSystem.cacheDirectory) return null
    const identity = `${connection.cacheNamespace}\u0000${connection.sessionId}\u0000${file.id}`
    return `${FileSystem.cacheDirectory}artifact-video-${artifactVideoStageCacheKey(identity)}-${safeVideoCacheName(file.filename, file.content_type)}`
  }, [connection.cacheNamespace, connection.sessionId, file.content_type, file.filename, file.id])
  const cancelStaging = useCallback(() => {
    const task = taskRef.current
    taskRef.current = null
    if (task) void task.cancelAsync().catch(() => undefined)
  }, [])
  const close = useCallback(() => {
    generationRef.current += 1
    cancelStaging()
    onClose()
  }, [cancelStaging, onClose])
  const restage = useCallback(() => {
    generationRef.current += 1
    cancelStaging()
    setMountPlayer(false)
    setLocalURI(null)
    setStageProblem(null)
    setProgress(null)
    setStageAttempt(value => value + 1)
  }, [cancelStaging])

  useEffect(() => {
    const subscription = NativeAppState.addEventListener('change', state => {
      const active = state === 'active'
      setAppActive(active)
      if (!active) cancelStaging()
    })
    return () => subscription.remove()
  }, [cancelStaging])

  useEffect(() => {
    if (!appActive) return
    const generation = generationRef.current + 1
    generationRef.current = generation
    let active = true
    let stalled = false
    let stallTimer: ReturnType<typeof setInterval> | null = null
    let lastProgressAt = Date.now()
    let lastPublishedAt = 0
    let lastPublishedProgress = -1

    setLocalURI(null)
    setMountPlayer(false)
    setStageProblem(null)
    setProgress(null)

    const stillCurrent = () => active
      && generationRef.current === generation
      && !connection.client.isDisposed
      && connection.client.isValidated

    void (async () => {
      if (!cacheDestination) throw new Error('The device cache is unavailable.')
      const existing = await FileSystem.getInfoAsync(cacheDestination)
      if (!stillCurrent()) return
      if (stageAttempt === 0 && reusableArtifactVideoCache(existing, expectedBytes)) {
        setProgress(1)
        setLocalURI(existing.uri)
        return
      }
      if (existing.exists) await FileSystem.deleteAsync(cacheDestination, { idempotent: true }).catch(() => undefined)
      if (!stillCurrent()) return

      if (expectedBytes != null) {
        const freeBytes = await FileSystem.getFreeDiskStorageAsync().catch(() => null)
        if (!stillCurrent()) return
        if (freeBytes != null && expectedBytes + VIDEO_STAGE_STORAGE_RESERVE_BYTES > freeBytes) {
          throw new Error('There is not enough free storage to prepare this video safely.')
        }
      }

      // Each retry starts a new task that downloads the whole video again.
      const result = await readFileWithRetry(async () => {
        if (!stillCurrent()) return undefined
        const task = FileSystem.createDownloadResumable(
          remoteSource.uri,
          cacheDestination,
          { headers: remoteSource.headers },
          value => {
            if (!stillCurrent()) return
            lastProgressAt = Date.now()
            const next = artifactVideoStageProgress(
              value.totalBytesWritten,
              value.totalBytesExpectedToWrite,
              expectedBytes,
            )
            if (next == null) return
            const now = Date.now()
            if (next >= 1 || now - lastPublishedAt >= 150 || next - lastPublishedProgress >= 0.02) {
              lastPublishedAt = now
              lastPublishedProgress = next
              setProgress(next)
            }
          },
        )
        taskRef.current = task
        // The wait before a retry must not count as a stall.
        lastProgressAt = Date.now()
        stallTimer = setInterval(() => {
          if (!stillCurrent() || Date.now() - lastProgressAt < IOS_VIDEO_STAGE_STALL_MS) return
          stalled = true
          if (taskRef.current === task) taskRef.current = null
          void task.cancelAsync().catch(() => undefined)
          setStageProblem('The video download stopped responding. Retry, download it, or close the viewer.')
        }, 1_000)
        const result = await task.downloadAsync().finally(() => {
          if (taskRef.current === task) taskRef.current = null
          if (stallTimer) clearInterval(stallTimer)
          stallTimer = null
        })
        // Stale, stalled or cancelled: no retry; the checks after the loop handle it.
        if (!stillCurrent() || stalled || !result) return result
        if (result.status < 200 || result.status >= 300) {
          const retryable = await isTunnelFailure(result.status, () => FileSystem.readAsStringAsync(result.uri))
          await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined)
          throw new FileReadStatusError(`Video download failed with HTTP ${result.status}.`, retryable)
        }
        return result
      }, { onRetry: () => setProgress(null) })
      if (!stillCurrent() || stalled) return
      if (!result) throw new Error('The video download was cancelled.')
      const downloaded = await FileSystem.getInfoAsync(result.uri)
      if (!stillCurrent()) return
      if (!completedArtifactVideoDownload(downloaded, expectedBytes)) {
        await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined)
        throw new Error('The downloaded video did not match the server metadata.')
      }
      setProgress(1)
      setLocalURI(downloaded.uri)
    })().catch(cause => {
      if (!stillCurrent() || stalled) return
      const detail = cause instanceof Error ? cause.message.trim() : ''
      setStageProblem(detail || 'The video could not be prepared.')
    })

    return () => {
      active = false
      if (stallTimer) clearInterval(stallTimer)
      const task = taskRef.current
      taskRef.current = null
      if (task) void task.cancelAsync().catch(() => undefined)
    }
  }, [appActive, cacheDestination, connection.client, expectedBytes, remoteSource.headers, remoteSource.uri, stageAttempt])

  useEffect(() => {
    setMountPlayer(false)
    if (!localURI || !appActive) return
    const timer = setTimeout(() => setMountPlayer(true), IOS_VIDEO_STAGE_PLAYER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [appActive, localURI])

  if (localURI && mountPlayer) {
    return <ArtifactIOSSystemVideoPlayer
      key={`${connection.key}:${file.id}:${stageAttempt}`}
      sourceURI={localURI}
      registerPause={registerPause}
      onDownload={onDownload}
      onClose={close}
      onRetrySource={restage}
    />
  }

  // Android's loading and error views. While the whole file downloads before playing, the
  // loading view also shows the download percent; once the file is here, the player is opening.
  const downloadPercent = localURI || progress == null ? null : Math.round(progress * 100)
  return <View testID="artifact-video-staging" style={styles.stage}>
    {stageProblem
      ? <VideoLoadProblem message={stageProblem} onRetry={restage} onDownload={onDownload} onClose={close} />
      : <VideoLoadingStatus percent={downloadPercent} />}
  </View>
}

function safeVideoCacheName(value: string, contentType: string | null | undefined): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-72) || 'video'
  if (/\.[a-zA-Z0-9]{1,8}$/.test(safe)) return safe
  const mime = contentType?.split(';', 1)[0].trim().toLocaleLowerCase()
  const extension = mime === 'video/quicktime' ? 'mov' : mime === 'video/webm' ? 'webm' : mime === 'video/x-m4v' ? 'm4v' : 'mp4'
  return `${safe}.${extension}`
}

const styles = StyleSheet.create({
  stage: { flex: 1, minHeight: 0, backgroundColor: '#050506' },
})
