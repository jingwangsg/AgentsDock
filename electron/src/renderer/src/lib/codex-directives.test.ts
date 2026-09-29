import { describe, expect, it } from 'vitest'
import { CODEX_FOLLOWUP_SCHEME, codexFollowupPrompt, rewriteCodexDirectives } from './codex-directives'

describe('rewriteCodexDirectives', () => {
  it('links a file citation by its file name, with the page or cell it points at', () => {
    expect(rewriteCodexDirectives('See :codex-file-citation{path="/Users/me/o1/Jinwoo_Shin_Brief DRAFT.pdf" purpose="output"} now.'))
      .toBe('See [Jinwoo_Shin_Brief DRAFT.pdf](</Users/me/o1/Jinwoo_Shin_Brief DRAFT.pdf>) now.')
    expect(rewriteCodexDirectives(':codex-file-citation{path="/a/file.docx" purpose="source" artifact_kind="document" page_number="4"}'))
      .toBe('[file.docx (p. 4)](</a/file.docx>)')
    expect(rewriteCodexDirectives(':codex-file-citation{path="/a/book.xlsx" purpose="source" sheet="Revenue Model" range="C27"}'))
      .toBe('[book.xlsx (Revenue Model!C27)](</a/book.xlsx>)')
  })

  it('turns a follow-up into a link that carries its prompt', () => {
    const rewritten = rewriteCodexDirectives('- :codex-followup[Draft the email]{prompt="Write the email to \\"Jinwoo\\" in Chinese"}')
    expect(rewritten).toBe(`- [Draft the email](${CODEX_FOLLOWUP_SCHEME}${encodeURIComponent('Write the email to "Jinwoo" in Chinese')})`)
    expect(codexFollowupPrompt(rewritten.slice(rewritten.indexOf('(') + 1, -1))).toBe('Write the email to "Jinwoo" in Chinese')
    expect(codexFollowupPrompt('https://example.com')).toBeNull()
  })

  it('leaves code, placeholders and unrelated text alone', () => {
    const fenced = '```md\n:codex-file-citation{path="/a/b.pdf"}\n```\nafter :codex-file-citation{path="/c.pdf"}'
    expect(rewriteCodexDirectives(fenced)).toBe('```md\n:codex-file-citation{path="/a/b.pdf"}\n```\nafter [c.pdf](</c.pdf>)')
    expect(rewriteCodexDirectives('use `:codex-file-citation{path="/a.pdf"}` inline')).toBe('use `:codex-file-citation{path="/a.pdf"}` inline')
    expect(rewriteCodexDirectives(':codex-file-citation{…} and :codex-followup{prompt="x"}')).toBe(':codex-file-citation{…} and :codex-followup{prompt="x"}')
    expect(rewriteCodexDirectives('plain text')).toBe('plain text')
  })
})
