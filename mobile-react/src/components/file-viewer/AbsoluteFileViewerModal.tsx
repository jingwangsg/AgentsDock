import { useCallback, useEffect, useState, type ReactNode } from 'react'
import * as Clipboard from 'expo-clipboard'
import * as FileSystem from 'expo-file-system/legacy'
import { ActivityIndicator, Modal, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import { Download, Link, RefreshCw, Share2 } from 'lucide-react-native'
import { fileViewerCacheKey, inferredMobileFileContentType, mobileFileViewerKind, mobileFileViewerLayout, workspacePreviewAllowed } from '../../lib/file-viewer'
import { absoluteFileTransferRequest, type FileTransferAction } from '../../lib/file-transfer'
import { dismissAppKeyboard } from '../../lib/app-keyboard'
import { formatBytes } from '../../lib/format'
import { fullscreenModalPadding, type FullscreenSafeAreaInsets } from '../../lib/fullscreen-modal-layout'
import { capturedConnectionIsCurrent, client, useAppStore } from '../../store/useAppStore'
import { usePalette } from '../../theme'
import type { WorkspaceFile, WorkspaceInfo } from '../../types'
import { Text } from '../AppText'
import { EmptyState, IconButton, SheetCloseButton } from '../ui'
import { FilePreview, type LoadedFileText } from './FilePreview'
import type { AbsoluteFileViewerRequest } from './FileViewerContext'
import { useFileTransfer } from './useFileTransfer'
import { FileTransferNotice } from './FileTransferNotice'

/** The workspace capability from which the server reads explicit absolute paths; the desktop gates on the same value. */
const ABSOLUTE_READS_CAPABILITY_VERSION = 5

/** One file named by a chat link outside the chat's working directory: read-only text, image and PDF previews, download and share. */
export function AbsoluteFileViewerModal({ request, modalInsets, onClose }: { request: AbsoluteFileViewerRequest; modalInsets: FullscreenSafeAreaInsets; onClose: () => void }) {
  const colors = usePalette()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const selectedSessionId = useAppStore(state => state.selectedSessionId)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const connection = client
  const { width, height } = useWindowDimensions()
  const layout = mobileFileViewerLayout(width, height)
  const modalPadding = fullscreenModalPadding(modalInsets, Platform.OS)
  const sessionCurrent = selectedSessionId === request.sessionId
  const connectionAvailable = connected && !connecting && !switchingProfileId && connection.isValidated
  const isCurrent = useCallback(() => (
    capturedConnectionIsCurrent(connection, activeProfileId, profileGeneration)
      && useAppStore.getState().selectedSessionId === request.sessionId
  ), [activeProfileId, connection, profileGeneration, request.sessionId])
  const name = request.path.split('/').at(-1) || request.path
  const contentType = inferredMobileFileContentType(name)
  const kind = mobileFileViewerKind(name, contentType)
  const [info, setInfo] = useState<WorkspaceInfo | null>(null)
  const [infoError, setInfoError] = useState('')
  const [infoRevision, setInfoRevision] = useState(0)
  const [error, setError] = useState('')
  const fileTransfer = useFileTransfer(`${activeProfileId ?? 'none'}:${profileGeneration}:${request.sessionId}:${request.path}`)

  // The workspace info says which capability the server has, which media it previews, and whether it streams absolute files.
  useEffect(() => {
    if (!connectionAvailable || info) return
    let current = true
    setInfoError('')
    void connection.workspaceInfo(request.sessionId).then(value => {
      if (current && isCurrent()) setInfo(value)
    }).catch(cause => {
      if (current && isCurrent()) setInfoError(viewerError(cause))
    })
    return () => { current = false }
  }, [connection, connectionAvailable, info, infoRevision, isCurrent, request.sessionId])

  const readsAvailable = Boolean(info && info.capability_version >= ABSOLUTE_READS_CAPABILITY_VERSION)
  const transfersAvailable = Boolean(info?.absolute_file_transfers)
  const previewURL = info && transfersAvailable && workspacePreviewAllowed(info, { name })
    ? connection.workspaceAbsolutePreviewURL(request.sessionId, request.path)
    : undefined
  const loadText = useCallback(async (limit: number): Promise<LoadedFileText> => {
    const file = await connection.workspaceAbsoluteFile(request.sessionId, request.path)
    if (!isCurrent()) throw new Error('The active server or chat changed while opening this file.')
    return validatedAbsoluteText(file, request.path, limit)
  }, [connection, isCurrent, request.path, request.sessionId])
  const loadLocalPDF = useCallback(async (): Promise<string> => {
    const destination = `${FileSystem.cacheDirectory}absolute-preview-${fileViewerCacheKey(connection.workspaceAbsoluteDownloadURL(request.sessionId, request.path))}.pdf`
    await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined)
    const result = await FileSystem.downloadAsync(
      connection.workspaceAbsolutePreviewURL(request.sessionId, request.path),
      destination,
      { headers: connection.authHeaders() },
    )
    if (result.status < 200 || result.status >= 300) {
      await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined)
      throw new Error(`Preview request failed with HTTP ${result.status}.`)
    }
    if (!isCurrent()) throw new Error('The active server or chat changed while opening this PDF.')
    return result.uri
  }, [connection, isCurrent, request.path, request.sessionId])
  const transfer = useCallback((action: FileTransferAction) => {
    dismissAppKeyboard()
    if (!transfersAvailable) {
      setError('Update AgentsServer to download or share files outside the working directory.')
      return
    }
    void fileTransfer.start(absoluteFileTransferRequest(request.path, request.sessionId, connection, action, isCurrent))
  }, [connection, fileTransfer.start, isCurrent, request.path, request.sessionId, transfersAvailable])
  const copyPath = useCallback(() => {
    dismissAppKeyboard()
    void Clipboard.setStringAsync(request.path)
  }, [request.path])

  let body: ReactNode
  if (!sessionCurrent) body = <EmptyState title="Chat changed" body="Close this viewer and open the link from the active chat." />
  else if (!info && !connectionAvailable) body = <EmptyState title="Server unavailable" body="Reconnect this server to open the file." />
  else if (infoError) {
    body = <View accessibilityRole="alert" style={styles.centered}>
      <Text style={[styles.problemTitle, { color: colors.text }]}>Could not check file access</Text>
      <Text style={[styles.problemBody, { color: colors.muted }]}>{infoError}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Retry file access" onPress={() => { setInfoError(''); setInfoRevision(value => value + 1) }} style={[styles.retry, { backgroundColor: colors.raised }]}><RefreshCw size={16} color={colors.blue} /><Text style={{ color: colors.blue, fontWeight: '700' }}>Retry</Text></Pressable>
    </View>
  } else if (!info) body = <View style={styles.centered}><ActivityIndicator color={colors.blue} /><Text style={{ color: colors.muted }}>Checking file access…</Text></View>
  else if (!readsAvailable) body = <EmptyState title="Update AgentsServer" body="This server cannot open files outside the chat’s working directory." />
  else {
    body = <FilePreview
      key={`${request.path}:${infoRevision}`}
      name={name}
      path={request.path}
      contentType={contentType}
      layout={layout}
      previewURL={previewURL}
      headers={connection.authHeaders()}
      loadText={loadText}
      loadLocalPreview={kind === 'pdf' && transfersAvailable ? loadLocalPDF : undefined}
      onDownload={() => transfer('download')}
    />
  }

  return <Modal visible animationType="slide" presentationStyle="fullScreen" statusBarTranslucent={Platform.OS === 'android'} onRequestClose={onClose}>
    <View onAccessibilityEscape={onClose} style={[styles.root, { backgroundColor: colors.background }, modalPadding]}>
      <View collapsable={false} pointerEvents="auto" style={[styles.header, { borderColor: colors.border, backgroundColor: colors.background }]}>
        <SheetCloseButton onPress={onClose} label="Close file" testID="absolute-file-viewer-close" activateOnPressIn />
        <View style={styles.headerIdentity}>
          <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>{name}</Text>
          <Text style={[styles.headerSubtitle, { color: colors.muted }]} numberOfLines={1}>{request.path}</Text>
        </View>
        <IconButton icon={Link} onPress={copyPath} label="Copy file path" testID="absolute-file-viewer-copy" activateOnPressIn />
        <IconButton icon={Download} disabled={!info || fileTransfer.busy} onPress={() => transfer('download')} label="Download file" testID="absolute-file-viewer-download" activateOnPressIn />
        <IconButton icon={Share2} disabled={!info || fileTransfer.busy} onPress={() => transfer('share')} label="Share file" testID="absolute-file-viewer-share" activateOnPressIn />
      </View>
      <FileTransferNotice state={fileTransfer.state} onCancel={fileTransfer.cancel} onDismiss={fileTransfer.dismiss} />
      {error ? <View accessibilityRole="alert" style={[styles.inlineError, { backgroundColor: `${colors.red}12` }]}><Text style={{ color: colors.red, fontSize: 11 }}>{error}</Text></View> : null}
      <View testID="absolute-file-viewer-preview" style={styles.preview}>{body}</View>
    </View>
  </Modal>
}

