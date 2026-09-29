import assert from 'node:assert/strict'

import { highlightCode } from './code-highlight'

const python = 'for r in scout:  # 2. sweep\n    checkpoints[70, r] = train_from_scratch("x", 30_000)\n'
const dark = highlightCode(python, 'python', 'dark')
assert(dark, 'a registered language should highlight')
assert.equal(dark.map(run => run.text).join(''), python, 'runs must reproduce the source exactly')
const colorOf = (runs: NonNullable<typeof dark>, text: string) => runs.find(run => run.text.includes(text))?.color
assert.equal(colorOf(dark, 'for'), '#ff7b72', 'keywords use the desktop github-dark color')
assert.equal(colorOf(dark, '# 2. sweep'), '#8b949e')
assert.equal(colorOf(dark, '"x"'), '#a5d6ff')
assert.equal(colorOf(dark, '30_000'), '#79c0ff')

const light = highlightCode(python, 'python', 'light')
assert(light)
assert.equal(colorOf(light, 'for'), '#cf222e', 'light mode uses the desktop light overrides')
assert.equal(colorOf(light, '"x"'), '#0a3069')
assert.equal(colorOf(light, '30_000'), '#79c0ff', 'scopes without a light override keep github-dark, as on the desktop')

assert(highlightCode('const a = 1', 'ts', 'dark'), 'language aliases resolve like rehype-highlight')
assert.equal(highlightCode(python, undefined, 'dark'), null, 'no language: plain text, no auto-detection')
assert.equal(highlightCode(python, 'not-a-language', 'dark'), null)
assert.equal(highlightCode('x = 1\n'.repeat(6_000), 'python', 'dark'), null, 'oversized fences stay plain')

console.log('code highlight regressions passed')
