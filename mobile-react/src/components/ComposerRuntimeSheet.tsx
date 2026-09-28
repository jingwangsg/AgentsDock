import { useRef } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Check } from 'lucide-react-native'
import { usePalette } from '../theme'
import type { RuntimeOption } from '../types'
import { Text } from './AppText'
import { SheetCloseButton } from './ui'

/**
 * Page-sheet port of the desktop runtime menu: a "Model" list and a "Reasoning"
 * list whose rows show the catalog description under the label. Opened from the
 * toolbar chip and from the `/model` and `/reasoning` commands.
 */
export function ComposerRuntimeSheet({ section, models, efforts, model, effort, onPickModel, onPickEffort, onClose }: {
  /** The list the opener wants in view; null keeps the sheet closed. */
  section: 'model' | 'reasoning' | null
  models: readonly RuntimeOption[]
  efforts: readonly RuntimeOption[]
  model: string | null | undefined
  effort: string | null | undefined
  onPickModel: (value: string) => void
  onPickEffort: (value: string) => void
  onClose: () => void
}) {
  const colors = usePalette()
  const scroll = useRef<ScrollView>(null)
  if (!section) return null
  const hasEfforts = efforts.some(option => Boolean(option.value))
  return <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose={onClose}>
    <SafeAreaView testID="composer-runtime-sheet" style={[styles.sheet, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.text }]}>Model and reasoning</Text>
        <SheetCloseButton testID="composer-runtime-sheet-close" label="Close model and reasoning" onPress={onClose} />
      </View>
      <ScrollView ref={scroll} contentContainerStyle={styles.content}>
        <Text style={[styles.section, { color: colors.muted }]}>Model</Text>
        {models.map(option => <OptionRow key={option.value || 'default'} testID={`composer-runtime-model-${option.value || 'default'}`} option={option} selected={option.value === (model ?? '')} onPress={() => onPickModel(option.value)} />)}
        {hasEfforts ? <View
          // The model list can run past one screen; `/reasoning` lands on its own section.
          onLayout={section === 'reasoning' ? event => scroll.current?.scrollTo({ y: event.nativeEvent.layout.y, animated: false }) : undefined}
        >
          <Text style={[styles.section, styles.sectionGap, { color: colors.muted }]}>Reasoning</Text>
          {efforts.map(option => <OptionRow key={option.value || 'default'} testID={`composer-runtime-effort-${option.value || 'default'}`} option={option} selected={option.value === (effort ?? '')} onPress={() => onPickEffort(option.value)} />)}
        </View> : null}
      </ScrollView>
    </SafeAreaView>
  </Modal>
}

function OptionRow({ option, selected, onPress, testID }: { option: RuntimeOption; selected: boolean; onPress: () => void; testID: string }) {
  const colors = usePalette()
  const locked = Boolean(option.locked)
  const detail = locked ? option.locked_reason?.trim() : option.description?.trim()
  return <Pressable
    testID={testID}
    accessibilityRole="button"
    accessibilityLabel={detail ? `${option.label}. ${detail}` : option.label}
    accessibilityState={{ selected, disabled: locked }}
    disabled={locked}
    onPress={onPress}
    style={({ pressed }) => [styles.row, { borderTopColor: colors.border, opacity: locked ? 0.4 : pressed ? 0.6 : 1 }]}
  >
    <View style={styles.copy}>
      <Text style={[styles.label, { color: colors.text }]} numberOfLines={1}>{option.label}</Text>
      {detail ? <Text style={[styles.description, { color: colors.muted }]} numberOfLines={2}>{detail}</Text> : null}
    </View>
    {selected ? <Check size={18} color={colors.blue} /> : null}
  </Pressable>
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  header: { minHeight: 64, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, minWidth: 0, fontSize: 17, fontWeight: '800' },
  content: { padding: 14, paddingBottom: 40, width: '100%', maxWidth: 700, alignSelf: 'center' },
  section: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4, paddingBottom: 6 },
  sectionGap: { marginTop: 18 },
  row: { minHeight: 48, borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  label: { fontSize: 14, fontWeight: '700' },
  description: { fontSize: 12, lineHeight: 16 },
})
