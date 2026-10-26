import { Alert } from './alert'

/**
 * A long-press action menu that also works inside a Modal, where Android's MenuView does not
 * open: an alert with Cancel first. On Android at most three buttons fit, so callers pass two
 * actions at most.
 */
export function showActionMenu(title: string, actions: { text: string; onPress: () => void }[]): void {
  Alert.alert(title, undefined, [{ text: 'Cancel', style: 'cancel' }, ...actions])
}
