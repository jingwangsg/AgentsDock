import { useState } from 'react'
import * as Clipboard from 'expo-clipboard'
import { Check, Copy } from 'lucide-react-native'
import { IconButton } from './ui'

/** Copies `text`; the icon turns into a check for a moment to confirm the tap. */
export function CopyTextButton({ text, label = 'Copy', testID }: { text: string; label?: string; testID?: string }) {
  const [copied, setCopied] = useState(false)
  return <IconButton
    icon={copied ? Check : Copy}
    size={14}
    touchSize={32}
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
