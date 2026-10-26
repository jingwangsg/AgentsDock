import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const view = await readFile(resolve('src/components/BrowserView.tsx'), 'utf8')
const webViewPatch = await readFile(resolve('patches/react-native-webview@13.16.1.patch'), 'utf8')
const workspace = await readFile(resolve('pnpm-workspace.yaml'), 'utf8')

test('a browser tab loads its page through its own server, never from the shared web view cache', () => {
  // Android web views share one HTTP cache keyed by URL, which showed one server's page in another server's
  // tab at the same address. incognito would also stop that, but it deletes the app's cookies and site logins.
  assert.match(view, /cacheEnabled=\{false\}/)
  assert.doesNotMatch(view, /^\s+incognito\b/m)
})

test('each browser tab keeps its own web storage, keyed by server profile and tab', () => {
  // Shared storage let a localhost cookie or service worker from one server's page reach another server's tab,
  // and let the app's incognito web views delete tab logins.
  assert.match(view, /const webViewProfile = `agentsdock-browser-\$\{encodeURIComponent\(activeProfileId \?\? 'none'\)\}-\$\{surface\.id\}`/)
  // A web view takes a profile only once, so another profile name needs a new web view.
  assert.match(view, /key=\{webViewProfile\}\s+webViewProfile=\{webViewProfile\}/)
  assert.match(workspace, /react-native-webview@13\.16\.1: patches\/react-native-webview@13\.16\.1\.patch/)
  assert.match(webViewPatch, /\+  webViewProfile\?: string;/)
  assert.match(webViewPatch, /@ReactProp\(name = "webViewProfile"\)/)
  // The profile is set right after the web view is built, before any initial prop: setting messagingEnabled
  // evaluates JavaScript, after which setProfile throws.
  assert.match(webViewPatch, /initialProps\.getString\("webViewProfile"\)/)
  assert.match(webViewPatch, /\+\s+RNCWebViewWrapper view = mRNCWebViewManagerImpl\.createViewInstance\(context\);\n\+\s+mRNCWebViewManagerImpl\.setWebViewProfile\(view, mInitialWebViewProfile\);/)
  assert.match(webViewPatch, /\+\s+try \{\n\+\s+WebViewCompat\.setProfile\(viewWrapper\.webView, profileName\)\n\+\s+\} catch \(e: IllegalStateException\)/)
  // Cookies are written to disk after a page load, and a download is fetched with them, from the tab's own profile.
  assert.match(webViewPatch, /\+\s+CookieManager cookieManager = \(\(RNCWebView\) webView\)\.getProfileCookieManager\(\);/)
  assert.match(webViewPatch, /\+\s+cookieManager\.flush\(\);/)
  assert.match(webViewPatch, /\+\s+val cookie = webView\.profileCookieManager\.getCookie\(baseUrl\)/)
})

test('an iOS browser tab uses the data store its profile names, and the tab routes that store', async () => {
  const module = await readFile(resolve('modules/agentsdock-browser-loopback/ios/AgentsDockBrowserLoopbackModule.swift'), 'utf8')
  const storeName = await readFile(resolve('modules/agentsdock-browser-loopback/ios/WebViewProfileStore.swift'), 'utf8')
  // The module sets the proxy on the store the profile names, so the tab routes by its profile, not its id.
  assert.match(view, /routeBrowserThroughServer\(webViewProfile, /)
  assert.match(view, /releaseBrowserRouting\(webViewProfile\)/)
  assert.match(module, /WKWebsiteDataStore\(forIdentifier: profileStoreIdentifier\(profile\)\)/)
  assert.match(webViewPatch, /\+\s+REMAP_WEBVIEW_STRING_PROP\(webViewProfile\)/)
  assert.match(webViewPatch, /\+\s+wkWebViewConfig\.websiteDataStore = \[WKWebsiteDataStore dataStoreForIdentifier:RNCWebViewProfileIdentifier\(_webViewProfile\)\];/)
  // Both sides derive one UUID: SHA-256 of the name, first 16 bytes, RFC 9562 version 8 and variant bits.
  // The Swift side is checked against the vector by `pnpm run test:browser-loopback-ios`.
  assert.match(webViewPatch, /\+\s+CC_SHA256\(name\.bytes, \(CC_LONG\)name\.length, digest\);\n\+\s+digest\[6\] = \(digest\[6\] & 0x0F\) \| 0x80;.*\n\+\s+digest\[8\] = \(digest\[8\] & 0x3F\) \| 0x80;/)
  assert.match(storeName, /SHA256\.hash\(data: Data\(profile\.utf8\)\)\.prefix\(16\)\)\n\s+b\[6\] = \(b\[6\] & 0x0F\) \| 0x80.*\n\s+b\[8\] = \(b\[8\] & 0x3F\) \| 0x80/)
})

test('an edge swipe does not walk a browser tab history, as on Android', () => {
  assert.match(view, /allowsBackForwardNavigationGestures=\{false\}/)
})
