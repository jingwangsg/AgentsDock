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
