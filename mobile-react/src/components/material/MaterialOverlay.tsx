import { Fragment, useEffect, useSyncExternalStore, type ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import { FullWindowOverlay } from 'react-native-screens'
import { loadMaterialFonts } from './materialTheme'

type Entry = { key: number; element: ReactElement }
let entries: readonly Entry[] = []
let nextKey = 1
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => entries
function update(next: readonly Entry[]) { entries = next; for (const listener of listeners) listener() }

/**
 * Shows `render(close)` above the whole app until `close` runs. iOS presents every RN Modal as
 * its own view controller, so a view rendered at the app root sits under any open Modal; the
 * host draws through react-native-screens' FullWindowOverlay, which adds its container to the
 * key window when it mounts, above every presented controller. Later entries draw on top.
 */
export function showMaterialOverlay(render: (close: () => void) => ReactElement): () => void {
  const key = nextKey++
  const close = () => { if (entries.some(entry => entry.key === key)) update(entries.filter(entry => entry.key !== key)) }
  update([...entries, { key, element: render(close) }])
  return close
}

/** Mounted once at the app root on iOS. Renders nothing (and no window overlay) while idle. */
export function MaterialOverlayHost() {
  const shown = useSyncExternalStore(subscribe, snapshot)
  useEffect(() => { void loadMaterialFonts() }, [])
  // load-bearing: the overlay must unmount when idle. FullWindowOverlay adds its container to the
  // window when it mounts; a Modal presented after that would cover it.
  if (!shown.length) return null
  return <FullWindowOverlay>
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {shown.map(entry => <Fragment key={entry.key}>{entry.element}</Fragment>)}
    </View>
  </FullWindowOverlay>
}
