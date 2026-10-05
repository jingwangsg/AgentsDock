import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const read = file => fs.readFileSync(path.resolve(file), 'utf8')

test('web links in a chat open in the app browser tab; long press offers Copy link and the system browser', () => {
  const markdown = read('src/components/MarkdownContent.tsx')
  // Bare URLs become links too.
  assert.match(markdown, /new MarkdownIt\(\{ typographer: true, linkify: true \}\)/)
  assert.match(markdown, /chatMarkdown\.linkify\.set\(\{ fuzzyLink: false, fuzzyEmail: false \}\)/)
  assert.match(markdown, /if \(isWebLink\(url\) && webLinks === 'tab'\) \{[\s\S]{0,160}openLinkInBrowser\(url, sourceSessionId \?\? null\)/)
  // Text inside a sheet that covers the tab area keeps sending web links to the system browser.
  assert.match(read('src/components/SideChatSheet.tsx'), /<MarkdownContent webLinks="system"/)
  assert.match(read('src/components/TeamNetwork.tsx'), /<MarkdownContent webLinks="system"/)
  // One action-menu helper serves chat links and the Outputs panel.
  assert.match(markdown, /showActionMenu\(url, \[\n\s+\{ text: 'Copy link'[\s\S]{0,160}\{ text: 'Open in browser'/)
  assert.match(read('src/lib/action-menu.ts'), /options: \[\.\.\.actions\.map\(action => action\.text\), 'Cancel'\]/)
  assert.match(read('src/components/ChatOutputsPanel.tsx'), /import \{ showActionMenu \} from '\.\.\/lib\/action-menu'/)
  assert.match(markdown, /onLongPress=\{isWebLink\(href\) \? \(\) => linkMenu\(href\) : undefined\}/)
  const store = read('src/store/useAppStore.ts')
  // The tab already showing the URL is reused; otherwise a new tab opens in the chat's folder.
  assert.match(store, /async openLinkInBrowser\(url, sourceSessionId\) \{[\s\S]{0,200}surface\.kind === 'browser' && sameWebAddress\(surface\.url, url\)/)
  assert.match(store, /createSurface\('browser', source\?\.folder\?\.trim\(\) \|\| 'General', undefined, url\)/)
  assert.match(store, /if \(!created\) void Linking\.openURL\(url\)/)
  // On a phone the selected tab comes forward even when the link was tapped outside the sidebar.
  assert.match(read('src/components/AppShell.tsx'), /if \(id && id !== shownSurfaceId\.current && compact && !mobileChatOpen\) openMobileChat\(\)/)
})
