// Syntax colors for chat code fences. Same engine and language set as the
// desktop's rehype-highlight (lowlight + highlight.js "common"), flattened into
// styled runs for nested native Text.

// Every run becomes a native Text span laid out on the UI thread; past this
// size a fence renders as plain monospace text.
const HIGHLIGHT_SOURCE_LIMIT = 30_000

export interface CodeRun {
  text: string
  color?: string
  bold?: boolean
  italic?: boolean
}

interface HastNode {
  type: string
  value?: string
  properties?: { className?: string[] }
  children?: HastNode[]
}

interface Lowlight {
  registered(language: string): boolean
  highlight(language: string, value: string): { children: HastNode[] }
}

type TokenStyle = Omit<CodeRun, 'text'>

// highlight.js github-dark, which the desktop imports for chat Markdown.
const DARK: Record<string, TokenStyle> = {
  keyword: { color: '#ff7b72' }, doctag: { color: '#ff7b72' }, 'template-tag': { color: '#ff7b72' },
  'template-variable': { color: '#ff7b72' }, type: { color: '#ff7b72' }, 'variable.language_': { color: '#ff7b72' },
  title: { color: '#d2a8ff' },
  attr: { color: '#79c0ff' }, attribute: { color: '#79c0ff' }, literal: { color: '#79c0ff' }, meta: { color: '#79c0ff' },
  number: { color: '#79c0ff' }, operator: { color: '#79c0ff' }, variable: { color: '#79c0ff' },
  'selector-attr': { color: '#79c0ff' }, 'selector-class': { color: '#79c0ff' }, 'selector-id': { color: '#79c0ff' },
  regexp: { color: '#a5d6ff' }, string: { color: '#a5d6ff' },
  built_in: { color: '#ffa657' }, symbol: { color: '#ffa657' },
  comment: { color: '#8b949e' }, code: { color: '#8b949e' }, formula: { color: '#8b949e' },
  name: { color: '#7ee787' }, quote: { color: '#7ee787' }, 'selector-tag': { color: '#7ee787' }, 'selector-pseudo': { color: '#7ee787' },
  subst: { color: '#c9d1d9' },
  section: { color: '#1f6feb', bold: true },
  bullet: { color: '#f2cc60' },
  emphasis: { italic: true },
  strong: { bold: true },
  addition: { color: '#aff5b4' },
  deletion: { color: '#ffdcd7' },
}

// The desktop's light theme overrides only these scopes and keeps the rest of github-dark.
const LIGHT: Record<string, TokenStyle> = {
  ...DARK,
  comment: { color: '#6e7781' }, quote: { color: '#6e7781' },
  keyword: { color: '#cf222e' }, 'selector-tag': { color: '#cf222e' }, literal: { color: '#cf222e' },
  string: { color: '#0a3069' }, attr: { color: '#0a3069' },
  title: { color: '#8250df' }, function: { color: '#8250df' },
}

const runtimeGlobal = globalThis as typeof globalThis & { __agentsdockLowlight?: Lowlight | null }

/** Loaded on the first highlighted fence, like MathJax for the first formula. */
function getLowlight(): Lowlight | null {
  if (runtimeGlobal.__agentsdockLowlight !== undefined) return runtimeGlobal.__agentsdockLowlight
  try {
    const { common, createLowlight } = require('lowlight') as typeof import('lowlight')
    runtimeGlobal.__agentsdockLowlight = createLowlight(common) as unknown as Lowlight
  } catch {
    runtimeGlobal.__agentsdockLowlight = null
  }
  return runtimeGlobal.__agentsdockLowlight
}

/**
 * Colored runs for a fenced block, or null to render it as plain text: no or
 * unknown language (the desktop does not auto-detect either), oversized
 * source, or a highlighter failure.
 */
export function highlightCode(code: string, language: string | undefined, scheme: 'light' | 'dark'): CodeRun[] | null {
  if (!language || !code || code.length > HIGHLIGHT_SOURCE_LIMIT) return null
  const lowlight = getLowlight()
  if (!lowlight?.registered(language)) return null
  let children: HastNode[]
  try {
    children = lowlight.highlight(language, code).children
  } catch {
    return null
  }

  const theme = scheme === 'light' ? LIGHT : DARK
  const runs: CodeRun[] = []
  const visit = (nodes: HastNode[], inherited: TokenStyle) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const text = node.value ?? ''
        const previous = runs[runs.length - 1]
        if (previous && previous.color === inherited.color && previous.bold === inherited.bold && previous.italic === inherited.italic) previous.text += text
        else runs.push({ text, ...inherited })
        continue
      }
      if (node.type !== 'element') continue
      // highlight.js 11 emits "hljs-<scope>" plus modifiers such as "function_" or "language_".
      const classes = node.properties?.className ?? []
      const scope = classes.find(name => name.startsWith('hljs-'))?.slice('hljs-'.length)
      const modifier = classes.find(name => name.endsWith('_'))
      const style = scope ? theme[modifier ? `${scope}.${modifier}` : scope] ?? theme[scope] : undefined
      visit(node.children ?? [], style ? { ...inherited, ...style } : inherited)
    }
  }
  visit(children, {})
  return runs
}
