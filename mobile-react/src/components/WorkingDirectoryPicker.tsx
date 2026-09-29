// Working-directory chip above the composer and its folder picker. Port of the
// desktop WorkingDirectoryPopover: tapping a folder opens it, the open folder is
// the selection, and "Choose" saves it as the chat's cwd.
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ArrowUp, ChevronRight, Folder, FolderOpen, RotateCcw } from 'lucide-react-native'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { fonts } from '../lib/typography'
import { parentDirectory } from '../lib/working-directory-path'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { WorkingDirectoryCompletion } from '../types'
import { Text, TextInput } from './AppText'
import { IconButton, SheetCloseButton } from './ui'

const TYPED_PATH_LOOKUP_DELAY_MS = 120

function folderLabel(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return 'Default folder'
  const segments = trimmed.replace(/\/+$/, '').split('/')
  return segments[segments.length - 1] || trimmed
}

export function WorkingDirectoryPicker({ sessionId, chipVisible, open, onOpenChange }: { sessionId: string; chipVisible: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const colors = usePalette()
  const cwd = useAppStore(state => state.sessions.find(value => value.id === sessionId)?.cwd?.trim() ?? '')
  const completionAvailable = useAppStore(state => state.health?.capabilities?.working_directory_completion?.available === true)
  const defaultCwd = useAppStore(state => state.health?.default_cwd?.trim() || '')
  const updateSession = useAppStore(state => state.updateSession)
  const [pathDraft, setPathDraft] = useState('')
  const [completion, setCompletion] = useState<WorkingDirectoryCompletion | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const requestRef = useRef(0)
  const typedPathLookupRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelTypedPathLookup = () => {
    if (typedPathLookupRef.current == null) return
    clearTimeout(typedPathLookupRef.current)
    typedPathLookupRef.current = null
  }

  const load = async (target: string, canonicalizeDraft = true): Promise<WorkingDirectoryCompletion | null> => {
    const path = target.trim()
    if (!completionAvailable) return null
    cancelTypedPathLookup()
    const request = ++requestRef.current
    const generation = useAppStore.getState().profileGeneration
    if (canonicalizeDraft) setPathDraft(path)
    setLoading(true)
    setError(null)
    try {
      const result = await client.completeWorkingDirectory(path, 50)
      // A newer lookup or a server switch makes this answer stale.
      if (request !== requestRef.current || generation !== useAppStore.getState().profileGeneration) return null
      setCompletion(result)
      if (canonicalizeDraft) setPathDraft(result.exists ? result.resolved_path || path : path)
      return result
    } catch (reason) {
      if (request !== requestRef.current) return null
      setError(reason instanceof Error ? reason.message : String(reason))
      return null
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) {
      cancelTypedPathLookup()
      requestRef.current += 1
      return
    }
    setCompletion(null)
    void load(cwd || defaultCwd)
    // Load once per opening, from the cwd the chat had when the sheet opened.
  }, [open])

  useEffect(() => () => cancelTypedPathLookup(), [])

  const currentPath = completion?.resolved_path || completion?.base_path || ''
  const parentPath = parentDirectory(currentPath)
  const canGoToParent = Boolean(currentPath && parentPath && parentPath !== currentPath)
  const folders = completion?.suggestions ?? []
  const chooseDisabled = !currentPath || loading || saving || !completion?.exists

  const close = () => {
    onOpenChange(false)
    requestAnimationFrame(dismissAppKeyboard)
  }

  const choose = async (targetPath = currentPath) => {
    const target = targetPath.trim()
    if (!target || saving) return
    setSaving(true)
    try {
      // updateSession reports failures to the app error banner, which this
      // full-screen sheet covers on Android, so repeat the message here.
      if (await updateSession(sessionId, { cwd: target }, useAppStore.getState().profileGeneration)) close()
      else setError(useAppStore.getState().error ?? 'The working directory could not be changed.')
    } finally {
      setSaving(false)
    }
  }

  const chooseTypedPath = async () => {
    const draft = pathDraft.trim()
    if (!draft || saving) return
    cancelTypedPathLookup()
    const detected = !loading && completion?.exists && completion.input.trim() === draft
      ? completion
      : await load(draft)
    if (!detected?.exists) return
    await choose(detected.resolved_path || detected.base_path || draft)
  }

  const chipLabel = cwd ? `Working directory: ${cwd}` : 'Set the working directory for this chat'

  return <>
    {chipVisible ? <Pressable
      testID="composer-working-directory"
      accessibilityRole="button"
      accessibilityLabel={chipLabel}
      onPress={() => { dismissAppKeyboard(); onOpenChange(true) }}
      style={({ pressed }) => [styles.chip, { backgroundColor: colors.raised, opacity: pressed ? 0.7 : 1 }]}
    >
      <FolderOpen size={13} color={colors.muted} />
      <Text style={[styles.chipText, { color: colors.muted }]} numberOfLines={1}>{folderLabel(cwd)}</Text>
    </Pressable> : null}
    <Modal visible={open} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} allowSwipeDismissal onRequestClose={close}>
      <SafeAreaView style={[styles.root, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
        <View style={[styles.header, { borderColor: colors.border }]}>
          <View style={styles.headerText}>
            <Text style={[styles.title, { color: colors.text }]}>Working directory</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>Choose the folder this chat uses for files, tools, and Changes.</Text>
          </View>
          <SheetCloseButton onPress={close} label="Close working directory" testID="working-directory-close" />
        </View>
        {!completionAvailable
          ? <Text style={[styles.status, { color: colors.muted }]}>Folder browsing needs a newer AgentsServer.</Text>
          : <>
            <View style={styles.pathRow}>
              <IconButton icon={ArrowUp} disabled={loading || !canGoToParent} onPress={() => void load(parentPath)} label="Go to parent folder" testID="working-directory-parent" />
              <TextInput
                testID="working-directory-path"
                accessibilityLabel="Folder path"
                value={pathDraft}
                onChangeText={nextPath => {
                  cancelTypedPathLookup()
                  requestRef.current += 1
                  setPathDraft(nextPath)
                  setCompletion(null)
                  setError(null)
                  setLoading(false)
                  if (nextPath.trim()) {
                    typedPathLookupRef.current = setTimeout(() => void load(nextPath, false), TYPED_PATH_LOOKUP_DELAY_MS)
                  }
                }}
                onSubmitEditing={() => void chooseTypedPath()}
                placeholder={defaultCwd || 'Enter a folder path'}
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                returnKeyType="done"
                style={[styles.pathInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
              />
            </View>
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
              {loading ? <View style={styles.statusRow}><ActivityIndicator color={colors.blue} /><Text style={{ color: colors.muted }}>Loading folders…</Text></View> : null}
              {!loading && error ? <View accessibilityRole="alert" style={styles.statusRow}>
                <Text style={[styles.errorText, { color: colors.red }]}>{error}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="Retry" onPress={() => void load(pathDraft)} style={[styles.retry, { backgroundColor: colors.raised }]}>
                  <RotateCcw size={14} color={colors.blue} /><Text style={{ color: colors.blue, fontWeight: '700' }}>Retry</Text>
                </Pressable>
              </View> : null}
              {!loading && !error ? folders.map(folder => <Pressable
                key={folder.path}
                accessibilityRole="button"
                accessibilityLabel={`Open ${folder.name}`}
                onPress={() => void load(folder.path)}
                style={({ pressed }) => [styles.folderRow, { backgroundColor: pressed ? colors.raised : 'transparent' }]}
              >
                <Folder size={17} color={colors.blue} />
                <Text style={[styles.folderName, { color: colors.text }]} numberOfLines={1}>{folder.name}</Text>
                <ChevronRight size={16} color={colors.muted} />
              </Pressable>) : null}
              {!loading && !error && completion && folders.length === 0 ? <Text style={[styles.status, { color: colors.muted }]}>No folders inside this directory.</Text> : null}
            </ScrollView>
            <View style={[styles.footer, { borderColor: colors.border }]}>
              <Text style={[styles.target, { color: colors.text }]} numberOfLines={1}>{folderLabel(currentPath)}</Text>
              <Pressable
                testID="working-directory-choose"
                accessibilityRole="button"
                accessibilityState={{ disabled: chooseDisabled }}
                disabled={chooseDisabled}
                onPress={() => void choose()}
                style={[styles.choose, { backgroundColor: colors.blue, opacity: chooseDisabled ? 0.4 : 1 }]}
              ><Text style={[styles.chooseText, { color: colors.textOnAccent }]}>{saving ? 'Saving…' : 'Choose'}</Text></Pressable>
            </View>
          </>}
      </SafeAreaView>
    </Modal>
  </>
}

const styles = StyleSheet.create({
  chip: { alignSelf: 'flex-start', maxWidth: '100%', minHeight: 30, borderRadius: 7, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 5 },
  chipText: { flexShrink: 1, fontSize: 12, fontWeight: '600' },
  root: { flex: 1 },
  header: { minHeight: 64, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerText: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, fontWeight: '800' },
  subtitle: { fontSize: 11, marginTop: 3 },
  pathRow: { paddingHorizontal: 10, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  pathInput: { flex: 1, minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, fontFamily: fonts.mono, fontSize: 13 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 8, paddingBottom: 12 },
  statusRow: { padding: 12, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  status: { padding: 14, fontSize: 13 },
  errorText: { flexShrink: 1, fontSize: 13 },
  retry: { minHeight: 36, borderRadius: 7, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 5 },
  folderRow: { minHeight: 48, borderRadius: 7, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
  folderName: { flex: 1, minWidth: 0, fontSize: 14 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12 },
  target: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: '700' },
  choose: { minHeight: 44, minWidth: 96, borderRadius: 8, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  chooseText: { fontSize: 14, fontWeight: '800' },
})
