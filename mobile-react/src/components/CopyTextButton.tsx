import { useState } from 'react'
import * as Clipboard from 'expo-clipboard'
import { Check, Copy } from 'lucide-react-native'
import { IconButton } from './ui'

/** Copies `text`; the icon turns into a check for a moment to confirm the tap. */
export function CopyTextButton({ text, label = 'Copy', testID, touchSize = 32 }: { text: string; label?: string; testID?: string; touchSize?: number }) {
  const [copied, setCopied] = useState(false)
  return <IconButton
    icon={copied ? Check : Copy}
    size={14}
    touchSize={touchSize}
    label={copied ? 'Copied' : label}
    testID={testID}
    onPress={() => {
      void Clipboard.setStringAsync(text).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
    }}
  />
}
