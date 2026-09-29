import { useState } from 'react'
import { AlertTriangle, CircleCheck, CircleHelp, CircleX, RefreshCw } from 'lucide-react-native'
import { Pressable, StyleSheet, View } from 'react-native'
import type { Backend, Event, RuntimeDiagnostic } from '../types'
import { errorMessage } from '../lib/format'
import { runtimeDiagnosticFor, runtimeLabel, runtimeNeedsAttention } from '../lib/runtime'
import { cursorBackendAvailable, cursorBackendSupported, cursorBackendUnavailableReason } from '../lib/runtime-catalog'
import { isTimelineError } from '../lib/timeline'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { Text, TextInput } from './AppText'

export function RuntimeHealthNotice({ backend, sessionId }: { backend: Backend; sessionId: string }) {
  const health = useAppStore(state => state.health)
  const runtime = useAppStore(state => state.runtime)
  const events = useAppStore(state => state.snapshots[sessionId]?.events)
  const refresh = useAppStore(state => state.refreshRuntime)
  const diagnostic = runtimeDiagnosticFor(health, runtime, backend)
  const chatError = latestChatRunError(events, backend)
  // Claude authenticates only with the server's CLAUDE_CODE_OAUTH_TOKEN, so a missing token or an
  // auth failure in this chat both need a new token. Older servers omit the field and have no token
  // route; a missing or broken CLI needs installing, not a token.
  const tokenNeeded = backend === 'claude' && diagnostic?.oauth_token_configured !== undefined
    && (((diagnostic.status === 'unknown' || diagnostic.status === 'unauthenticated') && !diagnostic.oauth_token_configured)
      || /authentication_(?:failed|error)|failed to authenticate|not authenticated/i.test(chatError))
  const unavailable = backend === 'cursor' && !cursorBackendAvailable(health, runtime)
  const providerNeedsAttention = unavailable || Boolean(diagnostic && diagnostic.status !== 'ready')
  if (!chatError && !providerNeedsAttention && !tokenNeeded) return null
  return <>
    <RuntimeRow backend={backend} diagnostic={diagnostic} compact detailOverride={chatError || (unavailable ? cursorBackendUnavailableReason(health, runtime) : null)} onRecheck={() => void refresh()} />
    {tokenNeeded ? <ClaudeTokenForm onSaved={() => void refresh()} /> : null}
  </>
}

