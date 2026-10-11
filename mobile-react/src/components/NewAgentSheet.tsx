import { useEffect, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { usePalette } from '../theme'
import { backendLabel } from '../lib/format'
import { runtimeCatalogOptions, runtimeEffortAfterModelChange, runtimeEffortOptions } from '../lib/runtime-catalog'
import type { Backend, CrossServerChats, NewAgentSettings, RuntimeCatalog } from '../types'
import { Text, TextInput } from './AppText'
import { SheetCloseButton } from './ui'
import { OptionRow } from './ComposerRuntimeSheet'

/** The servers "Create new agent" may put the chat on, as the hub listed them for the picker. */
export interface NewAgentHosts {
  /** The other servers the hub creates chats on; empty when it cannot. */
  servers: CrossServerChats[]
  /** Registry name of this server under its hub; '' for the hub itself. */
  localTag: string
}

/**
 * Where, on which agent and with which runtime "Create new agent" makes its chat on send;
 * the current chat's values are the defaults. Page-sheet port of the desktop dialog.
 */
export function NewAgentSheet({ hosts, backends, backend, model, effort, folder, runtime, onCancel, onConfirm, onDidDismiss }: {
  hosts: NewAgentHosts | null
  /** Backends the chat may run on: this server's selectable ones that also receive handoffs. */
  backends: Backend[]
  backend: Backend
  model: string | null | undefined
  effort: string | null | undefined
  folder: string
  runtime: RuntimeCatalog | null
  onCancel: () => void
  onConfirm: (settings: NewAgentSettings, serverName: string) => void
  /** The composer restores its focus and caret here, as after the chat picker. */
  onDidDismiss: () => void
}) {
  const colors = usePalette()
  const open = hosts !== null
  const [backendDraft, setBackendDraft] = useState(backend)
  const [serverIdentity, setServerIdentity] = useState<string | null>(null)
  const [folderDraft, setFolderDraft] = useState(folder)
  const [modelDraft, setModelDraft] = useState(model ?? '')
  const [effortDraft, setEffortDraft] = useState(effort ?? '')
  // This chat's model and effort are defaults for its own backend only; another backend starts from its server defaults.
  const selectBackend = (value: Backend) => {
    setBackendDraft(value)
    setModelDraft(value === backend ? model ?? '' : '')
    setEffortDraft(value === backend ? effort ?? '' : '')
  }
  // Each opening starts from the current chat's values, the inherited defaults.
  // The candidate list is keyed by its contents: its identity follows every health poll.
  useEffect(() => {
    if (!open) return
    // A chat on a backend without handoffs (Cursor) defaults to the first backend that has them.
    selectBackend(backends.includes(backend) ? backend : (backends[0] ?? backend))
    setServerIdentity(null)
    setFolderDraft(folder)
  }, [open, backends.join(','), backend, folder, model, effort])
  const models = runtimeCatalogOptions(runtime, backendDraft, 'models', modelDraft || null)
  const efforts = backendDraft === 'cursor' ? [] : runtimeEffortOptions(runtime, backendDraft, modelDraft || null, effortDraft || null)
  const serverOptions = [
    { value: '', label: hosts?.localTag ? `This server · ${hosts.localTag}` : 'This server' },
    ...(hosts?.servers ?? []).map(server => ({ value: server.server_identity, label: server.name || 'Hub' })),
  ]
  const serverName = hosts?.servers.find(server => server.server_identity === serverIdentity)?.name ?? ''
  return <Modal visible={open} animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose={onCancel} onDismiss={onDidDismiss}>
    {hosts ? <SafeAreaView testID="new-agent-sheet" style={[styles.sheet, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.text }]}>New agent</Text>
        <SheetCloseButton testID="new-agent-sheet-close" label="Close new agent" onPress={onCancel} />
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.description, { color: colors.muted }]}>Sending creates a {backendLabel(backendDraft)} chat for this task and hands it the message. On this server it shares this chat's working directory; on another server it starts in that server's default directory.</Text>
        <Text style={[styles.section, styles.sectionGap, { color: colors.muted }]}>Agent</Text>
        {backends.map(option => <OptionRow key={option} testID={`new-agent-backend-${option}`} option={{ value: option, label: backendLabel(option) }} selected={option === backendDraft} onPress={() => selectBackend(option)} />)}
        {hosts.servers.length ? <>
          <Text style={[styles.section, styles.sectionGap, { color: colors.muted }]}>Server</Text>
          {serverOptions.map(option => <OptionRow key={option.value || 'local'} testID={`new-agent-server-${option.value || 'local'}`} option={option} selected={(serverIdentity ?? '') === option.value} onPress={() => setServerIdentity(option.value || null)} />)}
        </> : null}
        <Text style={[styles.section, styles.sectionGap, { color: colors.muted }]}>Folder</Text>
        <TextInput
          testID="new-agent-folder"
          accessibilityLabel="Folder"
          value={folderDraft}
          onChangeText={setFolderDraft}
          placeholder="General"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
        />
        <Text style={[styles.section, styles.sectionGap, { color: colors.muted }]}>Model</Text>
        {models.map(option => <OptionRow key={option.value || 'default'} testID={`new-agent-model-${option.value || 'default'}`} option={option} selected={option.value === modelDraft} onPress={() => {
          setModelDraft(option.value)
          setEffortDraft(runtimeEffortAfterModelChange(runtime, backendDraft, option.value || null, effortDraft || null) ?? '')
        }} />)}
        {efforts.some(option => Boolean(option.value)) ? <>
          <Text style={[styles.section, styles.sectionGap, { color: colors.muted }]}>Reasoning</Text>
          {efforts.map(option => <OptionRow key={option.value || 'default'} testID={`new-agent-effort-${option.value || 'default'}`} option={option} selected={option.value === effortDraft} onPress={() => setEffortDraft(option.value)} />)}
        </> : null}
        <Pressable
          testID="new-agent-confirm"
          accessibilityRole="button"
          accessibilityLabel="Add @New agent"
          onPress={() => onConfirm({ backend: backendDraft, model: modelDraft || null, effort: effortDraft || null, server_identity: serverIdentity, folder: folderDraft.trim() || 'General' }, serverName)}
          style={({ pressed }) => [styles.confirm, { backgroundColor: colors.blue, opacity: pressed ? 0.7 : 1 }]}
        >
          <Text style={styles.confirmText}>Add @New agent</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView> : null}
  </Modal>
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  header: { minHeight: 64, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, minWidth: 0, fontSize: 17, fontWeight: '800' },
  content: { padding: 14, paddingBottom: 40, width: '100%', maxWidth: 700, alignSelf: 'center' },
  description: { fontSize: 13, lineHeight: 18 },
  section: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4, paddingBottom: 6 },
  sectionGap: { marginTop: 18 },
  input: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, fontSize: 15 },
  confirm: { marginTop: 24, minHeight: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  confirmText: { color: 'white', fontSize: 15, fontWeight: '700' },
})
