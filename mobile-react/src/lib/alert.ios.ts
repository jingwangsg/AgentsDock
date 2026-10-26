import type { AlertButton, AlertOptions } from 'react-native'
import { showAlertDialog } from '../components/material/AlertDialog'

/** React Native's Alert API, drawn as the Android dialog above any open Modal. */
export const Alert = {
  alert(title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions): void {
    showAlertDialog(title, message, buttons, options)
  },
}
