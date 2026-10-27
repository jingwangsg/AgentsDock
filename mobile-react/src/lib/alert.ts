// Android keeps React Native's Alert (an AppCompat AlertDialog); alert.ios.ts draws the same
// dialog on iOS. Import Alert from here instead of 'react-native'.
import type { AlertButton } from 'react-native'
export { Alert } from 'react-native'

/**
 * Spread first into the buttons of an alert that has no Cancel on Android. There Back and a tap
 * outside close it when it is cancelable, and only an action closes it otherwise. iOS has no Back,
 * so the iOS dialog gets a Cancel button instead. Empty on Android.
 */
export const IOS_ONLY_CANCEL: AlertButton[] = []
