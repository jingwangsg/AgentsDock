// One row per subagent of the turn on screen, in the Claude Code CLI's Task-row
// style; folds into a one-line count summary once the turn is over.
import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native'
import { Bot, Check, ChevronDown, ChevronRight, Square, X } from 'lucide-react-native'
import { formatDuration } from '../lib/run-activity'
import { isSubagentActive, subagentDisplayName, subagentLogText, subagentStatusLabel, type SubagentActivity, type SubagentStatus } from '../lib/subagents'
import { fonts } from '../lib/typography'
import { usePalette } from '../theme'
import { Text } from './AppText'

const SUMMARY_ORDER: SubagentStatus[] = ['running', 'completed', 'failed', 'stopped', 'killed', 'tracking_lost']
const LOG_PREVIEW_LINES = 20

export function SubagentRows({ agents, now, runLive }: { agents: SubagentActivity[]; now: number; runLive: boolean }) {
  const colors = usePalette()
  const anyActive = agents.some(isSubagentActive)
  const [open, setOpen] = useState(anyActive)
  // A finished child stays listed while its turn continues, as in the CLI;
  // only the turn's own end folds the list into the summary line.
  useEffect(() => {
    if (anyActive) setOpen(true)
    else if (!runLive) setOpen(false)
  }, [anyActive, runLive])
  const counts = new Map<SubagentStatus, number>()
  for (const agent of agents) {
    const status = isSubagentActive(agent) ? 'running' : agent.status
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  const summary = [
    `${agents.length} ${agents.length === 1 ? 'subagent' : 'subagents'}`,
    ...SUMMARY_ORDER.filter(status => counts.has(status)).map(status => `${counts.get(status)} ${subagentStatusLabel(status)}`),
  ].join(' · ')
  const Chevron = open ? ChevronDown : ChevronRight
  return <View testID="subagent-rows" style={[styles.root, { borderColor: colors.border, backgroundColor: colors.raised }]}>
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={summary}
      onPress={() => setOpen(value => !value)}
      style={styles.summary}
    >
      <Chevron size={12} color={colors.muted} />
      <Bot size={12} color={colors.muted} />
      <Text style={[styles.summaryText, { color: colors.muted }]} numberOfLines={1}>{summary}</Text>
    </Pressable>
    {open ? agents.map(agent => <SubagentRow key={agent.key} agent={agent} now={now} />) : null}
  </View>
}

function SubagentRow({ agent, now }: { agent: SubagentActivity; now: number }) {
  const colors = usePalette()
  const [logOpen, setLogOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const active = isSubagentActive(agent)
  const start = Date.parse(agent.startedAt)
  const end = active ? now : Date.parse(agent.updatedAt)
  const elapsed = formatDuration(Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) / 1000 : 0)
  const detail = active ? agent.latestActivity : agent.summary || agent.latestActivity
  const name = subagentDisplayName(agent)
  const logLines = logOpen ? subagentLogText(agent).split('\n') : []
  const hiddenLines = showAll ? 0 : Math.max(0, logLines.length - LOG_PREVIEW_LINES)
  return <View style={[styles.row, { borderTopColor: colors.borderSoft }]}>
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: logOpen }}
      accessibilityLabel={`${name}, ${subagentStatusLabel(agent.status)}, ${elapsed}`}
      onPress={() => { setLogOpen(value => !value); setShowAll(false) }}
      style={styles.rowToggle}
    >
      <View style={styles.status}>
        {active ? <ActivityIndicator size="small" color={colors.blue} />
          : agent.status === 'completed' ? <Check size={14} color={colors.green} />
            : agent.status === 'failed' ? <X size={14} color={colors.red} />
              : <Square size={10} color={colors.muted} />}
      </View>
      <View style={styles.body}>
        <View style={styles.headline}>
          <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{name}</Text>
          {agent.kind ? <Text style={[styles.kind, { color: colors.muted, borderColor: colors.border }]} numberOfLines={1}>{agent.kind}</Text> : null}
          <Text style={[styles.elapsed, { color: colors.muted }]}>{elapsed}</Text>
        </View>
        {detail ? <Text style={[styles.detail, { color: colors.muted }]} numberOfLines={logOpen ? undefined : 1}>{detail}</Text> : null}
      </View>
    </Pressable>
    {logOpen ? <View style={styles.log}>
      {hiddenLines > 0 ? <Pressable accessibilityRole="button" onPress={() => setShowAll(true)}>
        <Text style={[styles.showAll, { color: colors.blue }]}>{`Show all ${logLines.length} lines`}</Text>
      </Pressable> : null}
      <Text selectable style={[styles.logText, { color: colors.muted }]}>{logLines.slice(hiddenLines).join('\n')}</Text>
    </View> : null}
  </View>
}

const styles = StyleSheet.create({
  root: { marginHorizontal: 14, marginBottom: 6, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  summary: { minHeight: 30, paddingHorizontal: 12, paddingVertical: 5, flexDirection: 'row', alignItems: 'center', gap: 6 },
  summaryText: { fontSize: 12, flexShrink: 1 },
  row: { borderTopWidth: StyleSheet.hairlineWidth },
  rowToggle: { paddingHorizontal: 12, paddingVertical: 6, flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  status: { width: 20, height: 18, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: 2 },
  headline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { fontSize: 12, fontWeight: '700', flexShrink: 1 },
  kind: { fontSize: 10, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, maxWidth: 120 },
  elapsed: { fontSize: 12, fontVariant: ['tabular-nums'], marginLeft: 'auto' },
  detail: { fontSize: 12 },
  log: { paddingHorizontal: 12, paddingBottom: 8, paddingLeft: 40, gap: 4 },
  showAll: { fontSize: 12, fontWeight: '600' },
  logText: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 16 },
})
