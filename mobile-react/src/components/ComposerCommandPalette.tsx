import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native'
import { Check, X } from 'lucide-react-native'
import { COMPOSER_COMMAND_CATEGORIES, groupComposerCommandsByCategory, type ComposerCommand } from '../lib/composer-commands'
import { usePalette } from '../theme'
import { fonts } from '../lib/typography'
import type { RuntimeOption } from '../types'
import { Text } from './AppText'
import { IconButton } from './ui'

export type ProviderCommandLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/**
 * Touch-first port of the desktop slash palette: one tap runs a command, so
 * there is no highlighted row, keyboard footer, or arrow-key state.
 */
export function ComposerCommandPalette({ commands, loadStatus, onRefresh, onSelect }: {
  commands: readonly ComposerCommand[]
  loadStatus: ProviderCommandLoadStatus
  onRefresh: () => void
  onSelect: (command: ComposerCommand) => void
}) {
  const colors = usePalette()
  return <View testID="composer-command-palette" accessibilityRole="menu" accessibilityLabel="Chat commands" style={[styles.card, { backgroundColor: colors.raised, borderColor: colors.border }]}>
    {groupComposerCommandsByCategory(commands, COMPOSER_COMMAND_CATEGORIES).map(group => <View key={group.id} accessibilityLabel={group.heading}>
      {group.showHeading ? <Text style={[styles.heading, { color: colors.muted }]}>{group.heading}</Text> : null}
      {group.items.map(({ command }) => <Pressable
        key={command.id}
        testID={`composer-command-${command.id}`}
        accessibilityRole="menuitem"
        accessibilityLabel={`${command.label}. ${command.description}`}
        onPress={() => onSelect(command)}
        style={({ pressed }) => [styles.row, { borderTopColor: colors.border, opacity: pressed ? 0.6 : 1 }]}
      >
        <View style={styles.copy}>
          <Text style={[styles.label, { color: colors.text }]} numberOfLines={1}>{command.label}{command.meta ? <Text style={[styles.meta, { color: colors.muted }]}> {command.meta}</Text> : null}</Text>
          {command.description ? <Text style={[styles.description, { color: colors.muted }]} numberOfLines={2}>{command.description}</Text> : null}
        </View>
        <Text style={[styles.token, { color: colors.blue }]} numberOfLines={1}>{command.provider ? command.provider.command.invocation : `/${command.id}`}</Text>
      </Pressable>)}
    </View>)}
    {loadStatus === 'loading' ? <View testID="composer-command-loading" accessibilityRole="progressbar" style={[styles.status, { borderTopColor: colors.border }]}>
      <ActivityIndicator size="small" color={colors.muted} />
      <Text style={[styles.description, { color: colors.muted }]}>Loading provider commands…</Text>
    </View> : null}
    {loadStatus === 'error' ? <View testID="composer-command-error" accessibilityRole="alert" style={[styles.status, { borderTopColor: colors.border }]}>
      <Text style={[styles.description, styles.grow, { color: colors.red }]}>Provider commands could not be loaded.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Retry loading provider commands" onPress={onRefresh} style={styles.retry}><Text style={{ color: colors.blue, fontSize: 12, fontWeight: '800' }}>Retry</Text></Pressable>
    </View> : null}
  </View>
}

/** Choice list for `/model` and `/reasoning`; the toolbar's native menu cannot be opened programmatically. */
export function ComposerOptionPicker({ title, options, current, onPick, onClose }: {
  title: string
  options: readonly RuntimeOption[]
  current: string | null | undefined
  onPick: (value: string) => void
  onClose: () => void
}) {
  const colors = usePalette()
  return <View testID="composer-option-picker" accessibilityRole="menu" accessibilityLabel={title} style={[styles.card, { backgroundColor: colors.raised, borderColor: colors.border }]}>
    <View style={styles.pickerHeader}>
      <Text style={[styles.heading, styles.grow, { color: colors.muted }]}>{title}</Text>
      <IconButton icon={X} size={15} touchSize={44} onPress={onClose} label={`Close ${title.toLocaleLowerCase()} picker`} testID="composer-option-picker-close" />
    </View>
    {options.length === 0 ? <Text style={[styles.description, styles.empty, { color: colors.muted }]}>No choices are available for this chat.</Text> : null}
    {options.map(option => {
      const selected = option.value === (current ?? '')
      return <Pressable
        key={option.value || 'default'}
        testID={`composer-option-${option.value || 'default'}`}
        accessibilityRole="menuitem"
        accessibilityState={{ selected, disabled: Boolean(option.locked) }}
        disabled={Boolean(option.locked)}
        onPress={() => onPick(option.value)}
        style={({ pressed }) => [styles.row, { borderTopColor: colors.border, opacity: option.locked ? 0.4 : pressed ? 0.6 : 1 }]}
      >
        <View style={styles.copy}>
          <Text style={[styles.label, { color: colors.text }]} numberOfLines={1}>{option.label}</Text>
          {option.locked && option.locked_reason ? <Text style={[styles.description, { color: colors.muted }]} numberOfLines={2}>{option.locked_reason}</Text>
            : option.description?.trim() ? <Text style={[styles.description, { color: colors.muted }]} numberOfLines={2}>{option.description.trim()}</Text> : null}
        </View>
        {selected ? <Check size={16} color={colors.blue} /> : null}
      </Pressable>
    })}
  </View>
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, overflow: 'hidden' },
  heading: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.4, textTransform: 'uppercase', paddingHorizontal: 11, paddingTop: 8, paddingBottom: 3 },
  row: { minHeight: 48, borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 11, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 9 },
  copy: { minWidth: 0, flex: 1, gap: 1 },
  label: { fontSize: 13, fontWeight: '800' },
  meta: { fontSize: 11, fontWeight: '600' },
  description: { fontSize: 11.5, lineHeight: 15 },
  token: { maxWidth: 130, fontSize: 11, fontFamily: fonts.mono, fontWeight: '700' },
  status: { minHeight: 44, borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', gap: 9 },
  retry: { minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' },
  grow: { flex: 1, minWidth: 0 },
  pickerHeader: { flexDirection: 'row', alignItems: 'center', paddingRight: 2 },
  empty: { paddingHorizontal: 11, paddingBottom: 10 },
})
