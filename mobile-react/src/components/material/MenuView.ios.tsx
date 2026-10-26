import { useCallback, useImperativeHandle, useRef, type Ref } from 'react'
import { Pressable, View } from 'react-native'
import type { MenuComponentProps, MenuComponentRef } from '@expo/ui/community/menu'
import { showDropdownMenu } from './DropdownMenu'

export type { MenuAction, MenuComponentRef } from '@expo/ui/community/menu'

/**
 * The Android MenuView on iOS: the trigger opens an app-drawn Compose-style dropdown anchored to
 * it, by tap or (with shouldOpenOnLongPress) long press, or through ref.show(). It also opens
 * inside a Modal. `title` is unused, as on Android.
 */
export function MenuView({ ref, actions, onPressAction, onOpenMenu, onCloseMenu, shouldOpenOnLongPress, style, testID, children }: MenuComponentProps & { ref?: Ref<MenuComponentRef> }) {
  const trigger = useRef<View>(null)
  const open = useCallback(() => {
    onOpenMenu?.()
    showDropdownMenu({
      measureAnchor: callback => trigger.current?.measureInWindow((x, y, width, height) => callback({ x, y, width, height })),
      actions,
      onAction: id => onPressAction?.({ nativeEvent: { event: id } }),
      onClose: onCloseMenu,
    })
  }, [actions, onCloseMenu, onOpenMenu, onPressAction])
  useImperativeHandle(ref, () => ({ show: open }), [open])
  return <View style={style} testID={testID}>
    <Pressable ref={trigger} accessible={false} onPress={shouldOpenOnLongPress ? undefined : open} onLongPress={shouldOpenOnLongPress ? open : undefined}>{children}</Pressable>
  </View>
}
