import { ActionSheetIOS, Alert, Platform } from 'react-native'

/**
 * A long-press action menu that also works inside a Modal on Android, where MenuView does not
 * open and an alert holds at most three buttons: an action sheet on iOS, an alert elsewhere.
 */
export function showActionMenu(title: string, actions: { text: string; onPress: () => void }[]): void {
  if (Platform.OS !== 'ios') {
    Alert.alert(title, undefined, [{ text: 'Cancel', style: 'cancel' }, ...actions])
    return
  }
  ActionSheetIOS.showActionSheetWithOptions(
    { title, options: [...actions.map(action => action.text), 'Cancel'], cancelButtonIndex: actions.length },
    index => actions[index]?.onPress(),
  )
}
