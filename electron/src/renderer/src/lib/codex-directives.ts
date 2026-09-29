/**
 * Codex skills make the model write two directives that the Codex app renders
 * natively and every Markdown renderer here showed as raw text:
 *   :codex-file-citation{path="/abs/report.pdf" purpose="output" page_number="4"}
 *   - :codex-followup[Short action]{prompt="Complete request for that action"}
 * They become ordinary Markdown links before rendering: a citation links the
 * file (opened like any path link), a follow-up links CODEX_FOLLOWUP_SCHEME,
 * which puts its prompt into the composer. Code spans and fenced blocks stay
 * literal, so text that explains the syntax is left alone.
 * Mirrored in mobile-react/src/lib/codex-directives.ts.
 */
export const CODEX_FOLLOWUP_SCHEME = 'agentsdock-followup:'

const ATTRIBUTE = /([A-Za-z_][\w-]*)="((?:[^"\\]|\\.)*)"/g
const FENCE = /^ {0,3}(`{3,}|~{3,})/
// A code span (left as is) or a directive; the span alternative comes first so its contents are skipped.
const SPAN_OR_DIRECTIVE = /(`+)[^`]*?\1|:codex-(file-citation|followup)(?:\[([^\]\n]+)\])?\{([^{}\n]*)\}/g

function attributes(source: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const match of source.matchAll(ATTRIBUTE)) values[match[1]] = match[2].replace(/\\(.)/g, '$1')
  return values
}

const linkLabel = (text: string) => text.replace(/[\\[\]]/g, '\\$&')

function rewriteDirective(whole: string, kind: string, label: string | undefined, rawAttributes: string): string {
  const values = attributes(rawAttributes)
  if (kind === 'file-citation') {
    const path = values.path?.trim()
    // An angle-bracket destination allows spaces but not these.
    if (!path || /[<>\n]/.test(path)) return whole
    const name = path.split(/[\\/]/).pop() || path
    const locator = values.page_number ? `p. ${values.page_number}`
      : values.sheet ? (values.range ? `${values.sheet}!${values.range}` : values.sheet)
        : values.range ?? ''
    return `[${linkLabel(locator ? `${name} (${locator})` : name)}](<${path}>)`
  }
  const prompt = values.prompt?.trim()
  if (!label?.trim() || !prompt) return whole
  return `[${linkLabel(label.trim())}](${CODEX_FOLLOWUP_SCHEME}${encodeURIComponent(prompt)})`
}

export function rewriteCodexDirectives(markdown: string): string {
  if (!markdown.includes(':codex-')) return markdown
  let fence: string | null = null
  return markdown.split('\n').map(line => {
    const marker = FENCE.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null
      return line
    }
    if (marker) {
      fence = marker
      return line
    }
    return line.replace(SPAN_OR_DIRECTIVE, (whole, ticks, kind, label, rawAttributes) => ticks ? whole : rewriteDirective(whole, kind, label, rawAttributes))
  }).join('\n')
}

/** The prompt a follow-up link carries, or null for any other href. */
export function codexFollowupPrompt(href: string | undefined | null): string | null {
  if (!href?.startsWith(CODEX_FOLLOWUP_SCHEME)) return null
  try {
    return decodeURIComponent(href.slice(CODEX_FOLLOWUP_SCHEME.length)) || null
  } catch {
    return null
  }
}
