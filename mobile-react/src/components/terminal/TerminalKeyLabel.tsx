import type { StyleProp, TextStyle } from 'react-native'
import { Text } from '../AppText'

/** A terminal key row label. Android draws ⇧, ⤒ and ⤓, which Plex lacks, from its Noto Sans Symbols fallback. */
export function TerminalKeyLabel({ label, style }: { label: string; style: StyleProp<TextStyle> }) {
  return <Text style={style}>{label}</Text>
}
