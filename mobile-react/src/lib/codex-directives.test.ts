import assert from 'node:assert/strict'

import { CODEX_FOLLOWUP_SCHEME, codexFollowupPrompt, rewriteCodexDirectives } from './codex-directives'

// Same cases as the desktop suite (electron/src/renderer/src/lib/codex-directives.test.ts).
assert.equal(
  rewriteCodexDirectives('See :codex-file-citation{path="/Users/me/o1/Jinwoo_Shin_Brief DRAFT.pdf" purpose="output"} now.'),
  'See [Jinwoo_Shin_Brief DRAFT.pdf](</Users/me/o1/Jinwoo_Shin_Brief DRAFT.pdf>) now.',
)
assert.equal(rewriteCodexDirectives(':codex-file-citation{path="/a/file.docx" purpose="source" page_number="4"}'), '[file.docx (p. 4)](</a/file.docx>)')
assert.equal(rewriteCodexDirectives(':codex-file-citation{path="/a/book.xlsx" sheet="Revenue Model" range="C27"}'), '[book.xlsx (Revenue Model!C27)](</a/book.xlsx>)')

const followup = rewriteCodexDirectives('- :codex-followup[Draft the email]{prompt="Write the email to \\"Jinwoo\\""}')
assert.equal(followup, `- [Draft the email](${CODEX_FOLLOWUP_SCHEME}${encodeURIComponent('Write the email to "Jinwoo"')})`)
assert.equal(codexFollowupPrompt(followup.slice(followup.indexOf('(') + 1, -1)), 'Write the email to "Jinwoo"')
assert.equal(codexFollowupPrompt('/Users/me/a.pdf'), null)

assert.equal(
  rewriteCodexDirectives('```md\n:codex-file-citation{path="/a/b.pdf"}\n```\nafter :codex-file-citation{path="/c.pdf"}'),
  '```md\n:codex-file-citation{path="/a/b.pdf"}\n```\nafter [c.pdf](</c.pdf>)',
)
assert.equal(rewriteCodexDirectives('use `:codex-file-citation{path="/a.pdf"}` inline'), 'use `:codex-file-citation{path="/a.pdf"}` inline')
assert.equal(rewriteCodexDirectives(':codex-file-citation{…} and :codex-followup{prompt="x"}'), ':codex-file-citation{…} and :codex-followup{prompt="x"}')

console.log('codex directive regressions passed')
