import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const source = relativePath => fs.readFileSync(path.resolve(relativePath), 'utf8')
const markdown = source('src/components/MarkdownContent.tsx')
const chatScreen = source('src/components/ChatScreen.tsx')
const host = source('src/components/file-viewer/FileViewerHost.tsx')

// The emitter runs for real against a DeviceEventEmitter that records emits.
const outfile = path.resolve('build/tmp', `workspace-path-links-${process.pid}.mjs`)
await mkdir(path.dirname(outfile), { recursive: true })
await build({
  entryPoints: ['src/lib/workspace-path-links.ts'], outfile,
  bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
  plugins: [{ name: 'recording-device-events', setup(context) {
    context.onResolve({ filter: /^react-native$/ }, () => ({ path: 'react-native', namespace: 'device-events' }))
    context.onLoad({ filter: /.*/, namespace: 'device-events' }, () => ({
      contents: 'export const DeviceEventEmitter = { emit: (...args) => globalThis.__workspacePathEmits.push(args) }',
      loader: 'js',
    }))
  } }],
})
after(async () => { await unlink(outfile) })
globalThis.__workspacePathEmits = []
const { OPEN_WORKSPACE_PATH_EVENT, openWorkspacePathLink } = await import(pathToFileURL(outfile).href)

test('chat path links go to the chat; URLs, anchors and Markdown without a chat keep their old handling', () => {
  const paths = ['/Users/dev/O-1%20refs', 'out/run/report.csv', '~/notes', 'C:/work/report.pdf']
  for (const href of paths) assert.equal(openWorkspacePathLink(href, 'chat-7'), true, href)
  for (const [href, sessionId] of [
    ['https://example.com/docs', 'chat-7'],
    ['mailto:dev@example.com', 'chat-7'],
    ['agentsdock://team-message?section=mail', 'chat-7'],
    ['#install', 'chat-7'],
    ['  ', 'chat-7'],
    ['docs/guide.pdf', null],
  ]) assert.equal(openWorkspacePathLink(href, sessionId), false, `${href} in ${sessionId}`)
  assert.deepEqual(
    globalThis.__workspacePathEmits,
    paths.map(href => [OPEN_WORKSPACE_PATH_EVENT, { sessionId: 'chat-7', href }]),
  )
})

test('the chat screen resolves a path link against its cwd, then opens the viewer or explains', () => {
  assert.match(markdown, /import \{ openWorkspacePathLink \} from '\.\.\/lib\/workspace-path-links'/)
  assert.match(chatScreen, /DeviceEventEmitter\.addListener\(OPEN_WORKSPACE_PATH_EVENT, \(request: OpenWorkspacePathRequest\) => \{\n\s+if \(request\.sessionId !== sessionId\) return/)
  assert.match(chatScreen, /const target = workspacePathLinkTarget\(request\.href, useAppStore\.getState\(\)\.sessions\.find\(value => value\.id === sessionId\)\?\.cwd\)/)
  assert.match(chatScreen, /if \(target\.kind === 'workspace'\) openWorkspace\(sessionId, target\.path\)\n\s+else Alert\.alert\('Outside the working directory', `[^`]*\$\{target\.path\}`\)/)
  assert.match(host, /openWorkspace: \(sessionId: string, initialPath\?: string\) => present\(\{ kind: 'workspace', sessionId, initialPath \}\)/)
})
