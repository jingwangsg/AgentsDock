type NetInfoListener = (state: { type: string; isConnected: boolean | null; details: { ipAddress?: string | null } | null }) => void

const listeners = new Set<NetInfoListener>()

// The listener a store test drives: __emit stands for Android reporting a network change.
const NetInfo = {
  addEventListener(listener: NetInfoListener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  __emit(state: Parameters<NetInfoListener>[0]) {
    for (const listener of listeners) listener(state)
  },
}

export default NetInfo
