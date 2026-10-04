import { Pressable, StyleSheet, View } from 'react-native'
import { ChevronLeft, Globe, PanelLeftClose, PanelLeftOpen, Terminal } from 'lucide-react-native'
import { promptSurfaceRename, surfaceSubline, surfaceTitle } from '../lib/surfaces'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { Surface } from '../types'
import { Text } from './AppText'
import { BrowserView } from './BrowserView'
import { TerminalView } from './TerminalView'
import { useTextPrompt } from './TextPromptDialog'
import { IconButton } from './ui'

/** A terminal or browser tab in the chat's place: header with rename, then the tab itself. Closing lives in the tab row's long-press menu. */
export function SurfaceScreen({ surface, compact, sidebarCollapsed, onToggleSidebar, onBack }: {
  surface: Surface
  compact: boolean
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  onBack: () => void
}) {
  const colors = usePalette()
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const updateSurface = useAppStore(state => state.updateSurface)
  const { promptText, textPromptDialog } = useTextPrompt()
  const title = surfaceTitle(surface)
  const rename = () => {
    void promptSurfaceRename(surface, promptText).then(patch => {
      if (patch) void updateSurface(surface.id, patch, profileGeneration)
    })
  }
  const Icon = surface.kind === 'terminal' ? Terminal : Globe
  return <View style={[styles.root, { backgroundColor: colors.background }]}>
    <View style={[styles.header, { borderColor: colors.border }]}>
      {compact
        ? <IconButton icon={ChevronLeft} size={18} label="Back to chat list" testID="tab-back" onPress={onBack} />
        : <IconButton icon={sidebarCollapsed ? PanelLeftOpen : PanelLeftClose} onPress={onToggleSidebar} label={sidebarCollapsed ? 'Show chat list' : 'Hide chat list'} testID="chat-sidebar-toggle" />}
      <Icon size={15} color={colors.muted} />
      <Pressable accessibilityRole="button" accessibilityLabel={`Rename ${title}`} accessibilityHint="Opens a rename prompt." onPress={rename} style={styles.titleBlock}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{title}</Text>
        <Text style={[styles.subline, { color: colors.muted }]} numberOfLines={1}>{surfaceSubline(surface)}</Text>
      </Pressable>
    </View>
    {surface.kind === 'terminal' ? <TerminalView terminal={surface} /> : <BrowserView surface={surface} />}
    {textPromptDialog}
  </View>
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  header: { minHeight: 68, paddingHorizontal: 10, paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 8 },
  titleBlock: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center' },
  title: { fontSize: 15, fontWeight: '700' },
  subline: { marginTop: 2, fontSize: 11, fontWeight: '600' },
})
