import type { AlertButton } from 'react-native'
import { showAlertDialog } from '../components/material/AlertDialog'

/** React Native's Alert API, drawn as the Android dialog above any open Modal. */
export const Alert = { alert: showAlertDialog }

/** See alert.ts. */
export const IOS_ONLY_CANCEL: AlertButton[] = [{ text: 'Cancel', style: 'cancel' }]
