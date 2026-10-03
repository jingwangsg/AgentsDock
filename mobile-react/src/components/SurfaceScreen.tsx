import { Pressable, StyleSheet, View } from 'react-native'
import { ChevronLeft, Globe, Terminal, X } from 'lucide-react-native'
import { promptSurfaceRename, surfaceSubline, surfaceTitle } from '../lib/surfaces'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { Surface } from '../types'
import { Text } from './AppText'
import { BrowserView } from './BrowserView'
import { TerminalView } from './TerminalView'
import { useTextPrompt } from './TextPromptDialog'
import { IconButton } from './ui'

/** A terminal or browser tab in the chat's place: header with rename and close, then the tab itself. */
export function SurfaceScreen({ surface, compact, onBack }: { surface: Surface; compact: boolean; onBack: () => void }) {
  const colors = usePalette()
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const updateSurface = useAppStore(state => state.updateSurface)
  const removeSurface = useAppStore(state => state.removeSurface)
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
      {compact ? <IconButton icon={ChevronLeft} size={18} label="Back to chat list" testID="tab-back" onPress={onBack} /> : null}
      <Icon size={15} color={colors.muted} />
      <Pressable accessibilityRole="button" accessibilityLabel={`Rename ${title}`} accessibilityHint="Opens a rename prompt." onPress={rename} style={styles.titleBlock}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{title}</Text>
        <Text style={[styles.subline, { color: colors.muted }]} numberOfLines={1}>{surfaceSubline(surface)}</Text>
      </Pressable>
      <IconButton icon={X} size={17} touchSize={44} label="Close tab" testID="tab-close" onPress={() => void removeSurface(surface.id, profileGeneration)} />
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