function CliUpdate({ backend }: { backend: 'claude' | 'codex' }) {
  const colors = usePalette()
  const available = useAppStore(state => Boolean(state.health?.capabilities?.runtime_cli_update_v1?.available))
  const [updating, setUpdating] = useState(false)
  const [result, setResult] = useState<{ text: string; failed: boolean } | null>(null)
  const update = async () => {
    setUpdating(true)
    setResult(null)
    try {
      const { output, diagnostic } = await client.updateRuntimeCli(backend)
      useAppStore.setState(state => ({ health: state.health && { ...state.health, runtimes: { ...state.health.runtimes, [backend]: diagnostic } } }))
      setResult({ text: output.split('\n').at(-1) || 'Update finished.', failed: false })
    } catch (cause) {
      setResult({ text: errorMessage(cause), failed: true })
    } finally {
      setUpdating(false)
    }
  }
  if (!available) return null
  return <View style={styles.update}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Update ${backend === 'claude' ? 'Claude Code' : 'Codex'} CLI`} disabled={updating} onPress={() => void update()} style={[styles.refresh, { backgroundColor: colors.raised, opacity: updating ? 0.45 : 1 }]}><RefreshCw size={12} color={colors.blue} /><Text style={{ color: colors.blue, fontSize: 10, fontWeight: '700' }}>{updating ? 'Updating…' : 'Update CLI'}</Text></Pressable>
    {result ? <Text style={[styles.detail, { color: result.failed ? colors.red : colors.muted }]}>{result.text}</Text> : null}
  </View>
}

function ClaudeTokenForm({ onSaved }: { onSaved: () => void }) {
  const colors = usePalette()
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await client.setClaudeToken(token.trim())
      setToken('')
      setSaved(true)
      onSaved()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }
  const disabled = saving || !token.trim()
  return <View testID="claude-token-form" style={[styles.row, styles.compact, styles.tokenForm, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    {saved
      ? <Text style={[styles.detail, { color: colors.green }]}>Token saved. New Claude messages on this server use it.</Text>
      : <>
          <Text style={[styles.detail, { color: colors.muted }]}>Claude on this server runs only with a long-lived token. Run `claude setup-token` on any machine and paste the token here.</Text>
          <View style={styles.tokenRow}>
            <TextInput testID="claude-token-input" accessibilityLabel="Claude token" value={token} onChangeText={setToken} editable={!saving} onSubmitEditing={() => { if (!disabled) void save() }} autoCapitalize="none" autoCorrect={false} autoComplete="off" importantForAutofill="no" secureTextEntry placeholder="sk-ant-oat01-…" placeholderTextColor={colors.muted} style={[styles.tokenInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.raised }]} />
            <Pressable accessibilityRole="button" accessibilityLabel="Save Claude token" disabled={disabled} onPress={() => void save()} style={[styles.refresh, { backgroundColor: colors.raised, opacity: disabled ? 0.45 : 1 }]}><Text style={{ color: colors.blue, fontSize: 10, fontWeight: '700' }}>{saving ? 'Saving…' : 'Save'}</Text></Pressable>
          </View>
          {error ? <Text style={[styles.detail, { color: colors.red }]}>{error}</Text> : null}
        </>}
  </View>
}

export function RuntimeHealthPanel() {
  const colors = usePalette()
  const health = useAppStore(state => state.health)
  const runtime = useAppStore(state => state.runtime)
  const connected = useAppStore(state => state.connected)
  const refresh = useAppStore(state => state.refreshRuntime)
  return <View style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.raised }]}>
    <View style={styles.header}>
      <View style={{ flex: 1 }}><Text style={[styles.heading, { color: colors.text }]}>Agent runtimes</Text><Text style={[styles.caption, { color: colors.muted }]}>Provider readiness is separate from server connectivity.</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel="Refresh runtime status" disabled={!connected} onPress={() => void refresh()} style={[styles.refresh, { backgroundColor: colors.surface, opacity: connected ? 1 : 0.45 }]}><RefreshCw size={14} color={colors.blue} /><Text style={{ color: colors.blue, fontSize: 11, fontWeight: '700' }}>Refresh</Text></Pressable>
    </View>
    <RuntimeRow backend="claude" diagnostic={runtimeDiagnosticFor(health, runtime, 'claude')} />
    <RuntimeRow backend="codex" diagnostic={runtimeDiagnosticFor(health, runtime, 'codex')} />
    {cursorBackendSupported(health) ? <RuntimeRow backend="cursor" diagnostic={runtimeDiagnosticFor(health, runtime, 'cursor')} /> : null}
  </View>
}

function RuntimeRow({ backend, diagnostic, compact = false, detailOverride, onRecheck }: { backend: Backend; diagnostic: RuntimeDiagnostic | null; compact?: boolean; detailOverride?: string | null; onRecheck?: () => void }) {
  const colors = usePalette()
  const tone = diagnostic?.status === 'ready' ? (diagnostic.last_error ? 'warning' : 'ready') : diagnostic?.status === 'unknown' || !diagnostic ? 'unknown' : 'error'
  const color = tone === 'ready' ? colors.green : tone === 'warning' ? colors.orange : tone === 'error' ? colors.red : colors.muted
  const Icon = tone === 'ready' ? CircleCheck : tone === 'warning' ? AlertTriangle : tone === 'error' ? CircleX : CircleHelp
  const provider = backend === 'claude' ? 'Claude Code' : backend === 'cursor' ? 'Cursor' : 'Codex'
  const detail = detailOverride || diagnostic?.last_error || diagnostic?.message || `${provider} has not been checked yet.`
  return <View accessibilityRole={tone === 'error' ? 'alert' : 'text'} style={[styles.row, compact && styles.compact, { borderColor: tone === 'error' || tone === 'warning' ? color : colors.border, backgroundColor: colors.surface }]}>
    <Icon size={compact ? 15 : 17} color={color} />
    <View style={{ flex: 1, minWidth: 0 }}><Text style={[styles.title, { color: colors.text }]}>{provider} <Text style={{ color }}>{runtimeLabel(diagnostic)}</Text></Text><Text style={[styles.detail, { color: colors.muted }]} numberOfLines={compact ? 2 : undefined}>{detail}</Text>{!compact && diagnostic?.action ? <Text style={[styles.action, { color: colors.text }]}>{diagnostic.action}</Text> : null}{!compact && (backend === 'claude' || backend === 'codex') && diagnostic?.installed ? <CliUpdate backend={backend} /> : null}</View>
    {compact && onRecheck ? <Pressable accessibilityRole="button" accessibilityLabel={`Recheck ${provider} CLI status`} onPress={onRecheck} style={[styles.refresh, { backgroundColor: colors.raised }]}><RefreshCw size={12} color={colors.blue} /><Text style={{ color: colors.blue, fontSize: 10, fontWeight: '700' }}>Recheck</Text></Pressable> : null}
    {!compact && diagnostic?.version ? <Text style={[styles.version, { color: colors.muted }]} numberOfLines={1}>{diagnostic.version}</Text> : null}
  </View>
}

function latestChatRunError(events: Event[] | undefined, backend: Backend): string {
  if (!events?.length) return ''
  let latestRunId = ''
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.backend && event.backend !== backend) continue
    if (event.run_id) { latestRunId = event.run_id; break }
    if (isTimelineError(event)) return compactEventError(event)
  }
  if (!latestRunId) return ''
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.run_id === latestRunId && (!event.backend || event.backend === backend) && isTimelineError(event)) return compactEventError(event)
  }
  return ''
}

function compactEventError(event: Event): string {
  const raw = typeof event.error === 'string' ? event.error : event.message || event.text || event.output || (event.error ? JSON.stringify(event.error) : 'The latest chat run failed.')
  return raw.length > 520 ? `${raw.slice(0, 520).trim()}…` : raw
}

const styles = StyleSheet.create({
  panel: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, padding: 9, gap: 6 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 }, heading: { fontSize: 12, fontWeight: '800' }, caption: { fontSize: 10, marginTop: 1 },
  refresh: { minHeight: 44, borderRadius: 5, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 5 },
  row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, padding: 8, flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
  compact: { marginHorizontal: 10, marginTop: 6, paddingVertical: 7 }, title: { fontSize: 11, fontWeight: '800' }, detail: { fontSize: 10, lineHeight: 14, marginTop: 2 }, action: { fontSize: 10, lineHeight: 14, marginTop: 3 }, version: { maxWidth: 100, fontSize: 9 },
  update: { alignItems: 'flex-start', gap: 4, marginTop: 6 },
  tokenForm: { flexDirection: 'column', alignItems: 'stretch', gap: 6 }, tokenRow: { flexDirection: 'row', alignItems: 'center', gap: 7 }, tokenInput: { flex: 1, minWidth: 0, minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 5, paddingHorizontal: 9, fontSize: 12 },
})
