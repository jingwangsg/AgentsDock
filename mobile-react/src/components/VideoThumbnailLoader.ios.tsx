import { generateAgentsDockVideoThumbnail } from 'agentsdock-native-video'
import { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import { ActivityIndicator } from './material/ActivityIndicator'
import type { AgentServerClient } from '../api/AgentServerClient'
import { usePalette } from '../theme'
import type { AgentFile } from '../types'

interface VideoThumbnailConnection {
  readonly client: AgentServerClient
  readonly sessionId: string
}

/**
 * iOS counterpart of the Android loader: same frame, size limit, timeout and
 * placeholder, but read with AVAssetImageGenerator so a timeline tile never
 * owns an AVPlayer.
 */
export function VideoThumbnailLoader({ file, connection, onThumbnail, onFailure }: {
  file: AgentFile
  connection: VideoThumbnailConnection
  onThumbnail: (value: { uri: string }) => void
  onFailure: () => void
}) {
  const colors = usePalette()

  useEffect(() => {
    let active = true
    const request = generateAgentsDockVideoThumbnail(
      connection.client.fileURL(connection.sessionId, file.id),
      connection.client.authHeaders(),
    )
    void request.result
      .then(uri => { if (active) onThumbnail({ uri }) })
      .catch(() => { if (active) onFailure() })
    return () => {
      active = false
      request.cancel()
    }
  }, [connection, file.id, onFailure, onThumbnail])
  useEffect(() => {
    const timeout = setTimeout(onFailure, 8_000)
    return () => clearTimeout(timeout)
  }, [onFailure])

  return <View style={[styles.loading, { backgroundColor: colors.surface }]}><ActivityIndicator color={colors.muted} /></View>
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
})
