import type { StyleProp, TextStyle } from 'react-native'
import { Text } from '../AppText'
import { useMaterialFont } from '../material/materialTheme'

const SYMBOL = /^[⇧⤒⤓]/

/**
 * A terminal key row label. iOS's fallback draws ⇧, ⤒ and ⤓ (Plex lacks them) in other shapes than
 * Android's Noto Sans Symbols fallback, so they come from the bundled subset of that font.
 */
export function TerminalKeyLabel({ label, style }: { label: string; style: StyleProp<TextStyle> }) {
  const symbols = useMaterialFont('NotoSansSymbols-Keys')
  if (!SYMBOL.test(label)) return <Text style={style}>{label}</Text>
  return <Text style={style}><Text style={{ fontFamily: symbols }}>{label[0]}</Text>{label.slice(1)}</Text>
}
