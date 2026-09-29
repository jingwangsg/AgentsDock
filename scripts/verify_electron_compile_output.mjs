#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MIN_ELECTRON_MAIN_ENTRY_BYTES = 1024

function containedPath(root, candidate) {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot !== '' && pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot)
}

export function verifyElectronCompileOutput(projectDirectory, options = {}) {
  const minimumBytes = options.minimumBytes ?? MIN_ELECTRON_MAIN_ENTRY_BYTES
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes < 1) {
    throw new Error('Electron compile output minimum must be a positive integer.')
  }

  const projectRoot = realpathSync(resolve(projectDirectory))
  const packagePath = resolve(projectRoot, 'package.json')
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
  const mainEntry = packageJson?.main
  if (typeof mainEntry !== 'string' || mainEntry.trim() === '' || isAbsolute(mainEntry)) {
    throw new Error('electron/package.json must declare a relative main entry.')
  }

  const declaredMainPath = resolve(projectRoot, mainEntry)
  if (!containedPath(projectRoot, declaredMainPath)) {
    throw new Error(`Electron main entry escapes its project directory: ${mainEntry}`)
  }

  const entryStat = lstatSync(declaredMainPath)
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
    throw new Error(`Electron main entry is not a regular file: ${mainEntry}`)
  }

  const realMainPath = realpathSync(declaredMainPath)
  if (!containedPath(projectRoot, realMainPath)) {
    throw new Error(`Electron main entry resolves outside its project directory: ${mainEntry}`)
  }
  if (entryStat.size < minimumBytes) {
    throw new Error(
      `Electron main entry ${mainEntry} is too small: ${entryStat.size} bytes ` +
      `(expected at least ${minimumBytes}).`
    )
  }

  return { mainPath: realMainPath, size: entryStat.size }
}

// Monaco's diff gutter markers are codicon glyphs. An entry point that skips
// codicon.css still ships the classes, and every glyph renders as a tofu box.
export function verifyMonacoCodiconFont(projectDirectory) {
  const assets = resolve(realpathSync(resolve(projectDirectory)), 'out', 'renderer', 'assets')
  for (const name of readdirSync(assets).filter(file => file.endsWith('.css'))) {
    const source = /@font-face\{[^}]*font-family:"?codicon"?[;"][^}]*url\(([^)]+)\)/.exec(readFileSync(resolve(assets, name), 'utf8'))?.[1]
    if (!source) continue
    const font = source.replace(/^["']|["']$/g, '').replace(/[?#].*$/, '')
    if (font.startsWith('data:') || existsSync(resolve(assets, font))) return { stylesheet: name, font: font.slice(0, 80) }
    throw new Error(`Monaco codicon font ${font} referenced by ${name} is missing from out/renderer/assets.`)
  }
  throw new Error('No built stylesheet declares the Monaco codicon font; the Changes diff would render its +/- markers as boxes.')
}

const scriptPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (scriptPath === import.meta.url) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const projectDirectory = process.argv[2] ? resolve(process.argv[2]) : resolve(repositoryRoot, 'electron')
  try {
    const result = verifyElectronCompileOutput(projectDirectory)
    console.log(`Verified Electron main entry: ${result.mainPath} (${result.size} bytes)`)
    const codicon = verifyMonacoCodiconFont(projectDirectory)
    console.log(`Verified Monaco codicon font: ${codicon.font} (from ${codicon.stylesheet})`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
