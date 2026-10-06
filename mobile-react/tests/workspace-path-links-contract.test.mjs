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
const resolverOutfile = path.resolve('build/tmp', `file-viewer-${process.pid}.mjs`)
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
await build({ entryPoints: ['src/lib/file-viewer.ts'], outfile: resolverOutfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
after(async () => { await unlink(outfile); await unlink(resolverOutfile) })
globalThis.__workspacePathEmits = []
const { OPEN_WORKSPACE_PATH_EVENT, openWorkspacePathLink } = await import(pathToFileURL(outfile).href)
const { workspacePathLinkTarget } = await import(pathToFileURL(resolverOutfile).href)

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

test('a path link resolves to the workspace, to one absolute server file, or to nothing', () => {
  const cwd = '/Users/dev/WORKSPACE/agentdock/AgentsDock'
  assert.deepEqual(workspacePathLinkTarget('src/App.tsx', cwd), { kind: 'workspace', path: 'src/App.tsx' })
  assert.deepEqual(workspacePathLinkTarget('src/../README.md', cwd), { kind: 'workspace', path: 'README.md' })
  assert.deepEqual(workspacePathLinkTarget(`${cwd}/docs/DEV_LOG.md`, cwd), { kind: 'workspace', path: 'docs/DEV_LOG.md' })
  assert.deepEqual(workspacePathLinkTarget(cwd, cwd), { kind: 'workspace', path: '' })
  // A climb that lands back inside cwd is still a workspace file.
  assert.deepEqual(workspacePathLinkTarget('../AgentsDock/README.md', cwd), { kind: 'workspace', path: 'README.md' })
  // A Markdown link that climbs out of cwd names one file on the server, in the canonical form the server requires.
  assert.deepEqual(workspacePathLinkTarget('../../../../../tmp/inv_kazheng/media/clip.mp4', cwd), { kind: 'absolute', path: '/tmp/inv_kazheng/media/clip.mp4' })
  assert.deepEqual(workspacePathLinkTarget('../sibling/REVIEW.md', cwd), { kind: 'absolute', path: '/Users/dev/WORKSPACE/agentdock/sibling/REVIEW.md' })
  assert.deepEqual(workspacePathLinkTarget('/etc/hosts', cwd), { kind: 'absolute', path: '/etc/hosts' })
  assert.deepEqual(workspacePathLinkTarget('/Users/dev/O-1%20refs/plan.md', cwd), { kind: 'absolute', path: '/Users/dev/O-1 refs/plan.md' })
  assert.deepEqual(workspacePathLinkTarget('~/notes/a/../todo.md', cwd), { kind: 'absolute', path: '~/notes/todo.md' })
  // Nothing on the server has these names.
  assert.deepEqual(workspacePathLinkTarget('../../../../../../../../x', cwd), { kind: 'outside', path: '../../../../../../../../x' })
  assert.deepEqual(workspacePathLinkTarget('~other/x', cwd), { kind: 'outside', path: '~other/x' })
  assert.deepEqual(workspacePathLinkTarget('~', cwd), { kind: 'outside', path: '~' })
  assert.deepEqual(workspacePathLinkTarget('../x', null), { kind: 'outside', path: '../x' })
})

test('the chat screen resolves a path link against its cwd, then opens the workspace, the file, or explains', () => {
  assert.match(markdown, /import \{ openWorkspacePathLink \} from '\.\.\/lib\/workspace-path-links'/)
  assert.match(chatScreen, /DeviceEventEmitter\.addListener\(OPEN_WORKSPACE_PATH_EVENT, \(request: OpenWorkspacePathRequest\) => \{\n\s+if \(request\.sessionId !== sessionId\) return/)
  assert.match(chatScreen, /const target = workspacePathLinkTarget\(request\.href, useAppStore\.getState\(\)\.sessions\.find\(value => value\.id === sessionId\)\?\.cwd\)/)
  assert.match(chatScreen, /if \(target\.kind === 'workspace'\) openWorkspace\(sessionId, target\.path\)\n\s+else if \(target\.kind === 'absolute'\) openAbsoluteFile\(sessionId, target\.path\)\n\s+else Alert\.alert\('Cannot open this path', `[^`]*\$\{target\.path\}`\)/)
  assert.match(host, /openWorkspace: \(sessionId: string, initialPath\?: string\) => present\(\{ kind: 'workspace', sessionId, initialPath \}\)/)
  assert.match(host, /openAbsoluteFile: \(sessionId: string, path: string\) => present\(\{ kind: 'absolute', sessionId, path \}\)/)
  assert.match(host, /activeRequest\?\.kind === 'absolute' \? <AbsoluteFileViewerModal request=\{activeRequest\}/)
})
