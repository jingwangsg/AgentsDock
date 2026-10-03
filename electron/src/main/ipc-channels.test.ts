import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// shared/ipc.ts only types the bridge; the channel strings are hand-written twice, once where
// main registers them and once where preload invokes them. This pins the two lists together.
const mainDir = dirname(fileURLToPath(import.meta.url))
const preloadDir = resolve(mainDir, '../preload')

function sources(dir: string): Array<{ file: string; text: string }> {
  return readdirSync(dir)
    .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map(name => ({ file: name, text: readFileSync(resolve(dir, name), 'utf8') }))
}

// First argument of each call, literal or not, so a channel built from a variable cannot slip past the comparison.
function firstArguments(text: string, callee: RegExp): string[] {
  return [...text.matchAll(new RegExp(`\\b${callee.source}\\(\\s*([^,)]+)`, 'g'))].map(match => match[1].trim())
}

function literals(args: string[]): string[] {
  return args.filter(arg => /^'[^']+'$/.test(arg)).map(arg => arg.slice(1, -1))
}

describe('IPC channel names', () => {
  const main = sources(mainDir)
  const preload = sources(preloadDir)
  const ipcSource = main.find(entry => entry.file === 'ipc.ts')!.text

  const mainInvokeArgs = [
    ...firstArguments(ipcSource, /(?<![.\w])handle(?:WithEvent)?/),
    ...main.flatMap(entry => firstArguments(entry.text, /ipcMain\.handle/))
  ]
  const mainSendArgs = main.flatMap(entry => firstArguments(entry.text, /ipcMain\.on/))
  const preloadInvokeArgs = preload.flatMap(entry => firstArguments(entry.text, /ipcRenderer\.invoke/))
  const preloadSendArgs = preload.flatMap(entry => firstArguments(entry.text, /ipcRenderer\.send/))

  it('are registered and invoked with string literals', () => {
    // ipc.ts has two wrapper layers (handle -> handleWithEvent -> ipcMain.handle) that forward a `channel`
    // parameter; every other call must name its channel inline.
    expect(mainInvokeArgs.filter(arg => !arg.startsWith("'"))).toEqual(['channel', 'channel'])
    expect(mainSendArgs.filter(arg => !arg.startsWith("'"))).toEqual([])
    expect(preloadInvokeArgs.filter(arg => !arg.startsWith("'"))).toEqual([])
    expect(preloadSendArgs.filter(arg => !arg.startsWith("'"))).toEqual([])
  })

  it('are registered once in main', () => {
    const registered = [...literals(mainInvokeArgs), ...literals(mainSendArgs)]
    expect(registered.filter((channel, index) => registered.indexOf(channel) !== index)).toEqual([])
  })

  it('match between main handlers and preload invoke calls', () => {
    expect([...new Set(literals(preloadInvokeArgs))].sort()).toEqual([...new Set(literals(mainInvokeArgs))].sort())
  })

  it('match between main listeners and preload send calls', () => {
    expect([...new Set(literals(preloadSendArgs))].sort()).toEqual([...new Set(literals(mainSendArgs))].sort())
  })
})