function validatedAbsoluteText(file: WorkspaceFile, expectedPath: string, limit: number): LoadedFileText {
  // The server echoes the requested path, with a leading `~/` expanded to the account's home.
  const samePath = expectedPath.startsWith('~/') ? file.path.endsWith(expectedPath.slice(1)) : file.path === expectedPath
  if (!samePath) throw new Error('The server returned a different file.')
  if (!/^[a-f0-9]{64}$/i.test(file.revision)) throw new Error('The server returned an invalid file revision.')
  const contentBytes = new TextEncoder().encode(file.content).byteLength
  if (!Number.isFinite(file.size) || file.size < 0 || file.size !== contentBytes || contentBytes > limit) throw new Error(`This file exceeds the ${formatBytes(limit)} mobile preview limit.`)
  // A chat link opens the file to read it; editing stays in the workspace browser.
  return { content: file.content, revision: file.revision, writable: false, size: file.size, mtime_ns: file.mtime_ns }
}

function viewerError(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).replace(/^Error:\s*/i, '').trim() || 'The file request failed.'
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { minHeight: 64, flexShrink: 0, position: 'relative', zIndex: 20, elevation: 20, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerIdentity: { flex: 1, minWidth: 0 },
  headerTitle: { fontSize: 15, fontWeight: '800' },
  headerSubtitle: { fontSize: 10, marginTop: 2 },
  inlineError: { marginHorizontal: 10, marginTop: 8, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  preview: { flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' },
  centered: { flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', gap: 9 },
  problemTitle: { fontSize: 16, lineHeight: 21, fontWeight: '800', textAlign: 'center' },
  problemBody: { maxWidth: 420, paddingHorizontal: 18, fontSize: 12, lineHeight: 17, textAlign: 'center' },
  retry: { minHeight: 44, borderRadius: 8, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
})
