import type { ComponentType, RefAttributes } from 'react'
import type { NativeSyntheticEvent, ViewProps } from 'react-native'
import { requireNativeModule, requireNativeViewManager } from 'expo-modules-core'

export type AgentsDockNativeVideoStatus = {
  status: 'Loading' | 'Ready' | 'Playing' | 'Paused' | 'Error'
  message?: string
  duration?: number
}

export type AgentsDockNativeVideoHandle = {
  play(): Promise<boolean>
  pause(): Promise<boolean>
}

export type AgentsDockNativeVideoProps = ViewProps & {
  sourceURI: string
  autoplay?: boolean
  contentFit?: 'contain' | 'cover'
  onStatus?: (event: NativeSyntheticEvent<AgentsDockNativeVideoStatus>) => void
}

type NativeVideoComponent = ComponentType<
  AgentsDockNativeVideoProps & RefAttributes<AgentsDockNativeVideoHandle>
>

let cachedView: NativeVideoComponent | null = null

/**
 * Resolve the Apple-only view lazily. Android never evaluates a missing view
 * manager merely because the cross-platform artifact viewer was imported.
 */
export function requireAgentsDockNativeVideo(): NativeVideoComponent {
  if (!cachedView) {
    cachedView = requireNativeViewManager<AgentsDockNativeVideoProps>(
      'AgentsDockNativeVideo',
    ) as NativeVideoComponent
  }
  return cachedView
}

type NativeVideoModule = {
  generateThumbnailAsync(requestId: string, uri: string, headers: Record<string, string>): Promise<string>
  cancelThumbnail(requestId: string): void
}

let cachedModule: NativeVideoModule | null = null
let thumbnailRequestCount = 0

/**
 * Read one frame of a remote video as a JPEG data URI without creating a
 * player. `cancel` stops the request's network reads; the promise then rejects.
 */
export function generateAgentsDockVideoThumbnail(uri: string, headers: Record<string, string>): {
  result: Promise<string>
  cancel: () => void
} {
  cachedModule ??= requireNativeModule<NativeVideoModule>('AgentsDockNativeVideo')
  const module = cachedModule
  const requestId = `thumbnail-${++thumbnailRequestCount}`
  let settled = false
  const result = module.generateThumbnailAsync(requestId, uri, headers)
    .finally(() => { settled = true })
  return {
    result,
    cancel: () => { if (!settled) module.cancelThumbnail(requestId) },
  }
}
