import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { Platform } from 'react-native'
import { BrowserView } from '../src/components/BrowserView'
import { setRouteResult } from './component-mocks/browser-tab'
import { resetComponentStore, setTestClient } from './component-mocks/app-store'
import type { Surface } from '../src/types'

const NOTICE = "This phone's web view cannot reach the server's localhost; localhost here is the phone."
let tree: ReturnType<typeof create> | null = null
const noticeShown = async (os: 'ios' | 'android', routed: boolean, url: string) => {
  Platform.OS = os
  setRouteResult(routed)
  resetComponentStore()
  setTestClient({ url: (path: string) => `http://192.168.1.20:8787${path}`, authHeaders: () => ({}) } as never)
  await act(async () => { tree = create(<BrowserView surface={{ id: 'browser_1', kind: 'browser', url } as Surface} />) })
  const shown = tree!.root.findAll(node => node.type === 'Text' && node.props.children === NOTICE).length > 0
  await act(async () => { tree!.unmount() })
  tree = null
  return shown
}

afterEach(() => { Platform.OS = 'ios' })

test('an iOS tab says localhost is the phone for 127.x and [::1], which WebKit loads past the proxy', async () => {
  assert.equal(await noticeShown('ios', true, 'http://127.0.0.1:8080/'), true)
  assert.equal(await noticeShown('ios', true, 'http://127.1.2.3:3000'), true)
  assert.equal(await noticeShown('ios', true, 'http://[::1]:8080/app'), true)
  // The name localhost goes through the proxy to the server.
  assert.equal(await noticeShown('ios', true, 'http://localhost:8080/'), false)
  assert.equal(await noticeShown('ios', true, 'https://example.com/'), false)
  // Unrouted (iOS 16): every loopback address is the phone's, as before.
  assert.equal(await noticeShown('ios', false, 'http://localhost:8080/'), true)
})

test('an Android tab shows the notice only when the page cannot be routed, as before', async () => {
  assert.equal(await noticeShown('android', true, 'http://127.0.0.1:8080/'), false)
  assert.equal(await noticeShown('android', true, 'http://[::1]:8080/'), false)
  assert.equal(await noticeShown('android', false, 'http://127.0.0.1:8080/'), true)
  assert.equal(await noticeShown('android', false, 'http://localhost:8080/'), true)
})
