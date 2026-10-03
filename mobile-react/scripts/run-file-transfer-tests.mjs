import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const directory = await mkdtemp(join(process.env.TMPDIR || resolve(projectRoot, '../..'), 'agentsdock-file-transfer-tests-'))
const outfile = join(directory, 'test.mjs')
const mocks = resolve(projectRoot, 'tests/file-transfer-mocks.tsx')
// Every icon the app imports, so a new icon in any bundled component cannot break this runner.
const icons = new Set()
for (const file of await readdir(resolve(projectRoot, 'src'), { recursive: true })) {
  if (!/\.[jt]sx?$/.test(file)) continue
  const source = await readFile(resolve(projectRoot, 'src', file), 'utf8')
  for (const [, names] of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'lucide-react-native'/g)) {
    for (const name of names.split(',').map(value => value.trim().split(/\s+as\s+/)[0])) if (name && !name.startsWith('type ')) icons.add(name)
  }
}
try {
  await build({
    absWorkingDir: projectRoot,
    entryPoints: ['tests/file-transfer-actions.test.tsx'],
    outfile, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(import.meta.url)});\nglobalThis.IS_REACT_ACT_ENVIRONMENT = true;\nglobalThis.requestAnimationFrame ??= callback => callback(Date.now());\nglobalThis.cancelAnimationFrame ??= () => {};` },
    plugins: [{
      name: 'file-transfer-native-boundary',
      setup(context) {
        context.onResolve({ filter: /^(?:react|react-test-renderer|zustand)(?:\/.*)?$/ }, args => ({ path: require.resolve(args.path), external: true }))
        context.onResolve({ filter: /.*/ }, args => {
          if (args.path === 'lucide-react-native') return { path: 'icons', namespace: 'transfer-test' }
          if (['react-native-keyboard-controller', 'react-native-safe-area-context', 'react-native-svg'].includes(args.path)) return { path: resolve(projectRoot, 'tests/component-mocks/native-wrappers.ts') }
          if (['react-native', 'expo-file-system', 'expo-file-system/legacy', 'expo-sharing', 'expo-image', 'expo-clipboard', 'expo-haptics', '@shopify/flash-list'].includes(args.path)) return { path: mocks }
          if (/(?:^|\/)store\/useAppStore(?:\.[jt]sx?)?$/.test(args.path)) return { path: resolve(projectRoot, 'tests/component-mocks/app-store.ts') }
          if (/\/(?:FilePreview|ArtifactVideoPlayer|VideoThumbnailLoader|TextPromptDialog)$/.test(args.path)) return { path: mocks }
          return undefined
        })
        context.onLoad({ filter: /.*/, namespace: 'transfer-test' }, () => ({ contents: [...icons].map(name => `export const ${name} = '${name}'`).join('\n') }))
      },
    }],
  })
  await import(pathToFileURL(outfile).href)
} finally {
  await rm(directory, { recursive: true, force: true })
}
